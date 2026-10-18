/** Durable supervision; never clears paid reservations or changes generated source. */
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {materializeChapter} from './prepare.mjs';
import {hash} from './core.mjs';
import {prepareConcurrently} from './preparation-lanes.mjs';
const here=dirname(fileURLToPath(import.meta.url));
export function recoveryAction(status) {
 if(status.status==='complete')return 'complete';
 if(status.status==='complete-with-review-backlog')return 'review';
 const reason=status.reason??'';
 if(/HTTP (?:400|401|402|403)|ambiguous|uncertain.*submi|submission.*uncertain|credit|quota|access error|spending ceiling|budget|previously failed operation|retry limit|source.*changed|checksum mismatch|queue operational settings|prepared chapter.*(?:changed|deleted)|selected chapter order|preparation completion/i.test(reason))return 'attention';
 return 'retry';
}
const read=async(path,fallback)=>{try{return JSON.parse(await fs.readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
async function save(path,value){await fs.mkdir(dirname(path),{recursive:true});const temporary=path+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(temporary,path);}
/** Serialize the whole snapshot while merging stage-local health independently. */
export function createSupervisorStatusWriter(initial,persist) {
 let prior=initial,tail=Promise.resolve();
 return value=>{
  const task=tail.then(async()=>{
   const updatedAt=new Date().toISOString(),lanes={...prior.lanes};
   for(const [stage,update]of Object.entries(value.lanes??{}))lanes[stage]={...lanes[stage],...update,updatedAt};
   const next={...prior,...value,lanes,pid:process.pid,updatedAt};
   await persist(next);prior=next;return next;
  });
  tail=task.catch(()=>{});return task;
 };
}
export async function supervise(path) {
 process.umask(0o077);
 const config=await read(path),root=config.root;
 if(!Array.isArray(config.chapterIds)||!config.chapterIds.length||new Set(config.chapterIds).size!==config.chapterIds.length)throw Error('Unique ordered chapters required');
 if(!config.originalVoices?.narrator?.voiceId||!config.narratorPolicy?.gender)throw Error('Reviewed narrator policy required');
 const statusPath=join(root,'supervisor-status.json'),lockPath=join(root,'supervisor.lock');
 await fs.mkdir(root,{recursive:true});
 let prior=await read(statusPath,{});
 try {const pid=Number(await fs.readFile(lockPath,'utf8'));process.kill(pid,0);throw Error('Supervisor already active');}
 catch(error){if(!['ENOENT','ESRCH'].includes(error.code))throw error;}
 await fs.writeFile(lockPath,String(process.pid),{flag:'w',mode:0o600});
 const children=new Map(),stopping=new AbortController(),preparationStopping=new AbortController();let interrupted=false,pauseRequested=false,pauseMonitor;
 const status=createSupervisorStatusWriter(prior,async next=>{await save(statusPath,next);prior=next;});
 const terminatePreparation=()=>{for(const [pid,lane]of children)if(lane!=='render')try{process.kill(-pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}};
 const pausedPreparation=()=>Object.assign(Error('Preparation paused; checkpoints retained'),{code:'PREPARATION_PAUSED'});
 const stop=()=>{interrupted=true;stopping.abort();preparationStopping.abort();void save(join(root,'pause.requested'),{at:new Date().toISOString()});terminatePreparation();};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 const checkPause=async()=>{
  if(pauseRequested||stopping.signal.aborted)return;
  try{await fs.access(join(root,'pause.requested'));}catch(error){if(error.code==='ENOENT')return;throw error;}
  pauseRequested=true;preparationStopping.abort();terminatePreparation();
  await status({status:'pausing',stage:'waiting-for-render-pause',reason:null,nextAttemptAt:null});
 };
 const heartbeat=setInterval(()=>{void status({childPid:children.keys().next().value??null,children:[...children].map(([pid,lane])=>({pid,lane}))}).catch(()=>{});},15000);
 const command=async(args,lane='prepare')=>new Promise((done,fail)=>{
  if(stopping.signal.aborted||lane!=='render'&&preparationStopping.signal.aborted){fail(pauseRequested&&!interrupted?pausedPreparation():Error('Supervision stopped'));return;}
  const child=spawn(process.execPath,args,{env:process.env,stdio:['ignore','pipe','pipe'],detached:true});children.set(child.pid,lane);let error='';
  const output=fs.open(join(root,'supervisor.log'),'a');
  child.stdout.on('data',data=>{void output.then(f=>f.write(data));});
  child.stderr.on('data',data=>{error=(error+data).slice(-1500);void output.then(f=>f.write(data));});
  child.once('error',fail);child.once('close',code=>{children.delete(child.pid);void output.then(f=>f.close());if(lane!=='render'&&pauseRequested&&!interrupted){fail(pausedPreparation());return;}code===0?done():fail(Error('Child exited '+code+': '+error));});
 });
 const retry=async(stage,work,lane='prepare')=>{
  const signal=lane==='render'?stopping.signal:preparationStopping.signal;
  for(let attempt=0;;attempt++){
   try{if(signal.aborted||stopping.signal.aborted)throw pauseRequested&&!interrupted&&lane!=='render'?pausedPreparation():Error('Supervision stopped');await status({status:'running',stage,attempt:attempt+1,reason:null,nextAttemptAt:null,[lane+'Stage']:stage,lanes:{[stage]:{status:'running',attempt:attempt+1,reason:null,nextAttemptAt:null}}});const result=await work();await status({lanes:{[stage]:{status:signal.aborted?'interrupted':'complete',attempt:attempt+1,reason:signal.aborted?'Supervision stopped':null,nextAttemptAt:null}}});return result;}
   catch(error){
    if(error.code==='PREPARATION_PAUSED'){await status({lanes:{[stage]:{status:'paused',attempt:attempt+1,reason:null,nextAttemptAt:null}}});throw error;}
    if(signal.aborted||stopping.signal.aborted){await status({lanes:{[stage]:{status:'interrupted',attempt:attempt+1,reason:String(error.message),nextAttemptAt:null}}});throw error;}
    const reason=String(error.message);
    if(attempt>=(config.maxRecoveryAttempts??8)-1||recoveryAction({reason})==='attention'){await status({lanes:{[stage]:{status:'needs-attention',attempt:attempt+1,reason,nextAttemptAt:null}}});throw error;}
    const seconds=Math.min(config.maxRetrySeconds??1800,(config.retrySeconds??30)*2**attempt);
    const nextAttemptAt=new Date(Date.now()+seconds*1000).toISOString();
    await status({status:'recovering',stage,attempt:attempt+1,reason,nextAttemptAt,lanes:{[stage]:{status:'recovering',attempt:attempt+1,reason,nextAttemptAt}}});
    try{await wait(seconds*1000,undefined,{signal});}
    catch(error){const paused=pauseRequested&&!interrupted&&lane!=='render';await status({lanes:{[stage]:{status:paused?'paused':'interrupted',attempt:attempt+1,reason:paused?null:String(error.message),nextAttemptAt:null}}});throw paused?pausedPreparation():error;}
   }
  }
 };
 try {
  // Explicit attention stops are durable. A monitoring agent reconciles evidence before resuming.
  if(['needs-attention','review-backlog'].includes(prior.status)){
   try{await fs.access(join(root,'resume.requested'));}catch(error){if(error.code==='ENOENT')return;throw error;}
  }
  if(prior.status==='complete')return;
  let resumed=false;try{await fs.unlink(join(root,'resume.requested'));resumed=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(resumed)await fs.rm(join(root,'pause.requested'),{force:true});
  else try{await fs.access(join(root,'pause.requested'));await status({status:'paused'});return;}catch(error){if(error.code!=='ENOENT')throw error;}
  const dependency=hash({chapterIds:config.chapterIds,voices:config.originalVoices,narrator:config.narratorPolicy});
  if(prior.dependency&&prior.dependency!==dependency)throw Error('Supervised inputs changed');
  await status({dependency});
  if(config.plannerConfig){
   const planner=await read(config.plannerConfig);
   if(planner.chapterIds&&hash(planner.chapterIds)!==hash(config.chapterIds))throw Error('Selected chapter order changed in planner');
   if(!planner.chapterIds)await save(config.plannerConfig,{...planner,chapterIds:config.chapterIds});
  }
  if(config.priorQueue){
   const planner=await read(config.plannerConfig),index=await read(join(planner.state,'index.json'));
   const firstSequence=Math.min(...config.chapterIds.map(id=>index.chapters.find(c=>c.id===id)?.sequence??NaN));
   if(!Number.isInteger(firstSequence))throw Error('Selected chapter missing from source index');
   const {seedHistoricalCast}=await import(pathToFileURL(join(dirname(config.planner),'inworld-history.js')).href);
   await seedHistoricalCast(config.priorQueue,planner.state,firstSequence);
  }
  let queue=await read(join(root,'queue.json'),null);
  if(!queue){
   const voices=await read(join(root,'voices.json'),config.originalVoices);
   for(const [role,voice]of Object.entries(config.originalVoices))if(voices[role]?.voiceId!==voice.voiceId)throw Error('Original voice changed: '+role);
   await save(join(root,'voices.json'),voices);
   await save(join(root,'voice-profiles.json'),await read(join(root,'voice-profiles.json'),{}));
   queue={...config,selectedChapterIds:config.chapterIds,preparationComplete:false,chapters:[],estimate:{submittedCharacters:0,speechUSD:0}};
  }
  // Runtime upgrades may update executable paths, never queue entries or billing inputs.
  for(const field of ['sourceCommit','sourceRepository','sourceRoot','planner','analysisModule'])if(config[field]!==undefined)queue[field]=config[field];
  await save(join(root,'queue.json'),queue);
  let appendTail=Promise.resolve();
  const appendReady=()=>{
   const task=appendTail.then(async()=>{
    const profiles=await read(join(root,'voice-profiles.json'),{});let changed=false;
    while(queue.chapters.length<config.chapterIds.length){
     const id=config.chapterIds[queue.chapters.length],planRoot=join(config.plans,'plans',id);
     if(!await read(join(planRoot,'plan.json'),null))break;
     const prepared=await materializeChapter(planRoot,config);
     if(prepared.entry.chapterId!==id)throw Error('Prepared chapter identity changed');
     for(const profile of prepared.profiles){if(profiles[profile.id])continue;
      const gender=profile.tags.includes('female')?'female':profile.tags.includes('male')?'male':'androgynous';
      profiles[profile.id]={role:profile.id,gender,tags:profile.tags,evidence:profile.evidence,designPrompt:`A distinct ${gender} English audiobook character voice. ${profile.portrayal}. ${profile.tags.join(', ')}. Consistent natural identity, clear close-mic studio recording.`,previewText:'We have time to consider what happens next. Tell me what you found, and we will work through it together.'};
     }
     queue.chapters.push(prepared.entry);changed=true;
    }
    if(changed){
     queue.estimate={submittedCharacters:0,speechUSD:0};
     for(const entry of queue.chapters){const chapter=await read(join(entry.root,'input.json'));queue.estimate.submittedCharacters+=chapter.items.reduce((n,i)=>n+i.request.text.length,0);}
     queue.estimate.speechUSD=queue.estimate.submittedCharacters*(queue.usdPerMillion??20)/1e6;
     if(queue.estimate.speechUSD>queue.ceilingUSD)throw Error('Prepared speech exceeds budget ceiling');
     await save(join(root,'voice-profiles.json'),profiles);await save(join(root,'queue.json'),queue);
    }
    await status({prepared:queue.chapters.length,total:config.chapterIds.length});
   });appendTail=task.catch(()=>{});return task;
  };
  if(queue.selectedChapterIds)await appendReady();
  await checkPause();pauseMonitor=setInterval(()=>{void checkPause().catch(error=>{void status({status:'needs-attention',reason:'Pause marker unavailable: '+error.code});});},1000);
  const preparation=async()=>{
   if(!queue.selectedChapterIds||queue.preparationComplete)return;
   await prepareConcurrently(config.chapterIds,{
    attribute:async id=>{
     if(await read(join(config.plans,'plans',id,'plan.json'),null))return;
     await retry('attribute-'+id,()=>command([config.planner,config.plannerConfig,id,'attribute'],'attribute'),'attribute');
    },
    direct:async id=>{
     if(await read(join(config.plans,'plans',id,'plan.json'),null))return;
     await retry('directions-'+id,()=>command([config.planner,config.plannerConfig,id,'directions'],'directions'),'directions');
    },ready:appendReady,
   },config.directionConcurrency??2);
   if(preparationStopping.signal.aborted)throw pauseRequested&&!interrupted?pausedPreparation():Error('Supervision stopped');
   if(queue.chapters.length!==config.chapterIds.length)throw Error('Selected preparation incomplete');
   queue.preparationComplete=true;await save(join(root,'queue.json'),queue);
  };
  const rendering=()=>retry('render-review-publish',async()=>{
   let failed;try{await command([join(here,'runner.mjs'),join(root,'queue.json')],'render');}catch(error){failed=error;}
   const state=await read(join(root,'status.json'),{}),action=recoveryAction(state);
   if(action==='complete')return;
   if(action==='review'){await status({status:'review-backlog',pending:state.pending});return;}
   if(state.status==='paused')return;
   if(action==='attention'){await status({status:'needs-attention',reason:state.reason});throw Error(state.reason);}
   throw failed??Error(state.reason??'Runner did not complete');
  },'render');
  let failure;
  const tasks=[preparation(),rendering()].map(task=>task.catch(async error=>{
   if(error.code==='PREPARATION_PAUSED')return;
   failure??=error;stopping.abort();preparationStopping.abort();terminatePreparation();await save(join(root,'pause.requested'),{at:new Date().toISOString(),reason:'A supervised lane requires attention'});
  }));
  await Promise.all(tasks);if(failure)throw failure;
  const state=await read(join(root,'status.json'));
  if(recoveryAction(state)==='review'){await status({status:'review-backlog',pending:state.pending});return;}
  if(state.status==='paused'){await status({status:interrupted?'interrupted':'paused'});return;}
  if(state.status!=='complete')throw Error(state.reason??'Runner incomplete');
  await status({status:'complete',stage:'verified-publication',chapters:queue.chapters.length,reason:null});
 }catch(error){await status({status:interrupted?'interrupted':'needs-attention',reason:String(error.message)});}
 finally{clearInterval(heartbeat);clearInterval(pauseMonitor);process.off('SIGTERM',stop);process.off('SIGINT',stop);await fs.unlink(lockPath);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv[2])throw Error('Usage: supervisor.mjs CONFIG.json');await supervise(resolve(process.argv[2]));
}
