import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {withChapterProcessingLock} from './chapter-processing-lock.mjs';

test('main processing waits for independent chapter recovery and excludes another owner',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-chapter-lock-')),path=join(root,'owner-review.lock');
 try{
  await fs.writeFile(path,String(process.pid));
  let entered=false;
  const work=withChapterProcessingLock(root,async()=>{
   entered=true;
   assert.equal(await fs.readFile(path,'utf8'),String(process.pid));
   await assert.rejects(fs.open(path,'wx'),{code:'EEXIST'});
   return 'processed';
  },{retryMilliseconds:5});
  await wait(20);assert.equal(entered,false);
  await fs.unlink(path);
  assert.equal(await work,'processed');
  await assert.rejects(fs.access(path),{code:'ENOENT'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('invalid or stale locks are never stolen and failed work releases only its acquired lock',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-chapter-lock-')),path=join(root,'owner-review.lock');
 try{
  for(const value of ['invalid','2147483647']){
   await fs.writeFile(path,value);
   await assert.rejects(withChapterProcessingLock(root,()=>assert.fail('must not start')),/chapter processing lock/);
   assert.equal(await fs.readFile(path,'utf8'),value);
  }
  await fs.unlink(path);
  await assert.rejects(withChapterProcessingLock(root,async()=>{throw Error('review failed');}),/review failed/);
  await assert.rejects(fs.access(path),{code:'ENOENT'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('concurrent work serializes and a replaced lock is retained for inspection',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-chapter-lock-')),path=join(root,'owner-review.lock');
 try{
  let active=0,maximum=0;
  await Promise.all([1,2,3].map(()=>withChapterProcessingLock(root,async()=>{
   active++;maximum=Math.max(maximum,active);await wait(5);active--;
  },{retryMilliseconds:2})));
  assert.equal(maximum,1);
  await assert.rejects(withChapterProcessingLock(root,async()=>{
   await fs.rename(path,path+'.original');
   await fs.writeFile(path,'replacement');
  }),/changed ownership/);
  assert.equal(await fs.readFile(path,'utf8'),'replacement');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('pause cancels only waiting work, while explicit independent work can fail fast',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-chapter-lock-')),path=join(root,'owner-review.lock');
 try{
  await fs.writeFile(path,String(process.pid));
  await assert.rejects(withChapterProcessingLock(root,()=>assert.fail('must not start'),{waitForOwner:false}),/already held/);
  let allowed=true;
  const pending=withChapterProcessingLock(root,()=>assert.fail('must not start'),{retryMilliseconds:2,shouldAcquire:async()=>allowed});
  await wait(10);allowed=false;
  await assert.rejects(pending,{code:'CHAPTER_PROCESSING_PAUSED'});
  assert.equal(await fs.readFile(path,'utf8'),String(process.pid));
  assert.deepEqual((await fs.readdir(root)),['owner-review.lock']);
  await fs.unlink(path);
  await withChapterProcessingLock(root,async()=>{allowed=false;assert.equal(await fs.readFile(path,'utf8'),String(process.pid));});
  await assert.rejects(fs.access(path),{code:'ENOENT'});
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
