import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {hash} from './core.mjs';
import {batchWindowSize,classifyBatchResponse,runBatchWindow,reconcileBatchJobs} from './batch-window.mjs';

test('only explicit client rejections release reservations and operation evidence is never discarded',()=>{
 for(const status of [400,401,402,403,404,405,413,415,422,429])assert.equal(classifyBatchResponse({status,body:{}}).state,'rejected');
 for(const status of [200,301,408,409,500,503,504])assert.equal(classifyBatchResponse({status,body:{}}).state,'uncertain');
 for(const status of [400,408,503]){
  const result=classifyBatchResponse({status,body:{operation:{name:'operations/known',done:false}}});
  assert.equal(result.state,'accepted');assert.equal(result.hold,true);assert.equal(result.operation.name,'operations/known');
 }
});

test('provider window submits three jobs before settling them, with no concurrent ledger writes',async()=>{
 const events=[];let writing=false;
 assert.equal(batchWindowSize(),3);for(const invalid of [0,4,1.5])assert.throws(()=>batchWindowSize(invalid));
 const completed=await runBatchWindow(['a','b','c'],{
  submit:async id=>{assert.equal(writing,false);writing=true;await Promise.resolve();events.push('submit '+id);writing=false;return {id};},
  finish:async job=>{assert.equal(writing,false);events.push('finish '+job.id);},
 });
 assert.equal(completed,true);assert.deepEqual(events,['submit a','submit b','submit c','finish a','finish b','finish c']);
});
test('ambiguous submissions, polling failures and pause still settle every known accepted operation',async()=>{
 const events=[];
 await assert.rejects(runBatchWindow(['a','b','c','d'],{
  submit:async id=>{events.push('submit '+id);if(id==='c')throw Error('ambiguous third');return {id};},
  finish:async job=>{events.push('finish '+job.id);if(job.id==='a')throw Error('poll unavailable');},
 }),/ambiguous third/);
 assert.deepEqual(events,['submit a','submit b','submit c','finish a','finish b']);
 const recovered=[];
 await assert.rejects(reconcileBatchJobs([{phase:'submitting'},{phase:'accepted',operation:{name:'known'}},{phase:'complete'}],async job=>recovered.push(job.operation.name)),/Ambiguous/);
 assert.deepEqual(recovered,['known']);
 await assert.rejects(reconcileBatchJobs([{phase:'rejected',rejection:{status:503,body:{error:'Uncertain'}}}],()=>assert.fail('Historical ambiguous rejection must not be resubmitted or reset')),/historical batch rejection/);
 let paused=false;const settled=[];
 assert.equal(await runBatchWindow(['a','b'],{shouldPause:async()=>paused,submit:async id=>{paused=true;return {id};},finish:async job=>settled.push(job.id)}),false);
 assert.deepEqual(settled,['a']);
});

