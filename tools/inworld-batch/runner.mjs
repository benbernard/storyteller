import fs from 'node:fs/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import {ProcessingLane} from './pipeline.mjs';
import {spawn} from 'node:child_process';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {sha, hash, pack, checkResults, assertBudget, validateCoverage} from './core.mjs';
import {effectiveReview, processingOnlyEntry} from './owner-review.mjs';
import {PaidLane,belongsToEntry,evidenceRow,modelReview,needsModelReview,reviewInstructions,reviewSchema,validateReview} from './adjudication.mjs';
import {repairPassage,recoverRepairs} from './repair.mjs';
import {validateQueueUpdate,queuePreparationComplete,archiveExcludes} from './queue.mjs';
import {voiceDesignPrompt} from './voice-design.mjs';
import {batchWindowSize,explicitProviderRejection,classifyBatchResponse,providerBlockingCodes,runBatchWindow,reconcileBatchJobs} from './batch-window.mjs';
import {recoverVisualRedactionPassage} from './rendering-recovery.mjs';
import {renderingContext} from './rendering-review.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const config=JSON.parse(await fs.readFile(process.argv[2],'utf8')), root=config.root;
const processOnly=process.argv[3]==='--process-only'?process.argv[4]:null;
const renderingOnly=process.argv[3]==='--recover-rendering'?process.argv[4]:null,renderingIds=renderingOnly?process.argv.slice(5):[];
batchWindowSize(config.maxInFlightBatches); // Reject invalid limits before any paid voice previews.
if(process.argv.length>3&&!(processOnly&&process.argv.length===5)&&!(renderingOnly&&renderingIds.length&&new Set(renderingIds).size===renderingIds.length))throw Error('Usage: runner.mjs QUEUE [--process-only CHAPTER_ID | --recover-rendering CHAPTER_ID PASSAGE_ID ...]');
const reviewEntry=processOnly?config.chapters.find(c=>c.chapterId===processOnly):null;
if(processOnly&&!reviewEntry)throw Error('Unknown chapter');
process.umask(0o077);
const read=async(p,fallback)=>{try{return JSON.parse(await fs.readFile(p,'utf8'));}catch(e){if(e.code==='ENOENT'&&fallback!==undefined)return fallback;throw e;}};
const exists=async p=>{try{await fs.access(p);return true;}catch{return false;}};
async function save(p,v){await fs.mkdir(dirname(p),{recursive:true});const t=p+'.'+randomUUID()+'.tmp';await fs.writeFile(t,JSON.stringify(v,null,2)+'\n');await fs.rename(t,p);}
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function run(command,args,options={}){return new Promise((resolve,reject)=>{
 const child=spawn(command,args,{cwd:options.cwd,env:{...process.env,VECLIB_MAXIMUM_THREADS:'2'},stdio:['pipe','pipe','pipe']});let out='',err='';
 child.stdout.on('data',d=>{out+=d;if(out.length>100e6)child.kill();});child.stderr.on('data',d=>{err=(err+d).slice(-4000);});
 const timer=setTimeout(()=>child.kill(),options.timeout??300000);
 child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('close',code=>{clearTimeout(timer);if(code!==0)reject(Error(`${command} exited ${code}: ${err.slice(-1000)}`));else resolve(out);});
 child.stdin.on('error',()=>{});child.stdin.end(options.input);
 });}
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const gateway=await fs.readFile(join(here,'gateway.py'),'utf8');
async function api(path,body,method='POST'){
 if(processOnly)throw Error('Processing-only mode cannot call the provider');
 const command='set -a; . '+quote(config.credentialFile??'/run/secrets/inworld.env')+'; set +a; python3 -c '+quote(gateway);
 return JSON.parse(await run('ssh',[config.host,command],{input:JSON.stringify({path,method,...(body===undefined?{}:{body})}),timeout:210000}));
}
let current={status:'starting'};
const laneContext=new AsyncLocalStorage(), processing=new ProcessingLane(), paid=new PaidLane();
async function status(value){if(renderingOnly){current={...current,...value,updatedAt:new Date().toISOString(),pid:process.pid};await save(join(root,'rendering-recovery-status.json'),current);return;}if(processOnly){current={...current,...value,updatedAt:new Date().toISOString(),pid:process.pid};await save(join(reviewEntry.root,'owner-processing-status.json'),current);return;}if(laneContext.getStore()){const prior=await read(join(root,'processing-status.json'),{});await save(join(root,'processing-status.json'),{...prior,...value,updatedAt:new Date().toISOString(),pid:process.pid});return;}current={...current,...value,updatedAt:new Date().toISOString(),pid:process.pid};await save(join(root,'status.json'),current);console.log(JSON.stringify(current));}
let archiveTail=Promise.resolve();
async function archive(){const from=processOnly?reviewEntry.root:root,to=processOnly?config.archive+'/chapters/'+reviewEntry.sequence:config.archive;const task=archiveTail.catch(()=>{}).then(()=>run('rsync',['-a','--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=',...archiveExcludes.map(pattern=>'--exclude='+pattern),from+'/',config.host+':'+to+'/'],{timeout:600000}));archiveTail=task;await task;}
async function download(url,file){
 const u=new URL(url);if(u.protocol!=='https:')throw Error('Unexpected result URL');
 const response=await fetch(u,{signal:AbortSignal.timeout(180000)});if(!response.ok)throw Error('Result download failed '+response.status);
 const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length<50)throw Error('Empty result');await fs.mkdir(dirname(file),{recursive:true});const temp=file+'.tmp';await fs.writeFile(temp,bytes);await fs.rename(temp,file);return bytes;
}
async function voicesFor(chapter){
 await reconcileKnownBatches();
 let voices=await read(join(root,'voices.json'));
 for(const [role,voice]of Object.entries(config.originalVoices))if(voices[role]?.voiceId!==voice.voiceId)throw Error('Original voice changed: '+role);
 const profiles=await read(join(root,'voice-profiles.json'));
 for(const role of new Set(chapter.items.map(i=>i.role))){
  if(voices[role])continue;
  await status({stage:'designing-new-character',role});
  const dir=join(root,'voice-designs',role);await fs.mkdir(dir,{recursive:true});
  const receipt=join(dir,'design.json');let draft=await read(receipt,null);
  if(draft?.phase==='submitting')throw Error('Uncertain voice design submission requires inspection');
  if(draft?.phase==='rejected'&&!explicitProviderRejection(draft.response))throw Error('Uncertain historical voice design rejection; submission requires inspection');
  if(!draft||draft.phase==='rejected'){
   const profile=profiles[role];
   const designPrompt=voiceDesignPrompt(profile?.designPrompt);
   await save(receipt,{phase:'submitting',at:new Date().toISOString(),designPrompt,profile});
   const result=await api('/voices/v1/voices:design',{designPrompt,languageCode:'en-US',previewText:profile.previewText,voiceDesignConfig:{numberOfSamples:1}});
   const rejected=explicitProviderRejection(result);
   await save(receipt,{phase:rejected?'rejected':'submitting',response:result,designPrompt,profile});
   if(!(result.status>=200&&result.status<300))throw Error(rejected?'Voice design rejected HTTP '+result.status:'Uncertain voice design response HTTP '+result.status+'; submission preserved');
   const v=result.body.previewVoices?.[0];if(!v?.voiceId||!v.previewAudio)throw Error('Incomplete voice design');
   await fs.writeFile(join(dir,'preview.wav'),Buffer.from(v.previewAudio,'base64'));delete v.previewAudio;
   draft={phase:'designed',voice:v,profile,designPrompt};await save(receipt,draft);await sleep(31000);
  }
  // Publishing a designed voice is free. Preserve the stable draft ID before doing so.
  const description=voiceDesignPrompt(draft.designPrompt??draft.profile?.designPrompt??profiles[role]?.designPrompt);
  const displayName=voiceDesignPrompt(`${config.fiction} Inworld - ${role}`);
  const result=await api('/voices/v1/voices/'+encodeURIComponent(draft.voice.voiceId)+':publish',{displayName,description,tags:['storyteller','audiobook']});
  if(result.status>=300||!result.body.voiceId)throw Error('Voice publish rejected HTTP '+result.status);
  voices[role]={...result.body,profile:profiles[role],designedVoiceId:draft.voice.voiceId};await save(join(root,'voices.json'),voices);await archive();
 }
 return voices;
}
async function jobs(){return await read(join(root,'jobs.json'),[]);}
async function writeJob(job){const all=await jobs();const at=all.findIndex(j=>j.id===job.id);if(at<0)all.push(job);else all[at]=job;await save(join(root,'jobs.json'),all);}
async function poll(job){
 while(!job.operation.done){
  await status({stage:'waiting-for-batch',operation:job.operation.name,progress:job.operation.metadata??{}});
  let result;for(let n=0;n<4;n++){try{result=await api('/lro/v1alpha/'+job.operation.name,undefined,'GET');if(result.status<500)break;}catch(e){if(n===3)throw e;}await sleep(10000*(n+1));}
  if(!result||result.status>=300){const error=Error('Batch poll unavailable; operation retained');error.retryable=!result||result.status>=500;throw error;}
  job.operation=result.body;await writeJob(job);
  if(!job.operation.done)await sleep((config.pollSeconds??30)*1000);
 }
 if(job.operation.error){job.phase='failed';await writeJob(job);throw Error('Batch operation failed; inspect retained operation');}
}
async function finishJob(job,chapter){
 await poll(job);
 if(!job.results){const file=join(root,'jobs',job.id+'-results.json');await download(job.operation.response.resultsUri,file);job.results=await read(file);await writeJob(job);}
 const results=checkResults(job.items,job.results);
 for(const result of results){
  const item=job.items.find(i=>i.customId===result.customId), receipt=join(chapter.root,'receipts',item.customId+'.json');
  if(result.error)continue;
  const prior=await read(receipt,null);
  if(prior){if(prior.requestHash!==hash(item.request)||sha(await fs.readFile(join(chapter.root,'audio',item.customId+'.wav')))!==prior.sha256)throw Error('Cached audio mismatch');continue;}
  const file=join(chapter.root,'audio',item.customId+'.wav');
  const bytes=await download(result.audioUri,file);
  const metadata=JSON.parse(await run('ffprobe',['-v','error','-show_entries','format=duration:stream=sample_rate,channels','-of','json',file]));
  const duration=Number(metadata.format.duration);if(!(duration>0)||metadata.streams[0].channels!==1||metadata.streams[0].sample_rate!=='48000')throw Error('Invalid generated audio');
  await save(receipt,{sha256:sha(bytes),duration,requestHash:hash(item.request),voiceId:item.request.voiceId,job:job.id});
 }
 const codes=providerBlockingCodes(job);
 if(codes.length)job.terminalBlockingError={kind:'provider-credit-quota-access',codes,operation:job.operation.name};
 job.phase='complete';await writeJob(job);await archive();
 if(codes.length)throw Error('Batch item credit/quota/access error; saved completed items');
}
async function reconcileKnownBatches(){
 await reconcileBatchJobs(await jobs(),async job=>{
  const outputRoot=job.outputRoot??config.chapters.find(chapter=>chapter.chapterId===job.chapter)?.root;
  if(!outputRoot)throw Error('Batch operation output root requires inspection');
  await finishJob(job,{root:outputRoot});
 });
}
async function synthesize(entry,chapter,voices,pauseBetweenGroups=false,maxSubmissionsPerItem=null){
 const items=chapter.items.map(i=>({...i,request:{...i.request,voiceId:voices[i.role].voiceId}}));
 await reconcileKnownBatches();
 while(true){
  const missing=[];
  for(const item of items){const r=await read(join(entry.root,'receipts',item.customId+'.json'),null);if(!r)missing.push(item);else if(r.requestHash!==hash(item.request)||sha(await fs.readFile(join(entry.root,'audio',item.customId+'.wav')))!==r.sha256)throw Error('Saved speech no longer matches the request');}
  if(!missing.length)return true;
  // Finish and checkpoint accepted work before honoring an upgrade pause. Retakes
  // already queued in the processing lane can finish while generation is paused.
  if(pauseBetweenGroups&&await exists(join(root,'pause.requested')))return false;
  const groups=pack(missing,config.maxBatchCharacters).slice(0,batchWindowSize(config.maxInFlightBatches));
  const finished=await runBatchWindow(groups,{
   shouldPause:async()=>pauseBetweenGroups&&await exists(join(root,'pause.requested')),
   checkpoint:async()=>archive(),finish:async job=>finishJob(job,entry),
   submit:async group=>{
  const all=await jobs();
  for(const item of group)if(all.filter(j=>belongsToEntry(j,entry,config)&&(j.phase!=='rejected'||maxSubmissionsPerItem===1)&&j.items.some(i=>i.customId===item.customId)).length>=(maxSubmissionsPerItem??1+config.maxRetakes))throw Error('Passage retry limit reached');
  const characters=group.reduce((n,i)=>n+i.request.text.length,0);assertBudget(all,characters,config.ceilingUSD,config.usdPerMillion??20);
  const job={id:randomUUID(),chapter:entry.chapterId,outputRoot:entry.root,phase:'submitting',items:group.map(({customId,request})=>({customId,request})),characters,reservedUSD:characters*(config.usdPerMillion??20)/1e6,createdAt:new Date().toISOString()};
  await writeJob(job);await status({stage:'submitting-batch',items:group.length,characters,completedItems:items.length-missing.length,totalItems:items.length});
  const result=await api('/tts/v1/voice:synthesizeBatch',{items:job.items});
  const disposition=classifyBatchResponse(result);job.submissionResponse=result;
  if(disposition.state==='rejected'){job.phase='rejected';job.rejection=result;await writeJob(job);throw Error('Batch rejected HTTP '+result.status+'; no next chapter started');}
  if(disposition.state==='uncertain'){await writeJob(job);throw Error('Ambiguous batch response HTTP '+result.status+'; submission preserved');}
  job.phase='accepted';job.operation=disposition.operation;
  if(disposition.hold)job.submissionBlockingError={status:result.status,operation:job.operation.name};
  await writeJob(job);
  if(disposition.hold){const error=Error('Ambiguous batch response HTTP '+result.status+'; provider operation retained');error.acceptedJob=job;throw error;}
  return job;
   },
  });
  if(!finished)return false;
 }
}
async function adjudicate(entry,chapter,reports){
 const disputed=[];
 for(const item of chapter.items)if(needsModelReview(item,reports[item.customId],await read(join(entry.root,'receipts',item.customId+'.json'))))disputed.push(item);
 if(!disputed.length)return;
 await status({stage:'independent-phonemes',passages:disputed.map(i=>i.customId)});
 await save(join(entry.root,'phoneme-request.json'),disputed.map(i=>i.customId));
 const heartbeat=setInterval(()=>{void status({stage:'independent-phonemes',heartbeat:new Date().toISOString()}).catch(()=>{});},20000);
 try{await run('/usr/bin/nice',['-n','15',config.phonemePython,join(here,'phonemes.py'),entry.root],{timeout:7200000});}finally{clearInterval(heartbeat);}
 const rows=[];
 for(const item of disputed){
  const at=chapter.items.indexOf(item),phoneme=await read(join(entry.root,'phoneme-review',item.customId+'.json'));
  rows.push(evidenceRow(item,reports[item.customId],phoneme,{before:chapter.items[at-1]?.spokenText??'',after:chapter.items[at+1]?.spokenText??''},await renderingContext(entry.root,item)));
 }
 const {runCodexAnalysis}=await import(pathToFileURL(config.analysisModule??join(here,'../audiobooks/dist/codex-analysis.js')).href);
 const decisions={};
 for(let offset=0;offset<rows.length;offset+=6){
  const batch=rows.slice(offset,offset+6),key=hash({instructions:reviewInstructions,model:config.reviewModel??'gpt-6.1-sol',rows:batch}),path=join(entry.root,'llm-review',key+'.json');
  let result=await read(path,null);
  if(!result){
   for(let attempt=0;attempt<3;attempt++){
    await status({stage:'llm-review',passages:batch.map(r=>r.passage),attempt:attempt+1});
    const heartbeat=setInterval(()=>{void status({stage:'llm-review',attempt:attempt+1,heartbeat:new Date().toISOString()}).catch(()=>{});},20000);
    try{
     result=await runCodexAnalysis({model:config.reviewModel??'gpt-6.1-sol',instructions:reviewInstructions,input:JSON.stringify({rows:batch}),schema:reviewSchema});
     validateReview(result.value,batch);await save(path,{...result,rows:batch});break;
    }catch(error){if(attempt===2)throw error;await sleep(5000*(attempt+1));}finally{clearInterval(heartbeat);}
   }
  }
  if(result.authentication!=='chatgpt')throw Error('Expected subscription review; no API fallback');
  const verified=validateReview(result.value,batch);
  for(const [i,decision]of verified.entries()){
   const row=batch[i],report=reports[row.passage];
   if(hash(await read(join(entry.root,'review',row.passage+'.json')))!==row.reportHash)throw Error('Evidence changed during LLM review');
   const saved={...decision,audioSha256:row.audioSha256,reportHash:row.reportHash,evidenceHash:hash(row),proof:path,proofHash:hash(result.value),validator:(config.reviewModel??'gpt-6.1-sol')+'/chatgpt'};
   decisions[row.passage]=saved;reports[row.passage]=modelReview(report,saved,row);
  }
 }
 await save(join(entry.root,'llm-decisions.json'),decisions);
}
async function quality(entry,chapter){
 await status({stage:'checking-transcripts',operation:null});
 const heartbeat=setInterval(()=>{void fs.readdir(join(entry.root,'review')).then(files=>status({reviewedItems:files.filter(f=>f.endsWith('.json')).length,totalItems:chapter.items.length})).catch(()=>{});},15000);
 try{await run('/usr/bin/nice',['-n','15',config.python,join(here,'review.py'),entry.root],{timeout:7200000});}finally{clearInterval(heartbeat);}
 const major=[];let minor=0,hasRenderingRecovery=false;const reports={};
 const decisions=await read(join(entry.root,'owner-reviews.json'),{});
 for(const item of chapter.items){const report=await read(join(entry.root,'review',item.customId+'.json')),receipt=await read(join(entry.root,'receipts',item.customId+'.json'));
  if(report.sha256!==receipt.sha256||report.expected!==item.spokenText)throw Error('Stale transcript review');
  if(receipt.renderingRecovery){await renderingContext(entry.root,item);hasRenderingRecovery=true;}
  const decision=decisions[item.customId];
  reports[item.customId]=effectiveReview(report,decision?.audioSha256===report.sha256?decision:undefined);
 }
 if(config.automaticRepair||hasRenderingRecovery)await adjudicate(entry,chapter,reports);
 for(const [id,report]of Object.entries(reports)){if(['major','uncertain'].includes(report.severity))major.push(id);if(report.severity==='minor')minor++;}
 await save(join(entry.root,'effective-reviews.json'),reports);
 await save(join(entry.root,'quality.json'),{major,minor,status:major.length?'needs-review':minor?'provisional':'reviewed'});return major;
}
async function processChapter(entry,chapter){
 await status({status:'running',chapter:entry.chapterId,title:entry.title});
 // Retry the same immutable publication after a crash or a lost verification response.
 // Reassembling here could change its ID as later character voices are added.
 if(await exists(join(entry.root,'assembly.json'))){
  const {assembly}=await read(join(entry.root,'assembly.json'));
  const plan=await read(join(entry.root,'publication','plans',assembly.plan+'.json'));
  if(plan.inputHash!==entry.inputHash||assembly.source!==chapter.source)throw Error('Saved assembly belongs to different inputs');
  await publish(entry);await save(join(entry.root,'processing.json'),{status:'published'});await status({status:'published'});return;
 }
 await recoverRepairs(entry,read,save);
 let major;
 while(true){
  major=await quality(entry,chapter);
  if(!major.length||!config.automaticRepair||processOnly)break;
  const reports=await read(join(entry.root,'effective-reviews.json'));
  let changed=false;
  for(const id of major){
   if(!['major','uncertain'].includes(reports[id].severity))continue;
   const item=chapter.items.find(i=>i.customId===id),voices=await read(join(root,'voices.json'));
   const repaired=await repairPassage({entry,item,config,read,save,run,voices,status,
    synthesize:(repairEntry,repairChapter,v)=>paid.run(()=>synthesize(repairEntry,repairChapter,v))});
   changed=changed||repaired;
  }
  if(!changed)break;
 }
 const issues=[];
 const effective=await read(join(entry.root,'effective-reviews.json'));
 for(const item of chapter.items){
  const report=effective[item.customId];
  if(report.severity!=='pass')issues.push({passage:item.customId,role:item.role,...report});
 }
 await save(join(entry.root,'review-backlog.json'),{chapter:entry.chapterId,status:issues.length?'open':'clear',issues,updatedAt:new Date().toISOString()});
 if(major.length){
  await save(join(entry.root,'processing.json'),{status:'needs-review',passages:major});
  await status({status:'needs-review',passages:major});await archive();return;
 }
 await assemble(entry,chapter);await publish(entry);
 await save(join(entry.root,'processing.json'),{status:'published'});
 await status({status:'published'});
}
async function assemble(entry,chapter){
 await status({stage:'assembling',operation:null});
 validateCoverage(chapter.segments,(await read(join(entry.root,'source.json'))).text);
 const temp=join(entry.root,'assembly-temp');await fs.mkdir(temp,{recursive:true});
 await run('ffmpeg',['-v','error','-y','-f','lavfi','-i','anullsrc=r=48000:cl=mono','-t','0.1','-c:a','pcm_s16le',join(temp,'pause.wav')]);
 const paths=[],timeline=[];let offset=0;
 for(const segment of chapter.segments){const start=offset;
  for(const id of segment.items){const receipt=await read(join(entry.root,'receipts',id+'.json'));const file=join(entry.root,'audio',id+'.wav');if(sha(await fs.readFile(file))!==receipt.sha256)throw Error('Assembly checksum mismatch');paths.push(file);offset+=receipt.duration;}
  if(!segment.items.length){paths.push(join(temp,'pause.wav'));offset+=.1;}
  timeline.push({segmentId:hash({input:entry.inputHash,uid:segment.uid}),asset:hash(segment.items),start,end:offset,spans:segment.spans,...(segment.presentation?{presentation:{kind:segment.presentation,text:segment.text,speaker:segment.role}}:{})});
  paths.push(join(temp,'pause.wav'));offset+=.1;
 }
 const list=join(temp,'concat.txt');if(paths.some(p=>p.includes("'")))throw Error('Unsupported quote in media path');await fs.writeFile(list,paths.map(p=>`file '${p}'`).join('\n'));
 const audio=join(entry.root,'chapter.mp3');await run('ffmpeg',['-v','error','-y','-f','concat','-safe','0','-i',list,'-af','loudnorm=I=-18:TP=-1.5:LRA=11','-ar','48000','-ac','1','-c:a','libmp3lame','-b:a','128k',audio],{timeout:600000});
 await run('ffmpeg',['-v','error','-i',audio,'-f','null','-'],{timeout:600000});
 const duration=Number((await run('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',audio])).trim());
 if(Math.abs(duration-offset)>.2)throw Error('Final duration differs from passage timeline');
 const renderingRecoveries=[];
 for(const item of chapter.items){const receipt=await read(join(entry.root,'receipts',item.customId+'.json'));if(receipt.renderingRecovery){const recovery=receipt.renderingRecovery;renderingRecoveries.push({passage:item.customId,rendererVersion:recovery.rendererVersion,planHash:recovery.planHash,renderingFingerprint:recovery.renderingProof.fingerprint,audioSha256:receipt.sha256});}}
 const plan={policy:{model:'inworld-tts-2'},quality:await read(join(entry.root,'quality.json')),inputHash:entry.inputHash,voiceIds:Object.fromEntries(Object.entries(await read(join(root,'voices.json'))).map(([k,v])=>[k,v.voiceId])),...(renderingRecoveries.length?{renderingRecoveries}:{})};
 const planId=hash(plan), data={schemaVersion:1,chapterId:chapter.chapterId,sequence:chapter.sequence,source:chapter.source,analysis:chapter.analysis,plan:planId,checksum:sha(await fs.readFile(audio)),duration,timeline};const assembly={...data,id:hash(data)};
 const bundle=join(entry.root,'publication');await save(join(bundle,'plans',planId+'.json'),plan);await save(join(bundle,'assemblies',assembly.id,'metadata.json'),assembly);await fs.copyFile(audio,join(bundle,'assemblies',assembly.id,'chapter.mp3'));
 // Reader state is immutable and content addressed; install only missing, byte-identical objects.
 await save(join(bundle,'sources',chapter.source+'.json'),await read(join(entry.root,'source.json')));
 await save(join(bundle,'analyses',chapter.analysis+'.json'),await read(join(entry.root,'analysis.json')));
 const batch=(config.batchPrefix??'inworld-batch')+'-'+chapter.sequence;await save(join(bundle,'deliveries',batch,'manifest.json'),{chapters:[{sequence:chapter.sequence,assembly:assembly.id}]});
 await save(join(entry.root,'assembly.json'),{assembly,batch});
}
async function publish(entry){
 await status({stage:'publishing'});const {assembly,batch}=await read(join(entry.root,'assembly.json'));
 await archive();
 const installer=await fs.readFile(join(here,'install.py'),'utf8');
 await run('ssh',[config.host,'sudo python3 -c '+quote(installer)+' '+quote(config.archive+'/chapters/'+entry.sequence+'/publication')+' '+quote((config.remoteFictions??'/fictions')+'/'+config.fiction)+' '+quote(config.archive)+' '+quote(config.remoteFictions??'/fictions')+' '+(config.ownerUid??950)+' '+(config.ownerGid??950)]);
 const remote=await fs.readFile(join(here,'publish.mjs'),'utf8');
 const code='const input='+JSON.stringify({archive:config.archive+'/chapters/'+entry.sequence,fiction:config.fiction,edition:config.edition,assembly:assembly.id,batch})+';\n'+remote;
 let output;
 for(let attempt=0;attempt<30;attempt++){
  try{output=await run('ssh',[config.host,'sudo docker exec -i '+quote(config.workerContainer??'audiobook-worker')+' node --input-type=module'],{input:code,timeout:300000});break;}
  catch(e){if(!e.message.includes('State is locked'))throw e;await status({stage:'waiting-for-publication-lock'});await sleep(10000);}
 }
 if(!output)throw Error('Publication lock remained occupied');
 const verify='const input='+JSON.stringify({fiction:config.fiction,edition:config.edition,assembly:assembly.id,identityHeader:config.identityHeader,identityValue:config.identityValue})+';\n'+await fs.readFile(join(here,'verify.mjs'),'utf8');
 const verified=await run('ssh',[config.host,'sudo docker exec -i '+quote(config.listenerContainer??'audiobook-listener')+' node --input-type=module'],{input:verify});
 const proof=JSON.parse(verified.trim());if(proof.assembly!==assembly.id||!proof.audioVerified||!proof.textVerified)throw Error('Publication unverified');
 await save(join(entry.root,'published.json'),proof);await archive();await fs.rm(join(entry.root,'assembly-temp'),{recursive:true,force:true});
}
let lock,renderingOwnerLock;
if(renderingOnly){
 try{
  const entry=config.chapters.find(value=>value.chapterId===renderingOnly);if(!entry)throw Error('Unknown rendering recovery chapter');
  if(await exists(join(root,'supervisor.lock'))||await exists(join(entry.root,'owner-review.lock')))throw Error('Rendering recovery requires an idle stopped supervisor and chapter');
  lock=await fs.open(join(root,'worker.lock'),'wx');await lock.writeFile(String(process.pid));await lock.close();
  const ownerPath=join(entry.root,'owner-review.lock'),owner=await fs.open(ownerPath,'wx');renderingOwnerLock=ownerPath;await owner.writeFile(String(process.pid));await owner.close();
  if(await exists(join(root,'supervisor.lock')))throw Error('Supervisor started before recovery acquired its worker lock');
  const chapter=await read(join(entry.root,'input.json'));if(hash(chapter)!==entry.inputHash)throw Error('Rendering recovery input changed');
  const active=await read(join(root,'processing-status.json'),{});
  if(active.status==='running'){
   const producer=await read(join(root,'status.json'),{});let alive=true;
   if(Number.isInteger(active.pid)&&active.pid>0)try{process.kill(active.pid,0);}catch(error){if(error.code==='ESRCH')alive=false;else throw error;}
   if(alive||producer.status!=='paused')throw Error('Rendering recovery cannot overlap active or unconfirmed processing');
  }
  const renderer=await import(pathToFileURL(join(here,'../audiobooks/dist/spoken-redactions.js')).href),voices=await read(join(root,'voices.json'));
  for(const [role,voice]of Object.entries(config.originalVoices))if(voices[role]?.voiceId!==voice.voiceId)throw Error('Original voice changed: '+role);
  const targets=renderingIds.map(id=>{const item=chapter.items.find(value=>value.customId===id);if(!item)throw Error('Unknown rendering recovery passage');return item;});
  await status({status:'running',chapter:entry.chapterId,passages:renderingIds});
  for(const item of targets){
   await recoverVisualRedactionPassage({entry,chapter,item,config,read,save,run,voices,status,render:renderer.renderVisualRedactions,verify:renderer.verifyVisualRedactions,
    synthesize:(recoveryEntry,recoveryChapter,v)=>paid.run(()=>synthesize(recoveryEntry,recoveryChapter,v,false,1))});
  }
  await archive();await status({status:'ready-for-fidelity-review',stage:'recovered'});
 }catch(error){await status({status:'held',reason:String(error.message)});process.exitCode=1;}
 finally{if(renderingOwnerLock)await fs.unlink(renderingOwnerLock).catch(()=>{});if(lock)await fs.unlink(join(root,'worker.lock')).catch(()=>{});}
}else if(processOnly){
 const lockPath=join(reviewEntry.root,'owner-review.lock');
 let ownLock=false;
 try{
  const chapter=await read(join(reviewEntry.root,'input.json'));
  processingOnlyEntry(config,processOnly,await read(join(reviewEntry.root,'processing.json'),null),await read(join(reviewEntry.root,'generated.json'),null),chapter);
  const handle=await fs.open(lockPath,'wx');ownLock=true;await handle.writeFile(String(process.pid));await handle.close();
  await processChapter(reviewEntry,chapter);
 }catch(error){await status({status:'needs-attention',reason:String(error.message)});process.exitCode=1;}
 finally{if(ownLock)await fs.unlink(lockPath);}
}else{
try{
 await fs.mkdir(root,{recursive:true});
 try{lock=await fs.open(join(root,'worker.lock'),'wx');await lock.writeFile(String(process.pid));await lock.close();}catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(await fs.readFile(join(root,'worker.lock'),'utf8'));try{process.kill(pid,0);throw Error('Runner already active');}catch(error){if(error.code!=='ESRCH')throw error;}await fs.unlink(join(root,'worker.lock'));lock=await fs.open(join(root,'worker.lock'),'wx');await lock.writeFile(String(process.pid));await lock.close();}
 await run('ssh',[config.host,'mkdir -p '+quote(config.archive)]);
 await status({status:'running',completed:[]});
 const queueCheckpoint=join(root,'queue-accepted.json');
 let queue=validateQueueUpdate(await read(queueCheckpoint,null),config),nextChapter=0,paused=false;
 await save(queueCheckpoint,queue);
 while(true){
  const next=validateQueueUpdate(queue,await read(process.argv[2]));
  if(hash(queue)!==hash(next))await save(queueCheckpoint,next);
  queue=next;config.chapters=next.chapters;
  if(paid.error)throw paid.error;
  if(await exists(join(root,'pause.requested'))){paused=true;break;}
  if(nextChapter>=config.chapters.length){
   if(queuePreparationComplete(queue))break;
   await status({status:'running',stage:'waiting-for-prepared-chapters',prepared:config.chapters.length,total:queue.selectedChapterIds.length,operation:null});
   await sleep((config.queuePollSeconds??5)*1000);continue;
  }
  const entry=config.chapters[nextChapter++];
  const chapter=await read(join(entry.root,'input.json'));if(hash(chapter)!==entry.inputHash)throw Error('Input changed after preparation');
  const done=await read(join(entry.root,'published.json'),null);
  if(done){if(done.assembly!==(await read(join(entry.root,'assembly.json'))).assembly.id)throw Error('Published receipt mismatch');current.completed.push(entry.chapterId);continue;}
  await status({chapter:entry.chapterId,title:entry.title,stage:'preparing',role:null});
  await recoverRepairs(entry,read,save);
  const generatedReceipt=await read(join(entry.root,'generated.json'),null);
  if(generatedReceipt&&(generatedReceipt.chapter!==entry.chapterId||generatedReceipt.inputHash!==entry.inputHash||generatedReceipt.items!==chapter.items.length))throw Error('Generated chapter receipt does not match prepared inputs');
  const generated=await paid.run(async()=>{const voices=await voicesFor(chapter);return await synthesize(entry,chapter,voices,true);});
  if(!generated){paused=true;break;}
  if(!generatedReceipt)await save(join(entry.root,'generated.json'),{chapter:entry.chapterId,inputHash:entry.inputHash,items:chapter.items.length,completedAt:new Date().toISOString()});
  current.completed.push(entry.chapterId);await status({stage:'chapter-generated'});
  processing.enqueue(entry.chapterId,()=>laneContext.run(true,()=>processChapter(entry,chapter)),async error=>{
   await save(join(entry.root,'processing.json'),{status:'needs-attention',reason:String(error.message)});
  },{
   shouldStart:async()=>!await exists(join(root,'pause.requested')),
   onDeferred:async()=>save(join(entry.root,'processing.json'),{status:'queued-for-resume',chapter:entry.chapterId,inputHash:entry.inputHash,updatedAt:new Date().toISOString()}),
  });
 }
 await status({stage:paused?'pausing-processing-remaining':'generation-complete-processing-remaining',operation:null});
 await processing.drain();
 paused=paused||await exists(join(root,'pause.requested'));
 const pending=[];for(const entry of config.chapters)if(!await exists(join(entry.root,'published.json')))pending.push(entry.chapterId);
 if(paid.error)throw paid.error;
 await status({status:paused?'paused':pending.length?'complete-with-review-backlog':'complete',stage:paused?'paused':'complete',pending,deferredProcessing:processing.deferred,processingErrors:processing.errors,operation:null});await archive();
 if(processing.errors.length)process.exitCode=1; // Launchd retries cached work after transient review or publication failures.
}catch(error){await processing.drain();if(!lock){console.error(error.message);process.exit(0);}await status({status:'held',reason:String(error.message),stage:current.stage});if(error.retryable)process.exitCode=1;try{await archive();}catch{console.error('Archive unavailable; local checkpoints retained');}}
finally{if(lock)await fs.unlink(join(root,'worker.lock')).catch(()=>{});}
}
