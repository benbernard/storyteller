import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {hash} from './core.mjs';

const write=async(path,value)=>{await fs.mkdir(dirname(path),{recursive:true});await fs.writeFile(path,JSON.stringify(value));};
const exists=async path=>fs.access(path).then(()=>true,()=>false);
async function until(check){const end=Date.now()+10000;while(Date.now()<end){if(await check())return;await new Promise(done=>setTimeout(done,20));}throw Error('Timed out waiting for supervisor pause checkpoint');}

for(const hold of ['review-backlog','needs-attention'])test(`durable ${hold} acknowledges an idle pause without starting any children or losing its hold`,async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-durable-pause-'));
 const config={root,chapterIds:['chapter-a'],originalVoices:{narrator:{voiceId:'female'}},narratorPolicy:{gender:'female'},planner:join(root,'must-not-run.mjs')};
 const prior={status:hold,reason:'Retained evidence needs review',lanes:{review:{status:'needs-attention',reason:'Original proof retained'}}};
 try{
  await write(join(root,'config.json'),config);await write(join(root,'supervisor-status.json'),prior);await fs.writeFile(join(root,'pause.requested'),'upgrade');
  // There is deliberately no queue/planner/runner input. Starting work would fail.
  let result=spawnSync(process.execPath,[resolve('tools/inworld-batch/supervisor.mjs'),join(root,'config.json')],{encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);
  let state=JSON.parse(await fs.readFile(join(root,'supervisor-status.json'),'utf8'));assert.equal(state.status,'paused');assert.equal(state.pausedFrom,hold);assert.equal(state.reason,prior.reason);assert.deepEqual(state.lanes,prior.lanes);
  assert.equal(await exists(join(root,'supervisor.lock')),false);assert.equal(await exists(join(root,'worker.lock')),false);assert.equal(await exists(join(root,'supervisor.log')),false);
  // Removing only the pause marker is not an explicit authorization to resume a hold.
  await fs.unlink(join(root,'pause.requested'));result=spawnSync(process.execPath,[resolve('tools/inworld-batch/supervisor.mjs'),join(root,'config.json')],{encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);
  state=JSON.parse(await fs.readFile(join(root,'supervisor-status.json'),'utf8'));assert.equal(state.status,'paused');assert.equal(state.pausedFrom,hold);assert.equal(await exists(join(root,'supervisor.log')),false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('an already complete coordinator remains complete even when a pause marker exists',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-complete-pause-'));
 try{
  await write(join(root,'config.json'),{root,chapterIds:['done'],originalVoices:{narrator:{voiceId:'female'}},narratorPolicy:{gender:'female'}});await write(join(root,'supervisor-status.json'),{status:'complete'});await fs.writeFile(join(root,'pause.requested'),'upgrade');
  const result=spawnSync(process.execPath,[resolve('tools/inworld-batch/supervisor.mjs'),join(root,'config.json')],{encoding:'utf8',timeout:10000});assert.equal(result.status,0,result.stderr);
  assert.equal(JSON.parse(await fs.readFile(join(root,'supervisor-status.json'),'utf8')).status,'complete');assert.equal(await exists(join(root,'supervisor.log')),false);assert.equal(await exists(join(root,'supervisor.lock')),false);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

for(const mode of ['active','retry-wait'])test(`pause marker stops ${mode} preparation, preserves identity checkpoints, and waits for renderer drain`,async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-supervisor-pause-')),bin=join(root,'bin'),folder=join(root,'chapter');await fs.mkdir(bin);
 const chapter={chapterId:'chapter-a',source:'source',items:[]},entry={chapterId:chapter.chapterId,sequence:1,root:folder,inputHash:hash(chapter)};
 await write(join(folder,'input.json'),chapter);await write(join(folder,'assembly.json'),{assembly:{id:'saved-assembly',plan:'saved-plan',source:'source'},batch:'saved-batch'});
 await write(join(folder,'publication/plans/saved-plan.json'),{inputHash:entry.inputHash});
 const originalVoices={narrator:{voiceId:'saved-female'}},planner=join(root,'planner.mjs');
 const config={root,host:'fixture',archive:'/fixture',plans:join(root,'plans'),planner,plannerConfig:join(root,'planner.json'),chapterIds:[chapter.chapterId],chapters:[entry],selectedChapterIds:[chapter.chapterId],preparationComplete:false,originalVoices,narratorPolicy:{gender:'female'},automaticRepair:true,queuePollSeconds:0.01,maxRecoveryAttempts:2,retrySeconds:mode==='retry-wait'?30:0.01};
 await write(join(root,'config.json'),config);await write(join(root,'queue.json'),config);await write(join(root,'planner.json'),{});await write(join(root,'voices.json'),originalVoices);await write(join(root,'voice-profiles.json'),{});
 await fs.writeFile(planner,`import fs from 'node:fs';
fs.writeFileSync(process.env.IDENTITY_CHECKPOINT,JSON.stringify({chapter:process.argv[3],identities:['stable-identity']}));
fs.writeFileSync(process.env.PREP_STARTED,String(process.pid));
if(process.env.PREP_MODE==='retry-wait')process.exit(1);
process.on('SIGTERM',()=>{fs.writeFileSync(process.env.PREP_STOPPED,'graceful');process.exit(0);});
setInterval(()=>{},1000);`);
 await fs.writeFile(join(bin,'rsync'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 await fs.writeFile(join(bin,'ssh'),`#!/usr/bin/env node
const fs=require('fs');let input='';process.stdin.on('data',data=>input+=data);
process.on('SIGTERM',()=>{fs.writeFileSync(process.env.RENDER_TERM,'unexpected');process.exit(2);});
process.stdin.on('end',async()=>{
 if(input.startsWith('{'))throw Error('No paid calls permitted');
 const command=process.argv.join(' ');
 if(command.includes('sudo python3 -c')){fs.writeFileSync(process.env.RENDER_STARTED,String(process.pid));while(!fs.existsSync(process.env.RENDER_RELEASE))await new Promise(done=>setTimeout(done,10));}
 if(command.includes('audiobook-listener'))console.log(JSON.stringify({assembly:'saved-assembly',audioVerified:true,textVerified:true,rangeVerified:true}));
 else if(input)console.log('{}');
});`,{mode:0o755});
 const env={...process.env,PATH:bin+':'+process.env.PATH,PREP_MODE:mode,PREP_STARTED:join(root,'prep-started'),PREP_STOPPED:join(root,'prep-stopped'),IDENTITY_CHECKPOINT:join(root,'identities.json'),RENDER_STARTED:join(root,'render-started'),RENDER_RELEASE:join(root,'render-release'),RENDER_TERM:join(root,'render-term')};
 const child=spawn(process.execPath,[resolve('tools/inworld-batch/supervisor.mjs'),join(root,'config.json')],{env,stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',data=>{errors+=data;});
 const finished=new Promise(done=>child.once('close',done));
 try{
  await until(async()=>await exists(env.PREP_STARTED)&&await exists(env.RENDER_STARTED));
  const identities=await fs.readFile(env.IDENTITY_CHECKPOINT),renderPid=Number(await fs.readFile(join(root,'worker.lock'),'utf8'));
  await fs.writeFile(join(root,'pause.requested'),'upgrade');
  await until(async()=>{if(mode==='active')return exists(env.PREP_STOPPED);const status=JSON.parse(await fs.readFile(join(root,'supervisor-status.json'),'utf8'));return status.lanes['attribute-chapter-a']?.status==='paused';});
  assert.equal(await exists(join(root,'supervisor.lock')),true);assert.equal(await exists(join(root,'worker.lock')),true);assert.equal(child.exitCode,null);
  process.kill(renderPid,0);assert.equal(await exists(env.RENDER_TERM),false);assert.deepEqual(await fs.readFile(env.IDENTITY_CHECKPOINT),identities);
  await fs.writeFile(env.RENDER_RELEASE,'finish accepted work');assert.equal(await finished,0,errors);
  const status=JSON.parse(await fs.readFile(join(root,'supervisor-status.json'),'utf8'));
  assert.equal(status.status,'paused');assert.equal(status.reason,null);assert.equal(status.lanes['attribute-chapter-a'].status,'paused');
  assert.equal(JSON.parse(await fs.readFile(join(root,'status.json'),'utf8')).status,'paused');
  assert.equal(JSON.parse(await fs.readFile(join(folder,'published.json'),'utf8')).assembly,'saved-assembly');
  assert.equal(JSON.parse(await fs.readFile(join(root,'queue.json'),'utf8')).preparationComplete,false);
  assert.equal(await exists(join(root,'supervisor.lock')),false);assert.equal(await exists(join(root,'worker.lock')),false);assert.equal(await exists(env.RENDER_TERM),false);
 }finally{
  await fs.writeFile(env.RENDER_RELEASE,'cleanup');if(child.exitCode===null)child.kill('SIGTERM');
  await Promise.race([finished,new Promise(done=>setTimeout(done,2000))]);await fs.rm(root,{recursive:true,force:true});
 }
});
