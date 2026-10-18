/** Durable supervision; never clears paid reservations or changes generated source. */
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setTimeout as wait} from 'node:timers/promises';
import {spawn} from 'node:child_process';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {materializeChapter} from './prepare.mjs';
import {hash} from './core.mjs';
const here=dirname(fileURLToPath(import.meta.url));
export function recoveryAction(status) {
 if(status.status==='complete')return 'complete';
 if(status.status==='complete-with-review-backlog')return 'review';
 const reason=status.reason??'';
 if(/HTTP (?:401|402|403)|ambiguous|uncertain.*submi|submission.*uncertain|credit|quota|access error|spending ceiling|budget|previously failed operation|retry limit|source.*changed|checksum mismatch/i.test(reason))return 'attention';
 return 'retry';
}
const read=async(path,fallback)=>{try{return JSON.parse(await fs.readFile(path,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}};
async function save(path,value){await fs.mkdir(dirname(path),{recursive:true});const temporary=path+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify(value,null,2)+'\n',{mode:0o600});await fs.rename(temporary,path);}
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
 let child;const stopping=new AbortController();
 const status=async value=>{prior={...prior,...value,pid:process.pid,updatedAt:new Date().toISOString()};await save(statusPath,prior);};
 const stop=()=>{stopping.abort();child?.kill('SIGTERM');};process.on('SIGTERM',stop);process.on('SIGINT',stop);
 const heartbeat=setInterval(()=>{void status({childPid:child?.pid??null}).catch(()=>{});},15000);
 const command=async args=>new Promise((done,fail)=>{
  child=spawn(process.execPath,args,{env:process.env,stdio:['ignore','pipe','pipe']});let error='';
  const output=fs.open(join(root,'supervisor.log'),'a');
  child.stdout.on('data',data=>{void output.then(f=>f.write(data));});
  child.stderr.on('data',data=>{error=(error+data).slice(-1500);void output.then(f=>f.write(data));});
  child.once('error',fail);child.once('close',code=>{child=undefined;void output.then(f=>f.close());code===0?done():fail(Error('Child exited '+code+': '+error));});
 });
 const retry=async(stage,work)=>{
  for(let attempt=0;;attempt++){
   try{await status({status:'running',stage,attempt:attempt+1,reason:null});return await work();}
   catch(error){
    if(stopping.signal.aborted)throw error;
    const reason=String(error.message);
    if(attempt>=(config.maxRecoveryAttempts??8)-1||recoveryAction({reason})==='attention')throw error;
    const seconds=Math.min(config.maxRetrySeconds??1800,(config.retrySeconds??30)*2**attempt);
    await status({status:'recovering',stage,attempt:attempt+1,reason,nextAttemptAt:new Date(Date.now()+seconds*1000).toISOString()});
    await wait(seconds*1000,undefined,{signal:stopping.signal});
   }
  }
 };
 try {
  // Explicit attention stops are durable. A monitoring agent reconciles evidence before resuming.
  if(['needs-attention','review-backlog'].includes(prior.status)){
   try{await fs.unlink(join(root,'resume.requested'));}catch(error){if(error.code==='ENOENT')return;throw error;}
  }
  if(prior.status==='complete')return;
  const dependency=hash({chapterIds:config.chapterIds,voices:config.originalVoices,narrator:config.narratorPolicy});
  if(prior.dependency&&prior.dependency!==dependency)throw Error('Supervised inputs changed');
  await status({dependency});
  let queue=await read(join(root,'queue.json'),null);
  if(!queue){
   const profiles={},chapters=[];
   for(const chapterId of config.chapterIds){
    await retry('prepare-'+chapterId,()=>command([config.planner,config.plannerConfig,chapterId]));
    const prepared=await materializeChapter(join(config.plans,'plans',chapterId),config);
    for(const profile of prepared.profiles){if(profiles[profile.id])continue;
     const gender=profile.tags.includes('female')?'female':profile.tags.includes('male')?'male':'androgynous';
     profiles[profile.id]={role:profile.id,gender,tags:profile.tags,evidence:profile.evidence,designPrompt:`A distinct ${gender} English audiobook character voice. ${profile.portrayal}. ${profile.tags.join(', ')}. Consistent natural identity, clear close-mic studio recording.`,previewText:'We have time to consider what happens next. Tell me what you found, and we will work through it together.'};
    }
    chapters.push(prepared.entry);await status({prepared:chapters.length,total:config.chapterIds.length});
   }
   queue={...config,chapters,estimate:{submittedCharacters:0,speechUSD:0}};
   for(const entry of chapters){const c=await read(join(entry.root,'input.json'));queue.estimate.submittedCharacters+=c.items.reduce((n,i)=>n+i.request.text.length,0);}
   queue.estimate.speechUSD=queue.estimate.submittedCharacters*(queue.usdPerMillion??20)/1e6;
   if(queue.estimate.speechUSD>queue.ceilingUSD)throw Error('Prepared speech exceeds budget ceiling');
   await save(join(root,'voices.json'),config.originalVoices);await save(join(root,'voice-profiles.json'),profiles);await save(join(root,'queue.json'),queue);
  }
  await retry('render-review-publish',async()=>{
   let failed;try{await command([join(here,'runner.mjs'),join(root,'queue.json')]);}catch(error){failed=error;}
   const state=await read(join(root,'status.json'),{}),action=recoveryAction(state);
   if(action==='complete')return;
   if(action==='review'){await status({status:'review-backlog',pending:state.pending});return;}
   if(action==='attention'){await status({status:'needs-attention',reason:state.reason});throw Error(state.reason);}
   throw failed??Error(state.reason??'Runner did not complete');
  });
  if(prior.status==='review-backlog')return;
  const state=await read(join(root,'status.json'));
  if(state.status!=='complete')throw Error(state.reason??'Runner incomplete');
  await status({status:'complete',stage:'verified-publication',chapters:queue.chapters.length,reason:null});
 }catch(error){await status({status:stopping.signal.aborted?'interrupted':'needs-attention',reason:String(error.message)});}
 finally{clearInterval(heartbeat);process.off('SIGTERM',stop);process.off('SIGINT',stop);await fs.unlink(lockPath);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv[2])throw Error('Usage: supervisor.mjs CONFIG.json');await supervise(resolve(process.argv[2]));
}
