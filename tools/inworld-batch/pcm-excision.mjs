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
async function prepare(selected,childId,candidateDirectory){
 const {entry,item}=selected,directory=excisionDirectory(entry.root,item),pending=await read(join(directory,'promotion.json'),null);
 const currentBytes=await fs.readFile(join(entry.root,'receipts',item.customId+'.json')),current=JSON.parse(currentBytes.toString('utf8'));
 if(current.offlinePCMExcision&&pending?.state!=='prepared')throw Error('PCM insertion excision cannot be repeated');
 if(pending&&pending.state!=='prepared')throw Error('Unexpected PCM promotion journal state');
 const retained=pending?.state==='prepared',baseBytes=retained?await fs.readFile(join(directory,'base-receipt.json')):currentBytes,base=JSON.parse(baseBytes.toString('utf8'));
 const audioPath=retained?join(directory,'base.wav'):join(entry.root,'audio',item.customId+'.wav'),baseAudio=await fs.readFile(audioPath);
 const context=await baseRenderingContext(entry.root,item,base,audioPath);
 const metadata=retained?directory:resolve(candidateDirectory),args=await loadPCMExcisionEvidence(entry.root,item,base,context,baseAudio,baseBytes,metadata,childId);
 args.entry=entry;
 const built=buildPCMExcision(args),next=editedPCMReceipt(base,built.plan);
 if(retained){
  if(pending.passage!==item.customId||pending.previousSha256!==base.sha256||fingerprint(await read(join(directory,'plan.json')))!==fingerprint(built.plan)||fingerprint(pending.receipt)!==fingerprint(next))throw Error('Prepared PCM promotion changed');
  if(![fingerprint(base),fingerprint(next)].includes(fingerprint(current)))throw Error('PCM receipt changed during interrupted promotion');
  const digest=sha(await fs.readFile(join(entry.root,'audio',item.customId+'.wav')));if(![base.sha256,next.sha256].includes(digest))throw Error('PCM audio changed during interrupted promotion');
 }
 return {...built,directory,metadata,base,baseBytes,baseAudio,next,pending};
}
export async function planPCMExcision(configPath,chapterId,passage,childId,candidateDirectory){
 const selected=await state(configPath,chapterId,passage);await guard(selected);
 const built=await prepare(selected,childId,candidateDirectory);return {plan:built.plan,planHash:fingerprint(built.plan)};
}
export async function applyPCMExcision(configPath,chapterId,passage,childId,candidateDirectory,expectedPlanHash){
 const initial=await state(configPath,chapterId,passage);await assertPCMRuntime(initial.config);await guard(initial);
 if(await exists(join(initial.entry.root,'owner-review.lock')))throw Error('PCM target chapter is locked');
 return await withChapterProcessingLock(initial.entry.root,async()=>{
  const selected=await state(configPath,chapterId,passage);await assertPCMRuntime(selected.config);await guard(selected);
  const built=await prepare(selected,childId,candidateDirectory);
  if(fingerprint(built.plan)!==expectedPlanHash)throw Error('PCM reviewed plan fingerprint changed');
  await fs.mkdir(built.directory,{recursive:true,mode:0o700});
  await immutable(join(built.directory,'base-receipt.json'),built.baseBytes);await immutable(join(built.directory,'base.wav'),built.baseAudio);
  for(const name of ['candidate.wav','derivation.json','validation-metadata.json','full-parent-derivation-metadata.json'])await immutable(join(built.directory,name),await fs.readFile(join(built.metadata,name)));
  await immutable(join(built.directory,'plan.json'),Buffer.from(JSON.stringify(built.plan,null,2)+'\n'));
  await immutable(join(built.directory,'replacement.wav'),built.audio);
  await guard(selected);
  const promotion={state:'prepared',passage,previousSha256:built.base.sha256,receipt:built.next};
  if(!built.pending)await save(join(built.directory,'promotion.json'),promotion);
  await installPromotion(selected.entry,built.directory,promotion,save);
  return {applied:true,planHash:expectedPlanHash,audioSha256:built.next.sha256,freshFullQARequired:true,paidCalls:0};
 });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [config,chapter,passage,child,candidate,mode,expected]=process.argv.slice(2);
 if(!config||!chapter||!passage||!child||!candidate||(mode!==undefined&&mode!=='--apply')||(mode==='--apply'&&!/^[a-f0-9]{64}$/.test(expected??'')))throw Error('Usage: pcm-excision.mjs JOB_CONFIG CHAPTER_ID PASSAGE_ID CHILD_ID CANDIDATE_DIRECTORY [--apply REVIEWED_PLAN_HASH]');
 console.log(JSON.stringify(mode==='--apply'?await applyPCMExcision(config,chapter,passage,child,candidate,expected):await planPCMExcision(config,chapter,passage,child,candidate)));
}
