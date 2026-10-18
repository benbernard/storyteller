import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash,sha} from './core.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const read=async(path,fallback)=>{try{return JSON.parse(await fs.readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT')return fallback;throw error;}};
const exists=async path=>fs.access(path).then(()=>true,()=>false);
async function save(path,value){const temporary=path+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,JSON.stringify(value)+'\n',{mode:0o600});await fs.rename(temporary,path);}
const safeReason=error=>error instanceof SyntaxError?'Invalid JSON evidence':error.code?'Local evidence operation failed ('+error.code+')':String(error.message);

export function validAheadReport(report,item){
 return report?.sha256===item.audioSha256&&report.expected===item.expected&&['pass','minor','major','uncertain'].includes(report.severity)
  &&Array.isArray(report.attempts)&&report.attempts.length>0&&report.attempts.every(attempt=>typeof attempt.model==='string'&&typeof attempt.transcript==='string'&&Array.isArray(attempt.changes)&&typeof attempt.major==='boolean'&&Number.isFinite(attempt.wordRecall));
}
export function planAheadEntries(entries,facts,requested=[]){
 if(requested.some(id=>!entries.some(entry=>entry.chapterId===id)))throw Error('Requested chapter is not in the prepared queue');
 return entries.filter(entry=>{
  const fact=facts[entry.chapterId];
  return (!requested.length||requested.includes(entry.chapterId))&&fact?.generated&&fact.inputHash===entry.inputHash&&!fact.active&&!fact.published&&!fact.reviewsComplete&&!fact.requiresProofReview;
 });
}
export function validateAheadMerge(snapshot,current,reports){
 if(current.active||current.published)throw Error('Chapter became active or published');
 if(current.requiresProofReview)throw Error('Rendering recovery requires the full live proof chain');
 if(snapshot.inputHash!==current.inputHash||snapshot.generatedHash!==current.generatedHash||hash(snapshot.items)!==hash(current.items))throw Error('Chapter evidence changed during ahead review');
 if(Object.keys(reports).length!==snapshot.items.length||snapshot.items.some(item=>!validAheadReport(reports[item.customId],item)))throw Error('Ahead review reports do not match immutable evidence');
 return snapshot.items.map(item=>item.customId);
}

async function activity(config,entry){
 const global=await read(join(config.root,'processing-status.json'),{}),local=await read(join(entry.root,'processing.json'),{}),owner=await read(join(entry.root,'owner-processing-status.json'),{});
 return {active:(global.chapter===entry.chapterId&&global.status==='running')||local.status==='running'||owner.status==='running'||await exists(join(entry.root,'owner-review.lock')),published:await exists(join(entry.root,'published.json'))};
}
async function itemEvidence(entry,item){
 const receipt=await read(join(entry.root,'receipts',item.customId+'.json'));
 const audioSha256=sha(await fs.readFile(join(entry.root,'audio',item.customId+'.wav')));
 if(!receipt||receipt.sha256!==audioSha256)throw Error('Generated audio receipt does not match audio');
 return {customId:item.customId,expected:item.spokenText,audioSha256,receiptHash:hash(receipt),renderingRecovery:Boolean(receipt.renderingRecovery)};
}
async function evidence(config,entry){
 const busy=await activity(config,entry);
 if(busy.active||busy.published)return {generated:false,inputHash:entry.inputHash,items:[],...busy};
 const chapter=await read(join(entry.root,'input.json')),generated=await read(join(entry.root,'generated.json'));
 if(!chapter||hash(chapter)!==entry.inputHash||!Array.isArray(chapter.items)||chapter.items.some(item=>!/^[A-Za-z0-9_-]+$/u.test(item.customId)||typeof item.spokenText!=='string')||new Set(chapter.items.map(item=>item.customId)).size!==chapter.items.length)throw Error('Prepared chapter input changed or is invalid');
 const complete=generated?.chapter===entry.chapterId&&generated.inputHash===entry.inputHash&&generated.items===chapter.items.length;
 const items=[];if(complete)for(const item of chapter.items)items.push(await itemEvidence(entry,item));
 const reviews=await Promise.all(items.map(item=>read(join(entry.root,'review',item.customId+'.json'),null)));
 return {chapter,generated:complete,generatedHash:hash(generated??null),inputHash:hash(chapter),items,...await activity(config,entry),requiresProofReview:items.some(item=>item.renderingRecovery),reviewsComplete:complete&&items.every((item,index)=>validAheadReport(reviews[index],item))};
}
async function snapshotEntry(config,entry,proof){
 const directory=await fs.mkdtemp(join(config.root,'tmp','review-ahead-'));
 try{
 await fs.mkdir(join(directory,'audio'));await fs.mkdir(join(directory,'review'));
 await fs.copyFile(join(entry.root,'input.json'),join(directory,'input.json'));await fs.chmod(join(directory,'input.json'),0o400);
 for(const item of proof.items){
  const audio=join(directory,'audio',item.customId+'.wav');await fs.copyFile(join(entry.root,'audio',item.customId+'.wav'),audio);await fs.chmod(audio,0o400);
  if(sha(await fs.readFile(audio))!==item.audioSha256)throw Error('Audio changed while creating review snapshot');
  const prior=await read(join(entry.root,'review',item.customId+'.json'),null);
  if(validAheadReport(prior,item))await save(join(directory,'review',item.customId+'.json'),prior);
 }
 if(hash(await read(join(directory,'input.json')))!==proof.inputHash)throw Error('Input changed while creating review snapshot');
 return directory;
 }catch(error){await fs.rm(directory,{recursive:true,force:true});throw error;}
}
async function runReview(config,directory){
 await new Promise((done,fail)=>{
  const child=spawn(config.python,[join(here,'review.py'),directory],{env:{...process.env,INWORLD_REVIEW_DEVICE:process.env.INWORLD_REVIEW_DEVICE??'cpu',VECLIB_MAXIMUM_THREADS:'2'},stdio:['ignore','ignore','ignore']});
  child.once('error',fail);child.once('close',code=>code===0?done():fail(Error('Ahead ASR reviewer exited '+code)));
 });
}
async function importReports(config,entry,snapshot,directory){
 const reports={};for(const item of snapshot.items)reports[item.customId]=await read(join(directory,'review',item.customId+'.json'));
 validateAheadMerge(snapshot,await evidence(config,entry),reports);
 await fs.mkdir(join(entry.root,'review'),{recursive:true});let imported=0;
 for(const item of snapshot.items){
  const current=await activity(config,entry);
  if(current.active||current.published)throw Error('Chapter became active or published before report import');
  if(hash(await read(join(entry.root,'input.json')))!==snapshot.inputHash||hash(await read(join(entry.root,'generated.json')))!==snapshot.generatedHash||hash(await itemEvidence(entry,{customId:item.customId,spokenText:item.expected}))!==hash(item))throw Error('Chapter evidence changed before report import');
  // Same-filesystem hard links atomically install only absent reports. A concurrent
  // reviewer always retains ownership of any existing destination, valid or stale.
  try{await fs.link(join(directory,'review',item.customId+'.json'),join(entry.root,'review',item.customId+'.json'));imported++;}
  catch(error){if(error.code!=='EEXIST')throw error;}
 }
 return imported;
}

