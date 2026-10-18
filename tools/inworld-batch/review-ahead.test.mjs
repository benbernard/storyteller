import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {hash,sha} from './core.mjs';
import {planAheadEntries,validAheadReport,validateAheadMerge,reviewAhead} from './review-ahead.mjs';

const write=async(path,value)=>{await fs.mkdir(dirname(path),{recursive:true});await fs.writeFile(path,JSON.stringify(value));};
const report=(audio,expected)=>({sha256:sha(audio),expected,attempts:[{model:'test',transcript:expected,changes:[],wordRecall:1,major:false}],severity:'pass'});
test('ahead planning selects only fully generated inactive queued chapters needing reports',()=>{
 const entries=['ready','future','active','published','complete','recovered'].map(chapterId=>({chapterId,inputHash:'input'}));
 const facts=Object.fromEntries(entries.map(entry=>[entry.chapterId,{generated:true,inputHash:'input'}]));
 facts.future.generated=false;facts.active.active=true;facts.published.published=true;facts.complete.reviewsComplete=true;facts.recovered.requiresProofReview=true;
 assert.deepEqual(planAheadEntries(entries,facts).map(entry=>entry.chapterId),['ready']);
 assert.deepEqual(planAheadEntries(entries,facts,['future']),[]);
 assert.throws(()=>planAheadEntries(entries,facts,['unknown']),/not in the prepared queue/);
});
test('ahead merge requires exact audio, receipt, source and generated evidence plus complete valid reports',()=>{
 const audio=Buffer.from('audio'),item={customId:'p0',expected:'Expected',audioSha256:sha(audio),receiptHash:'receipt'};
 const snapshot={inputHash:'input',generatedHash:'generated',items:[item]},reports={p0:report(audio,'Expected')};
 assert.deepEqual(validateAheadMerge(snapshot,snapshot,reports),['p0']);
 for(const current of [{...snapshot,active:true},{...snapshot,published:true},{...snapshot,inputHash:'changed'},{...snapshot,generatedHash:'changed'},{...snapshot,items:[{...item,receiptHash:'changed'}]},{...snapshot,items:[{...item,audioSha256:'changed'}]}])assert.throws(()=>validateAheadMerge(snapshot,current,reports));
 assert.throws(()=>validateAheadMerge(snapshot,snapshot,{}));
 assert.throws(()=>validateAheadMerge(snapshot,{...snapshot,requiresProofReview:true},reports),/full live proof chain/);
 assert.equal(validAheadReport({...reports.p0,expected:'changed'},item),false);
 assert.equal(validAheadReport({...reports.p0,attempts:[]},item),false);
});

