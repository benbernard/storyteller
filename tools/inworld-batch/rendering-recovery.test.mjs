import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {hash,sha,assertBudget} from './core.mjs';
import {repairItems} from './adjudication.mjs';
import {buildRenderingRecoveryPlan,recoverVisualRedactionPassage,canonicalHash,recoveryPolicy,overlayRecoveryPolicy} from './rendering-recovery.mjs';
import {renderVisualRedactions,verifyVisualRedactions} from '../audiobooks/dist/spoken-redactions.js';
import {renderCombiningOverlays,verifyCombiningOverlays} from '../audiobooks/dist/spoken-overlays.js';
import {renderingContext} from './rendering-review.mjs';

const read=async(path,fallback)=>{try{return JSON.parse(await fs.readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT'&&fallback!==undefined)return fallback;throw error;}};
const save=async(path,value)=>{await fs.mkdir(dirname(path),{recursive:true});await fs.writeFile(path,JSON.stringify(value));};
async function fixture(policy=recoveryPolicy){
 const render=policy===overlayRecoveryPolicy?renderCombiningOverlays:renderVisualRedactions,verify=policy===overlayRecoveryPolicy?verifyCombiningOverlays:verifyVisualRedactions;
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-rendering-recovery-')),folder=join(root,'chapter');
 const plain=['😀 The opening sentence preserves every ordinary word and introduces the record with a calm, measured explanation.',
  'The hidden record ██████ remains sealed, while all the visible words around the concealed passage retain their meaning.',
  'The final sentence preserves the rest of this passage so its successful child recording can be reused without another charge.'].join('\n');
 const text=policy===overlayRecoveryPolicy?plain.replace('opening','o\u0334p\u0335ening').replace('██████','s\u0336e\u0337aled\u0338'):plain;
 const voices={narrator:{voiceId:'saved-female'}},item={customId:'s0000p0',role:'narrator',spokenText:text,request:{text:'[read clearly] '+text,modelId:'inworld-tts-2'}};
 const source={text},chapter={chapterId:'rr-fixture',source:sha(text),items:[item],segments:[{uid:'body',role:item.role,text,spans:[{start:0,end:text.length}],items:[item.customId]}]};
 const entry={chapterId:chapter.chapterId,sequence:285,root:folder,inputHash:hash(chapter)};
 const attempt2Plan={passage:item.customId,originalSha256:'prior-attempt-1',originalRequestHash:hash({...item.request,voiceId:voices.narrator.voiceId}),attempt:2,items:repairItems(item,2)};
 const parts=[];let parent=Buffer.alloc(0);
 for(const [index,child]of attempt2Plan.items.entries()){
  const audio=Buffer.from('original-child-'+index),receipt={sha256:sha(audio),duration:1,requestHash:hash({...child.request,voiceId:voices.narrator.voiceId}),voiceId:voices.narrator.voiceId,job:'paid-attempt2-'+index};
  const directory=join(folder,'repairs',item.customId,'attempt-2');await save(join(directory,'receipts',child.customId+'.json'),receipt);await fs.mkdir(join(directory,'audio'),{recursive:true});await fs.writeFile(join(directory,'audio',child.customId+'.wav'),audio);
  parts.push({item:child,receipt,audioSha256:sha(audio)});parent=Buffer.concat([parent,audio]);
 }
 const receipt={sha256:sha(parent),duration:parts.length,requestHash:attempt2Plan.originalRequestHash,voiceId:voices.narrator.voiceId,job:'initial-paid',repair:{attempt:2,planHash:hash(attempt2Plan),parts:parts.map(part=>({id:part.item.customId,sha256:part.receipt.sha256,job:part.receipt.job})),previousSha256:'prior-attempt-1'}};
 await save(join(folder,'input.json'),chapter);await save(join(folder,'source.json'),source);await save(join(folder,'receipts',item.customId+'.json'),receipt);
 await save(join(folder,'repairs',item.customId,'attempt-2','plan.json'),attempt2Plan);
 await save(join(folder,'review',item.customId+'.json'),{sha256:receipt.sha256,expected:text,severity:'major'});
 await save(join(folder,'processing.json'),{status:'needs-review',passages:[item.customId]});
 await fs.mkdir(join(folder,'audio'));await fs.writeFile(join(folder,'audio',item.customId+'.wav'),parent);
 const config={root,maxRetakes:2,ceilingUSD:50},args={entry,chapter,item,source,receipt,attempt2Plan,parts,render,verify,policy};
 let paid=0;
 const synthesize=async(recoveryEntry,recoveryChapter,providedVoices,options)=>{
  assert.deepEqual(providedVoices,voices);assert.equal(options.maxSubmissionsPerItem,1);
  for(const child of recoveryChapter.items){
   const ledger=await read(join(root,'jobs.json'),[]),prior=ledger.find(job=>job.items[0].customId===child.customId);
   if(prior?.phase==='submitting')throw Error('Ambiguous submission retained');
   if(prior)continue;
   const characters=child.request.text.length;assertBudget(ledger,characters,config.ceilingUSD);
   paid++;const job={id:'migration-paid-'+paid,outputRoot:recoveryEntry.root,chapter:entry.chapterId,phase:'complete',items:[child],reservedUSD:characters*20/1e6};await save(join(root,'jobs.json'),[...ledger,job]);
   const audio=Buffer.from('new-redacted-child-'+child.customId);
   await save(join(recoveryEntry.root,'receipts',child.customId+'.json'),{sha256:sha(audio),duration:1,requestHash:hash({...child.request,voiceId:voices.narrator.voiceId}),voiceId:voices.narrator.voiceId,job:job.id});
   await fs.mkdir(join(recoveryEntry.root,'audio'),{recursive:true});await fs.writeFile(join(recoveryEntry.root,'audio',child.customId+'.wav'),audio);
  }
 };
 const run=async(command,arguments_)=>{
  if(command==='ffprobe')return String(parts.length);
  assert.equal(command,'ffmpeg');const list=await fs.readFile(arguments_[arguments_.indexOf('-i')+1],'utf8'),buffers=[];
  for(const line of list.split('\n'))buffers.push(await fs.readFile(line.slice(6,-1)));
  await fs.writeFile(arguments_.at(-1),Buffer.concat(buffers));return '';
 };
 const recovery={entry,chapter,item,config,read,save,run,synthesize,voices,status:async()=>{},render,verify,policy};
 return {root,folder,args,recovery,paid:()=>paid};
}
test('recovery derives exact UTF-16 source ranges and reuses all unaffected attempt-2 children',async()=>{
 const job=await fixture();
 try{
  const plan=buildRenderingRecoveryPlan(job.args),block=job.args.source.text.indexOf('██████');
  assert.deepEqual(plan.sourceRanges,[{itemStart:block,itemEnd:block+6,sourceStart:block,sourceEnd:block+6}]);
  assert.ok(plan.parts.some(part=>part.reused));assert.equal(plan.parts.filter(part=>!part.reused).length,1);
  assert.equal(plan.renderingProof.text,job.args.item.spokenText.replace('██████','redacted'));
  for(const part of plan.parts){if(part.reused)assert.equal(part.replacement,null);else{assert.equal(part.id,part.originalId+'vr1');assert.equal(part.replacement.role,job.args.item.role);assert.ok(!part.replacement.request.text.includes('█'));}}
  assert.throws(()=>buildRenderingRecoveryPlan({...job.args,source:{text:job.args.source.text.replace('██████','█████')}}),/source|coverage/i);
  assert.throws(()=>buildRenderingRecoveryPlan({...job.args,receipt:{...job.args.receipt,repair:{...job.args.receipt.repair,attempt:1}}}),/attempt-2/);
  const changed=structuredClone(job.args.parts);changed[0].item.spokenText='omitted';assert.throws(()=>buildRenderingRecoveryPlan({...job.args,parts:changed}),/child evidence changed/);
  const {render,verify,...serial}=job.args,wrongRole={...structuredClone(serial),render,verify};
  wrongRole.attempt2Plan.items[0].role='another-role';wrongRole.parts[0].item.role='another-role';wrongRole.receipt.repair.planHash=hash(wrongRole.attempt2Plan);
  assert.throws(()=>buildRenderingRecoveryPlan(wrongRole),/immutable role/);
 }finally{await fs.rm(job.root,{recursive:true,force:true});}
});
test('manual recovery owns the chapter review lock so concurrent process-only cannot assemble mixed audio',async()=>{
 const job=await fixture();let child;
 try{
  const bin=join(job.root,'bin');await fs.mkdir(bin);
  await save(join(job.root,'voices.json'),job.recovery.voices);await save(join(job.root,'voice-profiles.json'),{});
  await save(join(job.folder,'generated.json'),{chapter:job.args.entry.chapterId,inputHash:job.args.entry.inputHash,items:1});
  await save(join(job.root,'queue.json'),{...job.recovery.config,host:'fixture',archive:'/fixture',chapters:[job.args.entry],originalVoices:job.recovery.voices,maxBatchCharacters:9500});
  await fs.writeFile(join(bin,'ssh'),`#!/usr/bin/env node
const fs=require('fs');let input='';process.stdin.on('data',data=>input+=data);process.stdin.on('end',async()=>{JSON.parse(input);fs.writeFileSync(process.env.ACTIVE,'blocked');while(!fs.existsSync(process.env.RELEASE))await new Promise(done=>setTimeout(done,10));console.log(JSON.stringify({status:400,body:{error:'fixture rejection'}}));});`,{mode:0o755});
  const env={...process.env,PATH:bin+':'+process.env.PATH,ACTIVE:join(job.root,'active'),RELEASE:join(job.root,'release')},runner=resolve('tools/inworld-batch/runner.mjs');
  child=spawn(process.execPath,[runner,join(job.root,'queue.json'),'--recover-rendering',job.args.entry.chapterId,job.args.item.customId],{env,stdio:'ignore'});
  const finished=new Promise(done=>child.once('close',done)),end=Date.now()+10000;
  while(!await fs.access(env.ACTIVE).then(()=>true,()=>false)){if(Date.now()>end)throw Error('Recovery did not reach the controlled provider call');await new Promise(done=>setTimeout(done,20));}
  const lockPath=join(job.folder,'owner-review.lock');assert.equal(Number(await fs.readFile(lockPath,'utf8')),child.pid);
  const concurrent=spawnSync(process.execPath,[runner,join(job.root,'queue.json'),'--process-only',job.args.entry.chapterId],{env,encoding:'utf8',timeout:10000});
  assert.equal(concurrent.status,1);assert.equal(Number(await fs.readFile(lockPath,'utf8')),child.pid);assert.equal(await read(join(job.folder,'assembly.json'),null),null);
  await fs.writeFile(env.RELEASE,'continue');assert.equal(await finished,1);
  assert.equal(await fs.access(lockPath).then(()=>true,()=>false),false);
 }finally{child?.kill();await fs.rm(job.root,{recursive:true,force:true});}
});
test('one migration keeps input, source, attempt counter and good child audio immutable, then still requires fidelity review',async()=>{
 const job=await fixture();
 try{
  const originals=await Promise.all(['input.json','source.json','processing.json'].map(name=>fs.readFile(join(job.folder,name))));
  const plan=buildRenderingRecoveryPlan(job.args),good=plan.parts.filter(part=>part.reused),goodAudio=await Promise.all(good.map(part=>fs.readFile(join(job.folder,part.root,'audio',part.id+'.wav'))));
  assert.equal(await recoverVisualRedactionPassage(job.recovery),true);assert.equal(job.paid(),1);
  const next=await read(join(job.folder,'receipts',job.args.item.customId+'.json'));
  assert.equal(next.repair.attempt,2);assert.deepEqual(next.repair,job.args.receipt.repair);assert.equal(next.requestHash,job.args.receipt.requestHash);
  assert.equal(next.renderingRecovery.planHash,canonicalHash(plan));assert.equal(next.renderingRecovery.audioSha256,next.sha256);
  assert.equal(await recoverVisualRedactionPassage(job.recovery),false);assert.equal(job.paid(),1);
  for(const [index,name]of ['input.json','source.json','processing.json'].entries())assert.deepEqual(await fs.readFile(join(job.folder,name)),originals[index]);
  for(const [index,part]of good.entries())assert.deepEqual(await fs.readFile(join(job.folder,part.root,'audio',part.id+'.wav')),goodAudio[index]);
  assert.equal(await read(join(job.folder,'assembly.json'),null),null);
 }finally{await fs.rm(job.root,{recursive:true,force:true});}
});
test('ambiguous migration preserves reservation and cannot submit the replacement again',async()=>{
 const job=await fixture();let submits=0;
 try{
  const synthesize=async(entry,chapter)=>{
   const ledger=await read(join(job.root,'jobs.json'),[]);if(ledger.length)throw Error('Ambiguous submission retained');
   submits++;await save(join(job.root,'jobs.json'),[{phase:'submitting',reservedUSD:0.01,id:'uncertain',items:chapter.items}]);throw Error('Ambiguous submission retained');
  };
  await assert.rejects(recoverVisualRedactionPassage({...job.recovery,synthesize}),/Ambiguous/);
  const before=await fs.readFile(join(job.root,'jobs.json'));await assert.rejects(recoverVisualRedactionPassage({...job.recovery,synthesize}),/Ambiguous/);
  assert.equal(submits,1);assert.deepEqual(await fs.readFile(join(job.root,'jobs.json')),before);
  assert.equal((await read(join(job.folder,'receipts',job.args.item.customId+'.json'))).sha256,job.args.receipt.sha256);
 }finally{await fs.rm(job.root,{recursive:true,force:true});}
});
test('promotion interrupted between audio and receipt resumes the exact saved replacement without another charge',async()=>{
 const job=await fixture();let crash=true;
 try{
  const failingSave=async(path,value)=>{if(path===join(job.folder,'receipts',job.args.item.customId+'.json')&&crash){crash=false;throw Error('power loss');}await save(path,value);};
  await assert.rejects(recoverVisualRedactionPassage({...job.recovery,save:failingSave}),/power loss/);
  assert.equal(job.paid(),1);assert.equal((await read(join(job.folder,'receipts',job.args.item.customId+'.json'))).sha256,job.args.receipt.sha256);
  assert.equal(await recoverVisualRedactionPassage(job.recovery),true);assert.equal(job.paid(),1);
  const next=await read(join(job.folder,'receipts',job.args.item.customId+'.json'));assert.equal(next.sha256,sha(await fs.readFile(join(job.folder,'audio',job.args.item.customId+'.wav'))));
 }finally{await fs.rm(job.root,{recursive:true,force:true});}
});
test('migration uses the shared ceiling and refuses a published or unheld target',async()=>{
 const job=await fixture();
 try{
  await save(join(job.root,'jobs.json'),[{phase:'submitting',reservedUSD:50,items:[{customId:'unrelated'}]}]);
  await assert.rejects(recoverVisualRedactionPassage(job.recovery),/spending ceiling/i);assert.equal(job.paid(),0);
  await save(join(job.folder,'published.json'),{assembly:'immutable'});await assert.rejects(recoverVisualRedactionPassage(job.recovery),/published audio is immutable/);
  await fs.unlink(join(job.folder,'published.json'));await save(join(job.folder,'processing.json'),{status:'published'});await assert.rejects(recoverVisualRedactionPassage(job.recovery),/held for fidelity/);
 }finally{await fs.rm(job.root,{recursive:true,force:true});}
});
test('manual recovery refuses an active supervisor before provider calls or book mutations',async()=>{
 const job=await fixture();
 try{
  const before=await fs.readFile(join(job.folder,'input.json'));
  await save(join(job.root,'queue.json'),{...job.recovery.config,chapters:[job.args.entry],originalVoices:{narrator:{voiceId:'saved-female'}}});await fs.writeFile(join(job.root,'supervisor.lock'),String(process.pid));
  const result=spawnSync(process.execPath,[resolve('tools/inworld-batch/runner.mjs'),join(job.root,'queue.json'),'--recover-rendering',job.args.entry.chapterId,job.args.item.customId],{encoding:'utf8',timeout:10000});
  assert.equal(result.status,1);assert.match((await read(join(job.root,'rendering-recovery-status.json'))).reason,/idle stopped supervisor/);
  assert.deepEqual(await fs.readFile(join(job.folder,'input.json')),before);assert.equal(await read(join(job.root,'jobs.json'),null),null);
 }finally{await fs.rm(job.root,{recursive:true,force:true});}
});
test('manual migration permits only one child submission even when its provider result fails and the command restarts',async()=>{
 const job=await fixture();
 try{
  const bin=join(job.root,'bin');await fs.mkdir(bin);
  await save(join(job.root,'voices.json'),job.recovery.voices);await save(join(job.root,'voice-profiles.json'),{});
  await save(join(job.root,'queue.json'),{...job.recovery.config,host:'fixture',archive:'/fixture',chapters:[job.args.entry],originalVoices:job.recovery.voices,maxBatchCharacters:9500});
  await fs.writeFile(join(bin,'rsync'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  await fs.writeFile(join(bin,'ssh'),`#!/usr/bin/env node
const fs=require('fs');let input='';process.stdin.on('data',data=>input+=data);process.stdin.on('end',()=>{const request=JSON.parse(input);fs.appendFileSync(process.env.CALLS,JSON.stringify(request)+'\\n');console.log(JSON.stringify({status:200,body:{name:'operations/migration',done:true,response:{resultsUri:'https://fixture/results'}}}));});`,{mode:0o755});
  const preload=join(job.root,'fetch.mjs');await fs.writeFile(preload,`import fs from 'node:fs';globalThis.fetch=async()=>{const calls=fs.readFileSync(process.env.CALLS,'utf8').trim().split('\\n').map(JSON.parse);return new Response(JSON.stringify({results:calls.at(-1).body.items.map(item=>({customId:item.customId,error:{code:3}}))}));};`);
  const launch=()=>spawnSync(process.execPath,['--import',preload,resolve('tools/inworld-batch/runner.mjs'),join(job.root,'queue.json'),'--recover-rendering',job.args.entry.chapterId,job.args.item.customId],{env:{...process.env,PATH:bin+':'+process.env.PATH,CALLS:join(job.root,'calls')},encoding:'utf8',timeout:10000});
  assert.equal(launch().status,1);assert.equal(launch().status,1);
  const calls=(await fs.readFile(join(job.root,'calls'),'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.length,1);
  const ledger=await read(join(job.root,'jobs.json'));assert.equal(ledger.length,1);assert.equal(ledger[0].phase,'complete');assert.ok(ledger[0].reservedUSD>0);
  assert.match((await read(join(job.root,'rendering-recovery-status.json'))).reason,/retry limit/);
  assert.equal((await read(join(job.folder,'receipts',job.args.item.customId+'.json'))).sha256,job.args.receipt.sha256);
 }finally{await fs.rm(job.root,{recursive:true,force:true});}
});


test('overlay migration removes only exact styling, retains unrelated children, and binds full-parent QA context',async()=>{
 const job=await fixture(overlayRecoveryPolicy);
 try{
  const input=await fs.readFile(join(job.folder,'input.json')),source=await fs.readFile(join(job.folder,'source.json'));
  const plan=buildRenderingRecoveryPlan(job.args),affected=plan.parts.filter(part=>!part.reused);
  assert.equal(affected.length,2);assert.ok(plan.parts.some(part=>part.reused));
  for(const part of affected){assert.equal(part.id,part.originalId+'co1');assert.equal(part.replacement.role,'narrator');assert.ok(!/[\u0334-\u0338]/u.test(part.replacement.spokenText));}
  assert.equal(plan.renderingProof.text,job.args.item.spokenText.replace(/[\u0334-\u0338]/gu,''));
  assert.equal(await recoverVisualRedactionPassage(job.recovery),true);assert.equal(job.paid(),2);
  assert.equal(await recoverVisualRedactionPassage(job.recovery),false);assert.equal(job.paid(),2);
  const receipt=await read(join(job.folder,'receipts',job.args.item.customId+'.json'));
  assert.equal(receipt.repair.attempt,2);assert.deepEqual(receipt.repair,job.args.receipt.repair);
  const context=await renderingContext(job.folder,job.args.item);
  assert.equal(context.comparisonExpected,plan.renderingProof.text);assert.equal(context.renderingProof.policy,overlayRecoveryPolicy);assert.equal(context.audioSha256,receipt.sha256);
  assert.deepEqual(await fs.readFile(join(job.folder,'input.json')),input);assert.deepEqual(await fs.readFile(join(job.folder,'source.json')),source);
  const changed=structuredClone(plan);changed.parts[0].renderingProof.text+=' omitted';
  await save(join(job.folder,receipt.renderingRecovery.planPath),changed);
  await assert.rejects(renderingContext(job.folder,job.args.item),/receipt|plan|source/i);
 }finally{await fs.rm(job.root,{recursive:true,force:true});}
});

test('overlay recovery restart preserves ambiguous paid reservations and a hard one-submission allowance',async()=>{
 const job=await fixture(overlayRecoveryPolicy);let submissions=0;
 try{
  const synthesize=async(entry,chapter,voices,options)=>{
   assert.equal(options.maxSubmissionsPerItem,1);
   const ledger=await read(join(job.root,'jobs.json'),[]);if(ledger.length)throw Error('Unknown accepted operation remains reserved');
   submissions++;await save(join(job.root,'jobs.json'),[{phase:'submitting',reservedUSD:.01,items:chapter.items}]);throw Error('Unknown accepted operation remains reserved');
  };
  await assert.rejects(recoverVisualRedactionPassage({...job.recovery,synthesize}),/remains reserved/);
  const ledger=await fs.readFile(join(job.root,'jobs.json'));
  await assert.rejects(recoverVisualRedactionPassage({...job.recovery,synthesize}),/remains reserved/);
  assert.equal(submissions,1);assert.deepEqual(await fs.readFile(join(job.root,'jobs.json')),ledger);
  assert.equal((await read(join(job.folder,'receipts',job.args.item.customId+'.json'))).sha256,job.args.receipt.sha256);
 }finally{await fs.rm(job.root,{recursive:true,force:true});}
});

test('overlay promotion crash resumes once and respects the unchanged shared ceiling',async()=>{
 const job=await fixture(overlayRecoveryPolicy);let crash=true;
 try{
  await save(join(job.root,'jobs.json'),[{phase:'submitting',reservedUSD:50,items:[{customId:'other-book-item'}]}]);
  await assert.rejects(recoverVisualRedactionPassage(job.recovery),/spending ceiling/i);assert.equal(job.paid(),0);
  await save(join(job.root,'jobs.json'),[]);
  const failingSave=async(path,value)=>{if(path===join(job.folder,'receipts',job.args.item.customId+'.json')&&crash){crash=false;throw Error('interrupted promotion');}await save(path,value);};
  await assert.rejects(recoverVisualRedactionPassage({...job.recovery,save:failingSave}),/interrupted promotion/);
  assert.equal(job.paid(),2);
  assert.equal(await recoverVisualRedactionPassage(job.recovery),true);assert.equal(job.paid(),2);
  assert.equal(await recoverVisualRedactionPassage(job.recovery),false);assert.equal(job.paid(),2);
  const receipt=await read(join(job.folder,'receipts',job.args.item.customId+'.json'));
  assert.equal(receipt.sha256,sha(await fs.readFile(join(job.folder,'audio',job.args.item.customId+'.wav'))));assert.equal(receipt.repair.attempt,2);
 }finally{await fs.rm(job.root,{recursive:true,force:true});}
});
