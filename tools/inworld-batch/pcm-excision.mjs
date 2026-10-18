/** Dry plan by default. Apply one reviewed zero-paid edit, then require full QA. */
import fs from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {hash,sha} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {atomic} from '../audiobooks/dist/store.js';
import {baseRenderingContext} from './rendering-review.mjs';
import {buildPCMExcision} from './pcm-excision-core.mjs';
import {editedPCMReceipt,excisionDirectory,loadPCMExcisionEvidence} from './pcm-excision-evidence.mjs';
import {chapterProcessingLockVersion,withChapterProcessingLock} from './chapter-processing-lock.mjs';
import {installPromotion} from './repair.mjs';
import {rollbackEvidence,rollbackPlan,validateCompletedRollback,validateCorrection} from './pcm-rollback.mjs';
const here=dirname(fileURLToPath(import.meta.url));
const read=async(path,fallback)=>{try{return JSON.parse(await fs.readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT'&&fallback!==undefined)return fallback;throw error;}};
const exists=async path=>{try{await fs.access(path);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
const save=async(path,value)=>atomic(path,JSON.stringify(value,null,2)+'\n');
async function immutable(path,bytes){try{await fs.writeFile(path,bytes,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;if(!(await fs.readFile(path)).equals(bytes))throw Error('Retained PCM evidence changed');}}
export async function assertPCMRuntime(config){
 try{
  if(!/^[a-f0-9]{40}$/.test(config.sourceCommit??''))throw Error('Missing source receipt');
  const runtime=resolve(config.sourceRoot),version=(await fs.readFile(join(runtime,'source-commit.txt'),'utf8')).trim();
  if(version!==config.sourceCommit)throw Error('Source receipt mismatch');
  const module=await import(pathToFileURL(join(runtime,'tools/inworld-batch/chapter-processing-lock.mjs')).href);
  if(module.chapterProcessingLockVersion!==chapterProcessingLockVersion||chapterProcessingLockVersion!=='generation-and-qa-v1')throw Error('Unsupported chapter lock');
  for(const file of ['runner.mjs','chapter-processing-lock.mjs'])if(sha(await fs.readFile(join(runtime,'tools/inworld-batch',file)))!==sha(await fs.readFile(join(here,file))))throw Error('Active runtime lacks matching generation/QA lock integration');
 }catch{throw Error('PCM application requires an installed committed runtime with matching generation-and-qa-v1 chapter locks');}
}
async function state(configPath,chapterId,passage){
 const config=await read(configPath),queue=await read(join(config.root,'queue.json'));
 if(config.maxRetakes!==2||queue.maxRetakes!==undefined&&queue.maxRetakes!==2)throw Error('PCM recovery requires the unchanged two-retake bound');
 if(!config.chapterIds?.includes(chapterId))throw Error('PCM chapter is outside selected scope');
 const entry=queue.chapters?.find(row=>row.chapterId===chapterId);if(!entry)throw Error('PCM chapter is not queued');
 const chapter=await read(join(entry.root,'input.json'));if(hash(chapter)!==entry.inputHash)throw Error('PCM queued input changed');
 const item=chapter.items.find(row=>row.customId===passage);if(!item)throw Error('Unknown PCM passage');
 const voices=await read(join(config.root,'voices.json'));
 for(const [role,voice]of Object.entries(config.originalVoices??{}))if(voices[role]?.voiceId!==voice.voiceId)throw Error('PCM original voice changed');
 const receipt=await read(join(entry.root,'receipts',item.customId+'.json'));
 if(!voices[item.role]?.voiceId||receipt.voiceId!==voices[item.role].voiceId||receipt.requestHash!==hash({...item.request,voiceId:voices[item.role].voiceId}))throw Error('PCM source request or saved voice changed');
 return {config,entry,chapter,item};
}
async function guard({config,entry,item}){
 const processing=await read(join(entry.root,'processing.json'));
 if(processing.status!=='needs-review'||!processing.passages?.includes(item.customId))throw Error('PCM target must remain held for fidelity review');
 if(await exists(join(entry.root,'assembly.json'))||await exists(join(entry.root,'published.json')))throw Error('PCM assembled or published audio is immutable');
 for(const file of ['status.json','processing-status.json']){const active=await read(join(config.root,file),{});if(active.status==='running'&&active.chapter===entry.chapterId)throw Error('PCM target has an active generation or QA lane');}
}
async function prepare(selected,childId,candidateDirectory,correction=false){
 const {entry,item}=selected,originalDirectory=excisionDirectory(entry.root,item),directory=correction?join(originalDirectory,'correction'):originalDirectory,pending=await read(join(directory,'promotion.json'),null);
 if(!correction&&await exists(join(originalDirectory,'rollback')))throw Error('A rolled-back legacy PCM edit cannot be reapplied');
 let rollback;if(correction){
  const old=await read(join(originalDirectory,'plan.json'));
  // A prepared correction may have promoted only its WAV; validate rollback using retained original state.
  rollback=await validateCompletedRollback(selected,fingerprint(old),pending?.state==='prepared'?pending.receipt:undefined);
 }
 const currentBytes=await fs.readFile(join(entry.root,'receipts',item.customId+'.json')),current=JSON.parse(currentBytes.toString('utf8'));
 if(current.offlinePCMExcision&&pending?.state!=='prepared')throw Error('PCM insertion excision cannot be repeated');
 if(pending&&pending.state!=='prepared')throw Error('Unexpected PCM promotion journal state');
 const retained=pending?.state==='prepared',baseBytes=retained?await fs.readFile(join(directory,'base-receipt.json')):currentBytes,base=JSON.parse(baseBytes.toString('utf8'));
 const audioPath=retained?join(directory,'base.wav'):join(entry.root,'audio',item.customId+'.wav'),baseAudio=await fs.readFile(audioPath);
 const context=await baseRenderingContext(entry.root,item,base,audioPath);
 const metadata=retained?directory:resolve(candidateDirectory),args=await loadPCMExcisionEvidence(entry.root,item,base,context,baseAudio,baseBytes,metadata,childId);
 args.entry=entry;
 const built=buildPCMExcision(args);if(correction)built.plan=validateCorrection(rollback.oldPlan,rollback.plan,built.plan);
 const next=editedPCMReceipt(base,built.plan);
 if(retained){
  if(pending.passage!==item.customId||pending.previousSha256!==base.sha256||fingerprint(await read(join(directory,'plan.json')))!==fingerprint(built.plan)||fingerprint(pending.receipt)!==fingerprint(next))throw Error('Prepared PCM promotion changed');
  if(![fingerprint(base),fingerprint(next)].includes(fingerprint(current)))throw Error('PCM receipt changed during interrupted promotion');
  const digest=sha(await fs.readFile(join(entry.root,'audio',item.customId+'.wav')));if(![base.sha256,next.sha256].includes(digest))throw Error('PCM audio changed during interrupted promotion');
 }
 return {...built,directory,metadata,base,baseBytes,baseAudio,next,pending,symbolEvidence:args.symbolEvidence};
}
export async function planPCMExcision(configPath,chapterId,passage,childId,candidateDirectory,correction=false){
 const selected=await state(configPath,chapterId,passage);await guard(selected);
 const built=await prepare(selected,childId,candidateDirectory,correction);return {plan:built.plan,planHash:fingerprint(built.plan)};
}
export async function applyPCMExcision(configPath,chapterId,passage,childId,candidateDirectory,expectedPlanHash,correction=false){
 const initial=await state(configPath,chapterId,passage);await assertPCMRuntime(initial.config);await guard(initial);
 if(await exists(join(initial.entry.root,'owner-review.lock')))throw Error('PCM target chapter is locked');
 return await withChapterProcessingLock(initial.entry.root,async()=>{
  const selected=await state(configPath,chapterId,passage);await assertPCMRuntime(selected.config);await guard(selected);
  const built=await prepare(selected,childId,candidateDirectory,correction);
  if(fingerprint(built.plan)!==expectedPlanHash)throw Error('PCM reviewed plan fingerprint changed');
  await fs.mkdir(built.directory,{recursive:true,mode:0o700});
  await immutable(join(built.directory,'base-receipt.json'),built.baseBytes);await immutable(join(built.directory,'base.wav'),built.baseAudio);
  for(const name of ['candidate.wav','derivation.json','validation-metadata.json','full-parent-derivation-metadata.json'])await immutable(join(built.directory,name),await fs.readFile(join(built.metadata,name)));
  await fs.mkdir(join(built.directory,'symbol-evidence'),{recursive:true,mode:0o700});
  for(const [digest,row]of Object.entries(built.symbolEvidence))await immutable(join(built.directory,'symbol-evidence',digest+'.json'),row.bytes);
  await immutable(join(built.directory,'plan.json'),Buffer.from(JSON.stringify(built.plan,null,2)+'\n'));
  await immutable(join(built.directory,'replacement.wav'),built.audio);
  await guard(selected);
  const promotion={state:'prepared',passage,previousSha256:built.base.sha256,receipt:built.next};
  if(!built.pending)await save(join(built.directory,'promotion.json'),promotion);
  await installPromotion(selected.entry,built.directory,promotion,save);
  return {applied:true,planHash:expectedPlanHash,audioSha256:built.next.sha256,freshFullQARequired:true,paidCalls:0};
 });
}
export async function rollbackPCMExcision(configPath,chapterId,passage,rejectedPlanHash){
 const initial=await state(configPath,chapterId,passage);await assertPCMRuntime(initial.config);await guard(initial);
 if(await exists(join(initial.entry.root,'owner-review.lock')))throw Error('PCM target chapter is locked');
 return await withChapterProcessingLock(initial.entry.root,async()=>{
  const selected=await state(configPath,chapterId,passage);await assertPCMRuntime(selected.config);await guard(selected);
  const e=await rollbackEvidence(selected,rejectedPlanHash),journal=await read(join(e.rollback,'promotion.json'),null);
  if(journal&&(!['prepared','complete'].includes(journal.state)||journal.passage!==passage||journal.previousSha256!==e.bad.sha256||fingerprint(journal.receipt)!==fingerprint(e.base)))throw Error('PCM rollback journal changed');
  if(!journal&&(fingerprint(e.current)!==fingerprint(e.bad)||!e.currentAudio.equals(e.badAudio)))throw Error('PCM rollback requires the exact rejected current audio');
  await fs.mkdir(e.rollback,{recursive:true,mode:0o700});
  if(!journal){
   await immutable(join(e.rollback,'original.wav'),e.badAudio);
   await immutable(join(e.rollback,'original-receipt.json'),await fs.readFile(join(selected.entry.root,'receipts',passage+'.json')));
   await immutable(join(e.rollback,'original-review.json'),await fs.readFile(join(selected.entry.root,'review',passage+'.json')));
   await immutable(join(e.rollback,'original-effective-review.json'),Buffer.from(JSON.stringify((await read(join(selected.entry.root,'effective-reviews.json')))[passage],null,2)+'\n'));
   await immutable(join(e.rollback,'original-phoneme-review.json'),await fs.readFile(join(selected.entry.root,'phoneme-review',passage+'.json')));
   const decisions=join(selected.entry.root,'llm-decisions.json');if(await exists(decisions))await immutable(join(e.rollback,'original-llm-decisions.json'),await fs.readFile(decisions));
  }
  const built=await rollbackPlan(selected,rejectedPlanHash);
  await immutable(join(e.rollback,'original-model-proof.json'),built.proofBytes);
  await immutable(join(e.rollback,'plan.json'),Buffer.from(JSON.stringify(built.plan,null,2)+'\n'));
  await immutable(join(e.rollback,'replacement.wav'),e.baseAudio);
  if(journal?.state!=='complete'){
   const promotion={state:'prepared',passage,previousSha256:e.bad.sha256,receipt:e.base};
   if(!journal)await save(join(e.rollback,'promotion.json'),promotion);
   const receiptPath=join(selected.entry.root,'receipts',passage+'.json');
   const saveRestored=async(path,value)=>path===receiptPath?atomic(path,e.baseBytes.toString('utf8')):save(path,value);
   await guard(selected);await installPromotion(selected.entry,e.rollback,promotion,saveRestored);
  }
  await validateCompletedRollback(selected,rejectedPlanHash);
  return {restored:true,adopted:journal?.state==='complete',rollbackPlanHash:fingerprint(built.plan),audioSha256:e.base.sha256,paidCalls:0,counterChanges:false};
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),[config,chapter,passage,child,candidate,mode,expected]=args;
 if(child==='--rollback'){
  if(args.length!==5||!/^[a-f0-9]{64}$/.test(candidate??''))throw Error('Usage: pcm-excision.mjs JOB_CONFIG CHAPTER_ID PASSAGE_ID --rollback REJECTED_PLAN_HASH');
  console.log(JSON.stringify(await rollbackPCMExcision(config,chapter,passage,candidate)));
 }else{
 const correction=args.includes('--legacy-correction'),filtered=args.filter(arg=>arg!=='--legacy-correction');
 if(correction&&args.length!==filtered.length+1)throw Error('Duplicate correction flag');
 const [c,ch,p,id,dir,m,h]=filtered;
 if(!c||!ch||!p||!id||!dir||filtered.length>7||(m!==undefined&&m!=='--apply')||(m==='--apply'&&!/^[a-f0-9]{64}$/.test(h??'')))throw Error('Usage: pcm-excision.mjs JOB_CONFIG CHAPTER_ID PASSAGE_ID CHILD_ID CANDIDATE_DIRECTORY [--apply REVIEWED_PLAN_HASH] [--legacy-correction]');
 console.log(JSON.stringify(m==='--apply'?await applyPCMExcision(c,ch,p,id,dir,h,correction):await planPCMExcision(c,ch,p,id,dir,correction)));
 }
}