const write=async(path,value)=>fs.writeFile(path,JSON.stringify(value));
for(const mode of ['pause','ambiguous','server-error','error-operation','credit-item','budget'])test(`runner ${mode} keeps one bounded paid ledger and reconciles its accepted window`,async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-window-')),bin=join(root,'bin'),folder=join(root,'chapter');await fs.mkdir(bin);await fs.mkdir(folder);
 const input={chapterId:'a',items:['Hello','World','Third','Forth'].map((text,index)=>({customId:'p'+index,role:'narrator',spokenText:text,request:{text}}))};
 const entry={chapterId:'a',sequence:1,root:folder,inputHash:hash(input)},voices={narrator:{voiceId:'saved-female'}};
 await write(join(folder,'input.json'),input);await write(join(root,'voices.json'),voices);await write(join(root,'voice-profiles.json'),{});
 await write(join(root,'queue.json'),{root,host:'fixture',archive:'/fixture',selectedChapterIds:['a'],preparationComplete:true,chapters:[entry],originalVoices:voices,ceilingUSD:mode==='budget'?0.00025:1,maxBatchCharacters:5,maxRetakes:2,pollSeconds:30});
 await fs.writeFile(join(bin,'rsync'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 await fs.writeFile(join(bin,'ffprobe'),'#!/bin/sh\necho \'{"format":{"duration":"1"},"streams":[{"channels":1,"sample_rate":"48000"}]}\'\n',{mode:0o755});
 await fs.writeFile(join(bin,'ssh'),`#!/usr/bin/env node
const fs=require('fs');let input='';process.stdin.on('data',data=>input+=data);process.stdin.on('end',()=>{
 if(!input)return;const request=JSON.parse(input);fs.appendFileSync(process.env.CALLS,JSON.stringify(request)+'\\n');
 const calls=fs.readFileSync(process.env.CALLS,'utf8').trim().split('\\n').map(JSON.parse),posts=calls.filter(row=>row.method==='POST');
 if(request.method==='POST'){
  if(process.env.MODE==='ambiguous'&&posts.length===3)process.exit(1);
  if(process.env.MODE==='server-error'&&posts.length===3){console.log(JSON.stringify({status:503,body:{error:'Uncertain provider failure'}}));return;}
  if(process.env.MODE==='error-operation'&&posts.length===3){console.log(JSON.stringify({status:503,body:{operation:{name:'operations/3',done:false}}}));return;}
  if(process.env.MODE==='pause'&&posts.length===3)fs.writeFileSync(process.env.PAUSE,'upgrade');
  console.log(JSON.stringify({status:200,body:{name:'operations/'+posts.length,done:false}}));
 }else{const id=request.path.split('/').at(-1);console.log(JSON.stringify({status:200,body:{name:'operations/'+id,done:true,response:{resultsUri:'https://fixture/results/'+id}}}));}
});`,{mode:0o755});
 const preload=join(root,'fetch.mjs');await fs.writeFile(preload,`import fs from 'node:fs';globalThis.fetch=async url=>{
 const path=new URL(url).pathname;if(!path.startsWith('/results/'))return new Response(new Uint8Array(64));
 const posts=fs.readFileSync(process.env.CALLS,'utf8').trim().split('\\n').map(JSON.parse).filter(row=>row.method==='POST');
 const job=Number(path.split('/').at(-1));return new Response(JSON.stringify({results:posts[job-1].body.items.map(item=>process.env.MODE==='credit-item'&&job===1?{customId:item.customId,error:{code:8}}:{customId:item.customId,audioUri:'https://fixture/audio/'+item.customId})}));
};`);
 const env={...process.env,PATH:bin+':'+process.env.PATH,CALLS:join(root,'calls'),PAUSE:join(root,'pause.requested'),MODE:mode};
 const run=()=>spawnSync(process.execPath,['--import',preload,resolve('tools/inworld-batch/runner.mjs'),join(root,'queue.json')],{env,encoding:'utf8',timeout:15000});
 try{
  const first=run();assert.equal(first.status,0,first.stderr);
  let calls=(await fs.readFile(env.CALLS,'utf8')).trim().split('\n').map(JSON.parse),ledger=JSON.parse(await fs.readFile(join(root,'jobs.json'),'utf8'));
  const count=mode==='budget'?2:3;assert.equal(calls.filter(row=>row.method==='POST').length,count);
  assert.deepEqual(calls.slice(0,count).map(row=>row.method),Array(count).fill('POST'));
  assert.equal(new Set(ledger.flatMap(job=>job.items.map(item=>item.customId))).size,count);
  assert.equal(ledger.length,count);assert.ok(ledger.every(job=>job.reservedUSD===0.0001));
  if(['ambiguous','server-error','error-operation','credit-item'].includes(mode)){
   assert.deepEqual(ledger.map(job=>job.phase),['ambiguous','server-error'].includes(mode)?['complete','complete','submitting']:['complete','complete','complete']);
   if(mode==='server-error')assert.equal(ledger[2].submissionResponse.status,503);
   if(mode==='error-operation')assert.equal(ledger[2].submissionBlockingError.operation,'operations/3');
   if(mode==='credit-item'){
    assert.deepEqual(ledger[0].terminalBlockingError.codes,[8]);
    // Older runtime jobs have only results evidence; those must also block replay.
    delete ledger[0].terminalBlockingError;await write(join(root,'jobs.json'),ledger);
   }
   const before=ledger.map(job=>({id:job.id,reservedUSD:job.reservedUSD}));assert.equal(run().status,0);
   calls=(await fs.readFile(env.CALLS,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.filter(row=>row.method==='POST').length,3);
   ledger=JSON.parse(await fs.readFile(join(root,'jobs.json'),'utf8'));assert.deepEqual(ledger.map(job=>({id:job.id,reservedUSD:job.reservedUSD})),before);
  }else assert.ok(ledger.every(job=>job.phase==='complete'));
  assert.equal(calls.filter(row=>row.method==='GET').length,['ambiguous','server-error'].includes(mode)?2:count);
  const status=JSON.parse(await fs.readFile(join(root,'status.json'),'utf8'));assert.equal(status.status,mode==='pause'?'paused':'held');
  if(mode==='budget')assert.match(status.reason,/spending ceiling/i);
  assert.equal(await fs.access(join(folder,'generated.json')).then(()=>true,()=>false),false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('invalid window size fails before a new character can incur a voice preview charge',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-invalid-window-')),bin=join(root,'bin'),folder=join(root,'chapter');await fs.mkdir(bin);await fs.mkdir(folder);
 const chapter={chapterId:'a',items:[{customId:'p0',role:'new-character',spokenText:'Hello',request:{text:'Hello'}}]};
 await write(join(folder,'input.json'),chapter);await write(join(root,'voices.json'),{narrator:{voiceId:'saved-female'}});await write(join(root,'voice-profiles.json'),{'new-character':{designPrompt:'A clear female voice.',previewText:'Hello.'}});
 await write(join(root,'queue.json'),{root,host:'fixture',archive:'/fixture',chapters:[{chapterId:'a',root:folder,inputHash:hash(chapter)}],originalVoices:{narrator:{voiceId:'saved-female'}},maxInFlightBatches:4});
 await fs.writeFile(join(bin,'ssh'),'#!/bin/sh\ntouch "$CALLS"\nexit 1\n',{mode:0o755});
 try{
  const run=spawnSync(process.execPath,[resolve('tools/inworld-batch/runner.mjs'),join(root,'queue.json')],{env:{...process.env,PATH:bin+':'+process.env.PATH,CALLS:join(root,'calls')},encoding:'utf8',timeout:10000});
  assert.equal(run.status,1);assert.match(run.stderr,/In-flight batch limit/);assert.equal(await fs.access(join(root,'calls')).then(()=>true,()=>false),false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