export async function reviewAhead(path,requested=[],reviewer=runReview){
 process.umask(0o077);
 const saved=await read(path);if(!saved?.root)throw Error('Review-ahead configuration requires a job root');
 const config={...saved,...await read(join(saved.root,'queue.json'),{})};
 if(config.root!==saved.root||!Array.isArray(config.chapters)||typeof config.python!=='string')throw Error('Prepared queue and reviewer Python required');
 await fs.mkdir(join(config.root,'tmp'),{recursive:true});
 const lockPath=join(config.root,'review-ahead.lock'),token=randomUUID();let owns=false;
 const status=async value=>save(join(config.root,'review-ahead-status.json'),{...value,pid:process.pid,updatedAt:new Date().toISOString()});
 try{
  for(let attempt=0;attempt<2;attempt++){
   try{const lock=await fs.open(lockPath,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,token}));await lock.close();owns=true;break;}
   catch(error){if(error.code!=='EEXIST')throw error;const prior=await read(lockPath);try{process.kill(prior.pid,0);throw Error('Ahead reviewer already active');}catch(active){if(active.code!=='ESRCH')throw active;}await fs.unlink(lockPath);}
  }
  if(!owns)throw Error('Could not acquire ahead-review lock');
  const facts={};for(const entry of config.chapters)facts[entry.chapterId]=await evidence(config,entry);
  const entries=planAheadEntries(config.chapters,facts,requested),completed=[],skipped=[];
  const excluded=config.chapters.filter(entry=>!entries.includes(entry)).map(entry=>({chapter:entry.chapterId,reason:facts[entry.chapterId].active?'active':facts[entry.chapterId].published?'published':facts[entry.chapterId].requiresProofReview?'rendering-proof-review':facts[entry.chapterId].reviewsComplete?'reports-complete':!facts[entry.chapterId].generated?'not-generated':'not-requested'}));
  await status({status:'running',selected:entries.map(entry=>entry.chapterId),excluded,completed,skipped});
  for(const entry of entries){
   let directory;
   try{
    const proof=await evidence(config,entry);
    if(!planAheadEntries([entry],{[entry.chapterId]:proof}).length){skipped.push(entry.chapterId);continue;}
    await status({status:'running',stage:'snapshotting',chapter:entry.chapterId,completed,skipped});
    directory=await snapshotEntry(config,entry,proof);
    await status({status:'running',stage:'reviewing',chapter:entry.chapterId,completed,skipped});await reviewer(config,directory);
    const imported=await importReports(config,entry,proof,directory);completed.push({chapter:entry.chapterId,imported});
   }catch(error){skipped.push(entry.chapterId);await status({status:'running',stage:'skipped',chapter:entry.chapterId,reason:safeReason(error),completed,skipped});}
   finally{if(directory)await fs.rm(directory,{recursive:true,force:true});}
  }
  await status({status:'complete',excluded,completed,skipped});return {completed,skipped};
 }catch(error){if(owns)await status({status:'failed',reason:safeReason(error)});throw error;}
 finally{if(owns&&(await read(lockPath,{})).token===token)await fs.unlink(lockPath);}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(!process.argv[2])throw Error('Usage: review-ahead.mjs CONFIG [CHAPTER_ID ...]');
 try{await reviewAhead(resolve(process.argv[2]),process.argv.slice(3));}
 catch{console.error('Ahead review failed; local evidence and paid state were retained.');process.exitCode=1;}
}
