import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {recoveryAction,createSupervisorStatusWriter} from './supervisor.mjs';
import {buildChapter} from './prepare.mjs';
import {hash} from './core.mjs';

test('supervision retries lost transports and keeps paid uncertainty, budget and content holds distinct',()=>{
 for(const reason of ['ssh exited 255: connection unavailable','Batch poll unavailable; operation retained','ChatGPT subscription analysis stopped (exit 1)','rsync exited 12'])assert.equal(recoveryAction({status:'held',reason}),'retry');
 for(const reason of ['Ambiguous submission: inspect operations','Uncertain voice design submission requires inspection','Voice design rejected HTTP 400','Batch rejected HTTP 402','Spending ceiling reached','Saved source changed','Previously failed operation needs inspection'])assert.equal(recoveryAction({status:'held',reason}),'attention');
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

for(const streaming of [false,true])test(`persistent supervisor recovers an initial SSH outage and publishes the immutable cached assembly without speech (${streaming?'streaming':'legacy'})`,async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-supervisor-test-')),dir=join(root,'1'),bin=join(root,'bin');
 const write=async(path,value)=>{await fs.mkdir(join(path,'..'),{recursive:true});await fs.writeFile(path,JSON.stringify(value));};
 const chapter={chapterId:'chapter-1',source:'source',items:[]},entry={chapterId:chapter.chapterId,sequence:1,root:dir,inputHash:hash(chapter)};
 await write(join(dir,'input.json'),chapter);await write(join(dir,'assembly.json'),{assembly:{id:'saved-assembly',plan:'saved-plan',source:'source'},batch:'saved-batch'});
 await write(join(dir,'publication/plans/saved-plan.json'),{inputHash:entry.inputHash});
 const config={root,host:'fixture',archive:'/fixture',plans:join(root,'plans'),chapterIds:[chapter.chapterId],chapters:[entry],originalVoices:{narrator:{voiceId:'saved-female'}},narratorPolicy:{gender:'female'},automaticRepair:true,maxRecoveryAttempts:2,retrySeconds:0.001,...(streaming?{selectedChapterIds:[chapter.chapterId],preparationComplete:false}:{})};
 if(streaming)await write(join(root,'plans/plans',chapter.chapterId,'plan.json'),{cached:true});
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
  assert.equal(state.lanes['render-review-publish'].status,'complete');assert.equal(state.lanes['render-review-publish'].attempt,2);
  assert.equal(state.lanes['render-review-publish'].reason,null);assert.equal(state.lanes['render-review-publish'].nextAttemptAt,null);
  assert.equal(JSON.parse(await fs.readFile(join(dir,'published.json'),'utf8')).assembly,'saved-assembly');
  assert.equal(await fs.access(join(root,'supervisor.lock')).then(()=>true,()=>false),false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});


test('concurrent lane starts and heartbeats retain durable fatal and recovering stage evidence',async()=>{
 const snapshots=[];let writing=0,maximum=0;
 const status=createSupervisorStatusWriter({},async state=>{
  writing++;maximum=Math.max(maximum,writing);
  await new Promise(resolve=>setTimeout(resolve,2));snapshots.push(structuredClone(state));writing--;
 });
 await Promise.all([
  status({status:'recovering',stage:'attribute-one',reason:'Ambiguous established character identity',lanes:{'attribute-one':{status:'needs-attention',attempt:3,reason:'Ambiguous established character identity',nextAttemptAt:null}}}),
  status({status:'running',stage:'directions-two',reason:null,lanes:{'directions-two':{status:'running',attempt:1,reason:null,nextAttemptAt:null}}}),
  status({status:'recovering',stage:'directions-three',reason:'Lost subscription transport',lanes:{'directions-three':{status:'recovering',attempt:2,reason:'Lost subscription transport',nextAttemptAt:'2030-01-01T00:00:00Z'}}}),
  status({childPid:123}),
  status({lanes:{'directions-two':{status:'complete',attempt:1,reason:null,nextAttemptAt:null}}}),
 ]);
 const last=snapshots.at(-1);assert.equal(maximum,1);assert.equal(snapshots.length,5);
 assert.deepEqual({...last.lanes['attribute-one'],updatedAt:undefined},{status:'needs-attention',attempt:3,reason:'Ambiguous established character identity',nextAttemptAt:null,updatedAt:undefined});
 assert.equal(last.lanes['directions-three'].status,'recovering');assert.equal(last.lanes['directions-three'].nextAttemptAt,'2030-01-01T00:00:00Z');
 assert.equal(last.lanes['directions-two'].status,'complete');assert.equal(last.childPid,123);
 assert.ok(last.lanes['attribute-one'].updatedAt);assert.equal(last.lanes['attribute-one'].updatedAt,snapshots[0].lanes['attribute-one'].updatedAt);
});

test('stage health survives a new status writer until that exact stage resumes',async()=>{
 let saved;
 const initial={lanes:{'attribute-one':{status:'needs-attention',attempt:8,reason:'Exact identity review required',nextAttemptAt:null}},status:'needs-attention'};
 const status=createSupervisorStatusWriter(initial,async state=>{saved=structuredClone(state);});
 await status({status:'running',lanes:{'directions-two':{status:'running',attempt:1,reason:null,nextAttemptAt:null}}});
 assert.equal(saved.lanes['attribute-one'].reason,'Exact identity review required');
 await status({lanes:{'attribute-one':{status:'running',attempt:1,reason:null,nextAttemptAt:null}}});
 assert.equal(saved.lanes['attribute-one'].status,'running');assert.equal(saved.lanes['attribute-one'].reason,null);
 assert.equal(initial.lanes['attribute-one'].status,'needs-attention');
});