async function fixture(){
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-review-ahead-')),entries=[],proofs={};
 for(const id of ['a','b','future']){
  const folder=join(root,id),audio=Buffer.from('audio-'+id),chapter={chapterId:id,source:'source-'+id,items:[{customId:'p0',spokenText:'Expected '+id}]};
  const entry={chapterId:id,root:folder,inputHash:hash(chapter)};entries.push(entry);
  await write(join(folder,'input.json'),chapter);
  if(id!=='future'){
   await write(join(folder,'generated.json'),{chapter:id,inputHash:entry.inputHash,items:1});
   await write(join(folder,'receipts/p0.json'),{sha256:sha(audio),job:'paid-'+id});
   await fs.mkdir(join(folder,'audio'));await fs.writeFile(join(folder,'audio/p0.wav'),audio);
  }
  proofs[id]={audio,chapter};
 }
 await write(join(root,'config.json'),{root,python:'/unused/reviewer'});await write(join(root,'queue.json'),{root,python:'/unused/reviewer',chapters:entries});
 await write(join(root,'processing-status.json'),{status:'running',chapter:'a'});
 const reviewer=async(config,directory)=>{
  assert.equal(config.root,root);assert.notEqual(directory,join(root,'b'));
  const input=JSON.parse(await fs.readFile(join(directory,'input.json'),'utf8'));
  for(const item of input.items){const audio=await fs.readFile(join(directory,'audio',item.customId+'.wav'));await write(join(directory,'review',item.customId+'.json'),report(audio,item.spokenText));}
 };
 return {root,entries,proofs,reviewer,path:join(root,'config.json')};
}
test('ahead review uses isolated immutable audio, imports missing reports and leaves paid state untouched',async()=>{
 const job=await fixture();
 try{
  const ledger={held:'never touch'};await write(join(job.root,'jobs.json'),ledger);
  const result=await reviewAhead(job.path,[],async(config,directory)=>{
   const snapshotAudio=join(directory,'audio/p0.wav'),original=join(job.root,'b/audio/p0.wav');
   assert.notEqual((await fs.stat(snapshotAudio)).ino,(await fs.stat(original)).ino);
   assert.equal((await fs.stat(snapshotAudio)).mode&0o222,0);await job.reviewer(config,directory);
  });
  assert.deepEqual(result,{completed:[{chapter:'b',imported:1}],skipped:[]});
  assert.deepEqual(JSON.parse(await fs.readFile(join(job.root,'b/review/p0.json'),'utf8')),report(job.proofs.b.audio,'Expected b'));
  assert.deepEqual(JSON.parse(await fs.readFile(join(job.root,'jobs.json'),'utf8')),ledger);
  assert.equal(await fs.access(join(job.root,'a/review/p0.json')).then(()=>true,()=>false),false);
  assert.deepEqual(await fs.readdir(join(job.root,'tmp')),[]);
  const again=await reviewAhead(job.path,[],()=>assert.fail('Complete reports must not be recomputed'));assert.deepEqual(again.completed,[]);
 }finally{await fs.rm(job.root,{recursive:true,force:true});}
});
for(const race of ['active','audio','receipt','input','existing'])test(`ahead review safely handles ${race} changing while ASR runs`,async()=>{
 const job=await fixture();
 try{
  const existing={...report(job.proofs.b.audio,'Expected b'),owner:'existing-reviewer'};
  const result=await reviewAhead(job.path,['b'],async(config,directory)=>{
   await job.reviewer(config,directory);
   if(race==='active')await write(join(job.root,'processing-status.json'),{chapter:'b',status:'running'});
   if(race==='audio')await fs.writeFile(join(job.root,'b/audio/p0.wav'),'changed audio');
   if(race==='receipt')await write(join(job.root,'b/receipts/p0.json'),{sha256:sha(job.proofs.b.audio),job:'different-paid-evidence'});
   if(race==='input')await write(join(job.root,'b/input.json'),{...job.proofs.b.chapter,source:'changed'});
   if(race==='existing')await write(join(job.root,'b/review/p0.json'),existing);
  });
  if(race==='existing'){
   assert.deepEqual(result.completed,[{chapter:'b',imported:0}]);assert.deepEqual(JSON.parse(await fs.readFile(join(job.root,'b/review/p0.json'),'utf8')),existing);
  }else{assert.deepEqual(result.skipped,['b']);assert.equal(await fs.access(join(job.root,'b/review/p0.json')).then(()=>true,()=>false),false);}
 }finally{await fs.rm(job.root,{recursive:true,force:true});}
});
test('one ahead worker owns its lock and owner-review locks exclude chapters',async()=>{
 const job=await fixture();
 try{
  await write(join(job.root,'review-ahead.lock'),{pid:process.pid,token:'another-worker'});
  await assert.rejects(reviewAhead(job.path,[],()=>assert.fail('No concurrent reviewer')),/already active/);
  await fs.unlink(join(job.root,'review-ahead.lock'));await fs.writeFile(join(job.root,'b/owner-review.lock'),String(process.pid));
  const result=await reviewAhead(job.path,[],()=>assert.fail('Owner-reviewed chapter must not be selected'));assert.deepEqual(result.completed,[]);
 }finally{await fs.rm(job.root,{recursive:true,force:true});}
});
