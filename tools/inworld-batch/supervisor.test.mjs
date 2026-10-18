import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {recoveryAction} from './supervisor.mjs';
import {buildChapter} from './prepare.mjs';
import {hash} from './core.mjs';

test('supervision retries lost transports and keeps paid uncertainty, budget and content holds distinct',()=>{
 for(const reason of ['ssh exited 255: connection unavailable','Batch poll unavailable; operation retained','ChatGPT subscription analysis stopped (exit 1)','rsync exited 12'])assert.equal(recoveryAction({status:'held',reason}),'retry');
 for(const reason of ['Ambiguous submission: inspect operations','Uncertain voice design submission requires inspection','Batch rejected HTTP 402','Spending ceiling reached','Saved source changed','Previously failed operation needs inspection'])assert.equal(recoveryAction({status:'held',reason}),'attention');
 assert.equal(recoveryAction({status:'complete'}),'complete');
 assert.equal(recoveryAction({status:'complete-with-review-backlog'}),'review');
});

test('provider plans retain source coverage, distinct note voices, acting and the per-item UTF-16 cap',()=>{
 const plan={chapterId:'chapter-1',sequence:1,title:'Chapter One',source:'source',analysis:'analysis',segments:[
  {uid:'heading',role:'narrator',text:'Chapter One',spans:[],presentation:'title'},
  {uid:'body',role:'mira',text:'😀 words '.repeat(600),spans:[{start:0,end:5400}]},
  {uid:'note',role:'author-note',text:'A note',spans:[],presentation:'author-note-after'}],directions:['heading','body','note'].map(uid=>({uid,instruction:'Speak naturally with clear steady pacing.'}))};
 const result=buildChapter(plan,plan.segments.map(s=>s.text),{narratorPolicy:{gender:'female'}});
 assert.deepEqual(result.segments.map(s=>s.spans),plan.segments.map(s=>s.spans));
 assert.ok(result.items.every(i=>i.request.text.length<=2000));
 assert.ok(result.items.some(i=>i.role==='author-note'));
 assert.equal(result.items.filter(i=>i.role==='mira').map(i=>i.spokenText).join(' ').replace(/\s+/g,' ').trim(),plan.segments[1].text.trim());
 assert.throws(()=>buildChapter({...plan,directions:plan.directions.slice(1)},plan.segments.map(s=>s.text),{}));
});

test('persistent supervisor recovers an initial SSH outage and publishes the immutable cached assembly without speech',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-supervisor-test-')),dir=join(root,'1'),bin=join(root,'bin');
 const write=async(path,value)=>{await fs.mkdir(join(path,'..'),{recursive:true});await fs.writeFile(path,JSON.stringify(value));};
 const chapter={chapterId:'chapter-1',source:'source',items:[]},entry={chapterId:chapter.chapterId,sequence:1,root:dir,inputHash:hash(chapter)};
 await write(join(dir,'input.json'),chapter);await write(join(dir,'assembly.json'),{assembly:{id:'saved-assembly',plan:'saved-plan',source:'source'},batch:'saved-batch'});
 await write(join(dir,'publication/plans/saved-plan.json'),{inputHash:entry.inputHash});
 const config={root,host:'fixture',archive:'/fixture',chapterIds:[chapter.chapterId],chapters:[entry],originalVoices:{narrator:{voiceId:'saved-female'}},narratorPolicy:{gender:'female'},automaticRepair:true,maxRecoveryAttempts:2,retrySeconds:0.001};
 await write(join(root,'config.json'),config);await write(join(root,'queue.json'),config);await write(join(root,'voices.json'),config.originalVoices);await write(join(root,'voice-profiles.json'),{});await fs.mkdir(bin);
 await fs.writeFile(join(bin,'rsync'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 await fs.writeFile(join(bin,'ssh'),`#!/usr/bin/env node
const fs=require('fs');if(!fs.existsSync(process.env.OUTAGE)){fs.writeFileSync(process.env.OUTAGE,'recovered');process.stderr.write('connection unavailable');process.exit(255);}
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{if(input.startsWith('{'))throw Error('No speech call allowed');if(process.argv.join(' ').includes('audiobook-listener'))console.log(JSON.stringify({assembly:'saved-assembly',audioVerified:true,textVerified:true,rangeVerified:true}));else if(input)console.log('{}');});`,{mode:0o755});
 try{
  const result=spawnSync(process.execPath,[resolve('tools/inworld-batch/supervisor.mjs'),join(root,'config.json')],{env:{...process.env,PATH:bin+':'+process.env.PATH,OUTAGE:join(root,'outage')},encoding:'utf8',timeout:20000});
  assert.equal(result.status,0,result.stderr);
  const state=JSON.parse(await fs.readFile(join(root,'supervisor-status.json'),'utf8'));
  assert.equal(state.status,'complete',JSON.stringify(state));assert.equal(state.attempt,2);
  assert.equal(JSON.parse(await fs.readFile(join(dir,'published.json'),'utf8')).assembly,'saved-assembly');
  assert.equal(await fs.access(join(root,'supervisor.lock')).then(()=>true,()=>false),false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
