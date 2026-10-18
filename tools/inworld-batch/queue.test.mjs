import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {hash} from './core.mjs';
import {validateQueueUpdate,queuePreparationComplete,archiveExcludes} from './queue.mjs';

const chapter=(id,index)=>({chapterId:id,sequence:index,root:'/chapters/'+index,inputHash:'hash-'+id});
const empty=()=>({root:'/job',ceilingUSD:50,selectedChapterIds:['a','b'],preparationComplete:false,chapters:[]});
test('streaming queue accepts only immutable ordered additions and final completion',()=>{
 const initial=empty(),first={...initial,chapters:[chapter('a',1)]},done={...first,chapters:[...first.chapters,chapter('b',2)],preparationComplete:true};
 validateQueueUpdate(null,initial);validateQueueUpdate(initial,first);validateQueueUpdate(first,done);
 assert.equal(queuePreparationComplete(initial),false);assert.equal(queuePreparationComplete(done),true);
 assert.equal(queuePreparationComplete({chapters:[]}),true);
 for(const invalid of [
  {...first,chapters:[]},
  {...first,chapters:[chapter('b',2)]},
  {...first,chapters:[{...first.chapters[0],inputHash:'changed'}]},
  {...first,chapters:[{...first.chapters[0],root:'/other'}]},
  {...first,selectedChapterIds:['a','c']},
  {...first,ceilingUSD:51},
  {...first,preparationComplete:true},
  {...first,estimate:{speechUSD:51}},
 ])assert.throws(()=>validateQueueUpdate(first,invalid));
 assert.throws(()=>validateQueueUpdate(done,{...done,preparationComplete:false}));
 assert.throws(()=>validateQueueUpdate(null,{...initial,selectedChapterIds:['a','a']}));
 assert.doesNotThrow(()=>validateQueueUpdate(first,{...first,sourceCommit:'corrected',sourceRoot:'/new/runtime',planner:'/new/planner',analysisModule:'/new/analysis'}));
});
test('archives omit installed runtimes, temporary state and locks',()=>{
 for(const pattern of ['runtime','runtime-*','tmp','*.lock'])assert.ok(archiveExcludes.includes(pattern));
});

