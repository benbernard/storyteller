import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {withReviewGpu,withAutomaticReview} from './review-gpu.mjs';

test('GPU review owns and releases a lease without stopping local speech work',async()=>{
 const calls=[];
 const call=async(path,payload,owner)=>{calls.push({path,payload,owner});return {};};
 await withReviewGpu({call,command:process.execPath,args:['-e',"if(process.env.INWORLD_REVIEW_DEVICE!=='gpu'||process.env.INWORLD_REVIEW_GPU_LEASE!=='1')process.exit(2)"]});
 assert.deepEqual(calls.map(c=>c.path),['/v1/lease','/v1/status','/v1/lease/release']);
 assert.ok(calls.every(c=>c.owner===calls[0].owner));
});

test('busy GPU never starts review and releases only its own lease',async()=>{
 const calls=[];
 const call=async(path)=>{calls.push(path);return path==='/v1/status'?{queued:1}:{};};
 await assert.rejects(withReviewGpu({call,command:'must-not-run'}),/active or queued/);
 assert.deepEqual(calls,['/v1/lease','/v1/status','/v1/lease/release']);
});

test('refused GPU lease never releases another owner or starts review',async()=>{
 let count=0;
 await assert.rejects(withReviewGpu({call:async()=>{count++;throw Error('busy');},command:'must-not-run'}),/busy/);
 assert.equal(count,1);
});

test('automatic review falls back to CPU before starting work when GPU is busy',async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),'review-auto-test-')),output=join(directory,'device');
 const script=`require('fs').writeFileSync(${JSON.stringify(output)},process.env.INWORLD_REVIEW_DEVICE+':'+String(process.env.INWORLD_REVIEW_GPU_LEASE));`;
 try{
  for(const acquired of [false,true]){
   const calls=[];
   const call=async path=>{calls.push(path);if(!acquired)throw Error('GPU occupied');return path==='/v1/status'?{active:true}:{};};
   await withAutomaticReview({call,command:process.execPath,args:['-e',script]});
   assert.equal(await fs.readFile(output,'utf8'),'cpu:undefined');
   assert.deepEqual(calls,acquired?['/v1/lease','/v1/status','/v1/lease/release']:['/v1/lease']);
  }
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('automatic review never retries a GPU child failure on CPU',async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),'review-auto-test-')),output=join(directory,'runs');
 try{
  await assert.rejects(withAutomaticReview({call:async()=>({}),command:process.execPath,args:['-e',`require('fs').appendFileSync(${JSON.stringify(output)},process.env.INWORLD_REVIEW_DEVICE+'\\n');process.exit(4);`]}),/failed 4/);
  assert.equal(await fs.readFile(output,'utf8'),'gpu\n');
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('automatic review cannot fall back after a GPU child starts even if lease release fails',async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),'review-auto-test-')),output=join(directory,'runs');
 try{
  const call=async path=>{if(path==='/v1/lease/release')throw Object.assign(Error('release failed'),{code:'GPU_REVIEW_UNAVAILABLE'});return {};};
  await assert.rejects(withAutomaticReview({call,command:process.execPath,args:['-e',`require('fs').appendFileSync(${JSON.stringify(output)},process.env.INWORLD_REVIEW_DEVICE+'\\n');`]}),/release failed/);
  assert.equal(await fs.readFile(output,'utf8'),'gpu\n');
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('lease loss stops the owned review process before release',async()=>{
 const calls=[];let leases=0;
 const call=async(path)=>{calls.push(path);if(path==='/v1/lease'&&++leases===2)throw Error('lost');return {};};
 await assert.rejects(withReviewGpu({call,command:process.execPath,args:['-e','setInterval(()=>{},1000)'],renewMs:40}),/renewal failed/);
 assert.equal(calls.at(-1),'/v1/lease/release');
});

test('a failed renewal completing after child exit still fails review',async()=>{
 let leases=0,released=false;
 const call=async path=>{
  if(path==='/v1/lease'&&++leases===2){await new Promise(done=>setTimeout(done,300));throw Error('lost');}
  if(path==='/v1/lease/release')released=true;
  return {};
 };
 await assert.rejects(withAutomaticReview({call,command:process.execPath,args:['-e','setTimeout(()=>{},100)'],renewMs:40}),/renewal failed/);
 assert.equal(released,true);
});

test('repeated signals cannot abandon an owned TERM-ignoring process group',async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),'review-signal-test-')),ready=join(directory,'ready'),released=join(directory,'released');
 const child=`process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
 const script=`import fs from 'node:fs/promises';import {withReviewGpu} from ${JSON.stringify(new URL('./review-gpu.mjs',import.meta.url).href)};try{await withReviewGpu({call:async path=>{if(path==='/v1/lease/release'){const pid=Number(await fs.readFile(${JSON.stringify(ready)},'utf8'));try{process.kill(pid,0);throw Error('owned child survived');}catch(e){if(e.code!=='ESRCH')throw e;}await fs.writeFile(${JSON.stringify(released)},'released');}return {};},command:process.execPath,args:['-e',${JSON.stringify(child)}],killMs:200});}catch{process.exitCode=1;}`;
 const {spawn}=await import('node:child_process');
 const wrapper=spawn(process.execPath,['--input-type=module','-e',script],{stdio:'ignore'});
 const finished=new Promise(done=>wrapper.once('exit',(code,signal)=>done({code,signal})));
 let pid;
 try{
  const deadline=Date.now()+5000;
  while(!pid){try{pid=Number(await fs.readFile(ready,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}if(Date.now()>deadline)throw Error('child did not start');await new Promise(done=>setTimeout(done,20));}
  wrapper.kill('SIGTERM');await new Promise(done=>setTimeout(done,50));wrapper.kill('SIGTERM');
  assert.deepEqual(await finished,{code:1,signal:null});
  assert.equal(await fs.readFile(released,'utf8'),'released');
  assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});
 }finally{wrapper.kill('SIGKILL');if(pid)try{process.kill(pid,'SIGKILL');}catch{}await fs.rm(directory,{recursive:true,force:true});}
});

test('lease release waits for a TERM-ignoring grandchild in the owned group',async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),'review-gpu-test-')),ready=join(directory,'ready');
 const grandchild=`process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000);`;
 const parent=`require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`;
 let leases=0,released=false,pid;
 const call=async path=>{
  if(path==='/v1/lease'&&++leases>1){
   try{pid=Number(await fs.readFile(ready,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
   if(pid)throw Error('lost');
  }
  if(path==='/v1/lease/release'){
   assert.throws(()=>process.kill(pid,0),{code:'ESRCH'});released=true;
  }
  return {};
 };
 try{
  await assert.rejects(withReviewGpu({call,command:process.execPath,args:['-e',parent],renewMs:25,killMs:100}),/renewal failed/);
  assert.equal(released,true);
 }finally{if(pid)try{process.kill(pid,'SIGKILL');}catch{}await fs.rm(directory,{recursive:true,force:true});}
});
