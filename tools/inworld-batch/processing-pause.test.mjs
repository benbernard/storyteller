import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {ProcessingLane} from './pipeline.mjs';
import {hash,sha} from './core.mjs';

test('processing pause finishes active work and defers queued chapters without treating them as errors',async()=>{
 const lane=new ProcessingLane(),events=[];let paused=false,release,started;
 const active=new Promise(done=>{started=done;}),wait=new Promise(done=>{release=done;});
 const options=id=>({shouldStart:async()=>!paused,onDeferred:async()=>{events.push('deferred '+id);}});
 lane.enqueue('a',async()=>{started();await wait;events.push('finished a');},async()=>{},options('a'));
 lane.enqueue('b',async()=>{events.push('started b');},async()=>{},options('b'));
 lane.enqueue('c',async()=>{events.push('started c');},async()=>{},options('c'));
 await active;paused=true;release();await lane.drain();
 assert.deepEqual(events,['finished a','deferred b','deferred c']);assert.deepEqual(lane.deferred,['b','c']);assert.deepEqual(lane.errors,[]);
});

const write=async(path,value)=>{await fs.mkdir(dirname(path),{recursive:true});await fs.writeFile(path,JSON.stringify(value));};
async function until(check){
 const end=Date.now()+10000;
 while(Date.now()<end){if(await check())return;await new Promise(done=>setTimeout(done,20));}
 throw Error('Timed out waiting for processing checkpoint');
}
test('paused processing backlog resumes saved generated chapters without another paid request or changed receipt',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-processing-pause-')),bin=join(root,'bin');await fs.mkdir(bin);
 const voices={narrator:{voiceId:'saved-female'}},chapters=[],saved=[];
 for(const id of ['a','b','c']){
  const folder=join(root,id),audio=Buffer.alloc(64,id.charCodeAt(0));
  const request={text:'Hello',voiceId:'saved-female'},chapter={chapterId:id,source:'source-'+id,items:[{customId:'p0',role:'narrator',spokenText:'Hello',request:{text:'Hello'}}]};
  const entry={chapterId:id,sequence:chapters.length+1,root:folder,inputHash:hash(chapter)};
  await write(join(folder,'input.json'),chapter);await write(join(folder,'assembly.json'),{assembly:{id:'saved-'+id,plan:'plan-'+id,source:chapter.source},batch:'batch-'+id});
  await write(join(folder,'publication/plans','plan-'+id+'.json'),{inputHash:entry.inputHash});
  await write(join(folder,'generated.json'),{chapter:id,inputHash:entry.inputHash,items:1,completedAt:'original-time'});
  await write(join(folder,'receipts/p0.json'),{sha256:sha(audio),duration:1,requestHash:hash(request),voiceId:'saved-female',job:'retained-paid'});
  await fs.mkdir(join(folder,'audio'));await fs.writeFile(join(folder,'audio/p0.wav'),audio);
  for(const name of ['generated.json','receipts/p0.json','audio/p0.wav']){const path=join(folder,name);saved.push([path,await fs.readFile(path)]);}
  chapters.push(entry);
 }
 await write(join(root,'voices.json'),voices);await write(join(root,'voice-profiles.json'),{});
 const ledger=[{id:'retained-paid',phase:'complete',chapter:'a',reservedUSD:0.02,items:[]}];await write(join(root,'jobs.json'),ledger);
 await write(join(root,'queue.json'),{root,host:'fixture',archive:'/fixture',selectedChapterIds:['a','b','c'],preparationComplete:true,chapters,originalVoices:voices,ceilingUSD:1});
 await fs.writeFile(join(bin,'rsync'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 await fs.writeFile(join(bin,'ssh'),`#!/usr/bin/env node
const fs=require('fs');let input='';process.stdin.on('data',data=>input+=data);process.stdin.on('end',async()=>{
 if(input.startsWith('{'))throw Error('No paid provider calls allowed');
 const command=process.argv.join(' ');
 if(command.includes('sudo python3 -c')&&!fs.existsSync(process.env.ACTIVE)){
  fs.writeFileSync(process.env.ACTIVE,'active');
  while(!fs.existsSync(process.env.PAUSE))await new Promise(done=>setTimeout(done,10));
 }
 if(command.includes('audiobook-listener')){
  const value=JSON.parse(input.slice('const input='.length,input.indexOf(';\\n')));
  console.log(JSON.stringify({assembly:value.assembly,audioVerified:true,textVerified:true,rangeVerified:true}));
 }else if(input)console.log('{}');
});`,{mode:0o755});
 const env={...process.env,PATH:bin+':'+process.env.PATH,ACTIVE:join(root,'active-processing'),PAUSE:join(root,'pause.requested')},runner=resolve('tools/inworld-batch/runner.mjs');
 const child=spawn(process.execPath,[runner,join(root,'queue.json')],{env,stdio:['ignore','pipe','pipe']});child.stdout.resume();let errors='';child.stderr.on('data',data=>{errors+=data;});
 const exited=new Promise(done=>child.once('close',code=>done(code)));
 try{
  await until(async()=>{
   try{const status=JSON.parse(await fs.readFile(join(root,'status.json'),'utf8'));return status.completed?.length===3&&await fs.access(env.ACTIVE).then(()=>true,()=>false);}catch{return false;}
  });
  await fs.writeFile(env.PAUSE,'upgrade');assert.equal(await exited,0,errors);
  const status=JSON.parse(await fs.readFile(join(root,'status.json'),'utf8'));assert.equal(status.status,'paused');assert.deepEqual(status.deferredProcessing,['b','c']);
  assert.equal(JSON.parse(await fs.readFile(join(root,'a/published.json'),'utf8')).assembly,'saved-a');
  for(const id of ['b','c']){
   assert.equal(JSON.parse(await fs.readFile(join(root,id,'processing.json'),'utf8')).status,'queued-for-resume');
   assert.equal(await fs.access(join(root,id,'published.json')).then(()=>true,()=>false),false);
  }
  await fs.unlink(env.PAUSE);
  const resume=spawnSync(process.execPath,[runner,join(root,'queue.json')],{env,encoding:'utf8',timeout:10000});assert.equal(resume.status,0,resume.stderr);
  assert.equal(JSON.parse(await fs.readFile(join(root,'status.json'),'utf8')).status,'complete',resume.stdout);
  for(const id of ['a','b','c'])assert.equal(JSON.parse(await fs.readFile(join(root,id,'published.json'),'utf8')).assembly,'saved-'+id);
  for(const [path,original]of saved)assert.deepEqual(await fs.readFile(path),original);
  assert.deepEqual(JSON.parse(await fs.readFile(join(root,'jobs.json'),'utf8')),ledger);
 }finally{child.kill();await fs.rm(root,{recursive:true,force:true});}
});