const write=async(path,value)=>fs.writeFile(path,JSON.stringify(value));
async function until(check){
 const end=Date.now()+10000;
 while(Date.now()<end){const value=await check();if(value)return value;await new Promise(done=>setTimeout(done,20));}
 throw Error('Timed out waiting for runner checkpoint');
}
async function fixture(){
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-stream-test-')),bin=join(root,'bin');await fs.mkdir(bin);
 for(const name of ['ssh','rsync'])await fs.writeFile(join(bin,name),'#!/bin/sh\nexit 0\n',{mode:0o755});
 const entries=[];
 for(const [index,id]of ['a','b'].entries()){
  const folder=join(root,'chapters',id);await fs.mkdir(folder,{recursive:true});
  const input={chapterId:id};await write(join(folder,'input.json'),input);await write(join(folder,'assembly.json'),{assembly:{id:'assembly-'+id}});await write(join(folder,'published.json'),{assembly:'assembly-'+id});
  entries.push({chapterId:id,sequence:index+1,root:folder,inputHash:hash(input)});
 }
 const queue={...empty(),root,host:'fixture',archive:'/fixture',queuePollSeconds:0.01};
 await write(join(root,'queue.json'),queue);
 const child=spawn(process.execPath,[resolve('tools/inworld-batch/runner.mjs'),join(root,'queue.json')],{env:{...process.env,PATH:bin+':'+process.env.PATH},stdio:['ignore','pipe','pipe']});
 let errors='';child.stderr.on('data',data=>{errors+=data;});child.stdout.resume();
 const exited=new Promise(done=>child.once('close',code=>done({code,errors})));
 const state=async()=>{try{return JSON.parse(await fs.readFile(join(root,'status.json'),'utf8'));}catch{return {};}};
 const append=async value=>{const path=join(root,'queue.json');await write(path+'.tmp',value);await fs.rename(path+'.tmp',path);};
 return {root,bin,queue,entries,child,exited,state,append};
}
test('one worker waits for appended chapters and finishes only after preparation completes',async()=>{
 const job=await fixture();
 try{
  await until(async()=>(await job.state()).stage==='waiting-for-prepared-chapters');
  await job.append({...job.queue,chapters:[job.entries[0]]});
  await until(async()=>{const status=await job.state();return status.stage==='waiting-for-prepared-chapters'&&status.completed?.length===1;});
  assert.equal(job.child.exitCode,null);assert.equal(Number(await fs.readFile(join(job.root,'worker.lock'),'utf8')),job.child.pid);
  await job.append({...job.queue,chapters:job.entries,preparationComplete:true});
  assert.deepEqual(await job.exited,{code:0,errors:''});
  const status=await job.state();assert.equal(status.status,'complete');assert.deepEqual(status.completed,['a','b']);
 }finally{job.child.kill();await fs.rm(job.root,{recursive:true,force:true});}
});
test('running worker holds a queue whose prepared chapter is changed',async()=>{
 const job=await fixture();
 try{
  await until(async()=>(await job.state()).stage==='waiting-for-prepared-chapters');
  await job.append({...job.queue,chapters:[job.entries[0]]});
  await until(async()=>(await job.state()).completed?.length===1);
  await job.append({...job.queue,chapters:[{...job.entries[0],inputHash:'changed'}]});
  assert.equal((await job.exited).code,0);assert.match((await job.state()).reason,/changed after queuing/);
  const restart=spawnSync(process.execPath,[resolve('tools/inworld-batch/runner.mjs'),join(job.root,'queue.json')],{env:{...process.env,PATH:job.bin+':'+process.env.PATH},encoding:'utf8',timeout:10000});
  assert.equal(restart.status,0);assert.match((await job.state()).reason,/changed after queuing/);
 }finally{job.child.kill();await fs.rm(job.root,{recursive:true,force:true});}
});
test('idle streaming worker honors a durable pause before another chapter is submitted',async()=>{
 const job=await fixture();
 try{
  await until(async()=>(await job.state()).stage==='waiting-for-prepared-chapters');
  await fs.writeFile(join(job.root,'pause.requested'),'upgrade');
  assert.equal((await job.exited).code,0);assert.equal((await job.state()).status,'paused');
  assert.equal(await fs.access(join(job.root,'worker.lock')).then(()=>true,()=>false),false);
  assert.equal(await fs.access(join(job.root,'jobs.json')).then(()=>true,()=>false),false);
 }finally{job.child.kill();await fs.rm(job.root,{recursive:true,force:true});}
});
test('pause after a paid group reconciles its receipt and reservation before releasing the worker',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-group-pause-')),bin=join(root,'bin'),folder=join(root,'chapter');
 await fs.mkdir(bin);await fs.mkdir(folder);
 const input={chapterId:'a',items:['Hello','World'].map((text,index)=>({customId:'p'+index,role:'narrator',spokenText:text,request:{text}}))};
 const entry={chapterId:'a',sequence:1,root:folder,inputHash:hash(input)},voices={narrator:{voiceId:'saved-female'}};
 await write(join(folder,'input.json'),input);await write(join(root,'voices.json'),voices);await write(join(root,'voice-profiles.json'),{});
 await write(join(root,'queue.json'),{root,host:'fixture',archive:'/fixture',selectedChapterIds:['a'],preparationComplete:true,chapters:[entry],originalVoices:voices,ceilingUSD:1,maxBatchCharacters:5,maxRetakes:2});
 const ssh=`#!/usr/bin/env node\nconst fs=require('fs');let input='';process.stdin.on('data',data=>input+=data);process.stdin.on('end',()=>{if(!input)return;const request=JSON.parse(input);fs.appendFileSync(process.env.CALLS,JSON.stringify(request)+'\\n');fs.writeFileSync(process.env.PAUSE,'upgrade');console.log(JSON.stringify({status:200,body:{name:'operations/retained',done:true,response:{resultsUri:'https://fixture/results'}}}));});`;
 await fs.writeFile(join(bin,'ssh'),ssh,{mode:0o755});await fs.writeFile(join(bin,'rsync'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 await fs.writeFile(join(bin,'ffprobe'),'#!/bin/sh\necho \'{"format":{"duration":"1"},"streams":[{"channels":1,"sample_rate":"48000"}]}\'\n',{mode:0o755});
 const preload=join(root,'fetch.mjs');await fs.writeFile(preload,`globalThis.fetch=async url=>new Response(String(url).endsWith('/results')?JSON.stringify({results:[{customId:'p0',audioUri:'https://fixture/audio'}]}):new Uint8Array(64));`);
 try{
  const run=spawnSync(process.execPath,['--import',preload,resolve('tools/inworld-batch/runner.mjs'),join(root,'queue.json')],{env:{...process.env,PATH:bin+':'+process.env.PATH,CALLS:join(root,'calls'),PAUSE:join(root,'pause.requested')},encoding:'utf8',timeout:10000});
  assert.equal(run.status,0,run.stderr);assert.equal(JSON.parse(await fs.readFile(join(root,'status.json'),'utf8')).status,'paused');
  const ledger=JSON.parse(await fs.readFile(join(root,'jobs.json'),'utf8'));assert.equal(ledger.length,1);assert.equal(ledger[0].phase,'complete');assert.equal(ledger[0].reservedUSD,0.0001);assert.equal(ledger[0].operation.name,'operations/retained');
  const receipt=JSON.parse(await fs.readFile(join(folder,'receipts','p0.json'),'utf8'));assert.equal(receipt.job,ledger[0].id);
  assert.equal((await fs.readFile(join(root,'calls'),'utf8')).trim().split('\n').length,1);
  for(const path of [join(root,'worker.lock'),join(folder,'generated.json'),join(folder,'receipts','p1.json')])assert.equal(await fs.access(path).then(()=>true,()=>false),false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
