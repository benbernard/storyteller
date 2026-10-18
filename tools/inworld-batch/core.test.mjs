import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {spawnSync} from 'node:child_process';
import {pack,checkResults,assertBudget,hash,validateCoverage} from './core.mjs';
test('batch packing respects UTF-16 account cap and retains saved voice IDs',()=>{
 const items=[{customId:'a',request:{text:'😀'.repeat(2500),voiceId:'saved-female'}},{customId:'b',request:{text:'x'.repeat(4000),voiceId:'saved-character'}},{customId:'c',request:{text:'x'.repeat(1000),voiceId:'saved-female'}}];
 const groups=pack(items);assert.deepEqual(groups.map(g=>g.map(i=>i.customId)),[['a','b'],['c']]);assert.equal(groups[0][0].request.voiceId,'saved-female');assert.throws(()=>pack([{request:{text:'a'.repeat(10000)}}]));
});
test('results are keyed, complete, unique and may contain individual failures',()=>{
 const items=[{customId:'a'},{customId:'b'}];const results={results:[{customId:'b',error:{code:8}},{customId:'a',audioUri:'https://example.com/a'}]};assert.equal(checkResults(items,results).length,2);
 assert.throws(()=>checkResults(items,{results:[results.results[0]]}));assert.throws(()=>checkResults(items,{results:[results.results[0],results.results[0]]}));
});
test('budget reserves uncertain work and releases explicit rejections',()=>{
 assert.throws(()=>assertBudget([{phase:'submitting',reservedUSD:1}],1000,1));
 assert.doesNotThrow(()=>assertBudget([{phase:'rejected',reservedUSD:1}],1000,1));
});
test('source coverage rejects missing, duplicated or changed story text',()=>{
 const s=[{text:'abc',spans:[{start:0,end:3}]}];validateCoverage(s,'abc');assert.throws(()=>validateCoverage(s,'abcd'));assert.throws(()=>validateCoverage([...s,...s],'abc'));assert.throws(()=>validateCoverage([{...s[0],text:'abd'}],'abc'));
});
for(const mode of ['credit','ambiguous','accepted'])test(`runner ${mode} failure preserves chapter order and avoids duplicate submits`,async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-runner-test-')),bin=join(root,'bin');await fs.mkdir(bin);
 const stub=`#!/usr/bin/env node\nconst fs=require('fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{if(process.argv[2]?.startsWith('mkdir'))return;let r;try{r=JSON.parse(input)}catch{return;}fs.appendFileSync(process.env.CALLS,JSON.stringify(r)+'\\n');if(r.method==='POST'){if(process.env.MODE==='ambiguous')process.exit(1);console.log(JSON.stringify(process.env.MODE==='credit'?{status:402,body:{error:'Insufficient credits'}}:{status:200,body:{name:'workspaces/test/ttsBatchJobs/b/operations/o',done:false}}));}else console.log(JSON.stringify({status:403,body:{error:'held'}}));});`;
 await fs.writeFile(join(bin,'ssh'),stub,{mode:0o755});await fs.writeFile(join(bin,'rsync'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 const voices={narrator:{voiceId:'saved-female'}},chapters=[];
 for(const sequence of [261,262]){const dir=join(root,String(sequence));await fs.mkdir(dir);const input={chapterId:'rr-'+sequence,items:[{customId:'s0000p0',role:'narrator',spokenText:'Hello',request:{text:'Hello',modelId:'inworld-tts-2'}}]};await fs.writeFile(join(dir,'input.json'),JSON.stringify(input));chapters.push({chapterId:input.chapterId,sequence,title:'Fixture',root:dir,inputHash:hash(input)});}
 const config={root,host:'test',archive:'/test',selectedChapterIds:chapters.map(entry=>entry.chapterId),preparationComplete:false,chapters:chapters.slice(0,1),originalVoices:voices,maxBatchCharacters:9500,ceilingUSD:1,maxRetakes:2,pollSeconds:0.001};
 await fs.writeFile(join(root,'voices.json'),JSON.stringify(voices));await fs.writeFile(join(root,'voice-profiles.json'),'{}');await fs.writeFile(join(root,'queue.json'),JSON.stringify(config));
 const env={...process.env,PATH:bin+':'+process.env.PATH,MODE:mode,CALLS:join(root,'calls')};const runner=resolve('tools/inworld-batch/runner.mjs');
 try{
  let run=spawnSync(process.execPath,[runner,join(root,'queue.json')],{env,encoding:'utf8',timeout:20000});assert.equal(run.status,0,run.stderr);
  assert.equal(await fs.access(env.CALLS).then(()=>true,()=>false),true,run.stdout+run.stderr);
  let calls=(await fs.readFile(env.CALLS,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.filter(c=>c.method==='POST').length,1);
  let jobs=JSON.parse(await fs.readFile(join(root,'jobs.json'),'utf8'));assert.equal(jobs.length,1);assert.equal(jobs[0].chapter,'rr-261');assert.equal(jobs[0].items[0].request.voiceId,'saved-female');
  assert.equal(JSON.parse(await fs.readFile(join(root,'status.json'),'utf8')).status,'held');
  if(mode!=='credit'){
   await fs.writeFile(join(root,'queue.json'),JSON.stringify({...config,chapters,preparationComplete:true}));
   run=spawnSync(process.execPath,[runner,join(root,'queue.json')],{env,encoding:'utf8',timeout:20000});assert.equal(run.status,0);
   calls=(await fs.readFile(env.CALLS,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.filter(c=>c.method==='POST').length,1);
   const retained=JSON.parse(await fs.readFile(join(root,'jobs.json'),'utf8'));assert.equal(retained.length,1);assert.equal(retained[0].id,jobs[0].id);assert.equal(retained[0].reservedUSD,jobs[0].reservedUSD);
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

const {ProcessingLane,steeringText}=await import('./pipeline.mjs');
test('slow review does not block generation and failed review does not stop later processing',async()=>{
 const lane=new ProcessingLane(),events=[];let release;
 const wait=new Promise(resolve=>{release=resolve;});
 lane.enqueue('one',async()=>{await wait;throw Error('review failed');},async()=>{events.push('one deferred');});
 lane.enqueue('two',async()=>{events.push('two processed');},async()=>{});
 events.push('two generated');assert.deepEqual(events,['two generated']);
 release();await lane.drain();assert.deepEqual(events,['two generated','one deferred','two processed']);assert.equal(lane.errors.length,1);
});
test('Inworld steering changes directions only and preserves the spoken source',()=>{
 const text='Thea said, “Wait!”';assert.equal(steeringText('Speak softly; with restrained urgency.',text),'[speak softly with restrained urgency] '+text);
 assert.throws(()=>steeringText('',text));assert.throws(()=>steeringText('speak softly','x'.repeat(2000)));
});
