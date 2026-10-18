import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {withReviewGpu} from './review-gpu.mjs';

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

test('lease loss stops the owned review process before release',async()=>{
 const calls=[];let leases=0;
 const call=async(path)=>{calls.push(path);if(path==='/v1/lease'&&++leases===2)throw Error('lost');return {};};
 await assert.rejects(withReviewGpu({call,command:process.execPath,args:['-e','setInterval(()=>{},1000)'],renewMs:40}),/renewal failed/);
 assert.equal(calls.at(-1),'/v1/lease/release');
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
