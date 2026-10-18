import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {hash} from './core.mjs';
import {effectiveReview,processingOnlyEntry} from './owner-review.mjs';

test('owner acceptance preserves evidence and cannot carry over to changed audio or review',()=>{
 const report={sha256:'a'.repeat(64),severity:'major',expected:'Ohhh',attempts:[{transcript:'Oh'}]};
 const decision={action:'accept',audioSha256:report.sha256,reportHash:hash(report),reason:'Accepted expressive spelling.',ownerInstruction:'The others sound reasonable.',recordedAt:'2026-10-14T15:00:00Z'};
 assert.equal(effectiveReview(report).severity,'major');
 assert.equal(effectiveReview(report,decision).severity,'minor');
 assert.equal(report.severity,'major');
 assert.deepEqual(effectiveReview(report,decision).attempts,report.attempts);
 for(const changed of [{...report,sha256:'b'.repeat(64)},{...report,expected:'Wait'},{...report,attempts:[]}])assert.throws(()=>effectiveReview(changed,decision),/stale/);
 assert.throws(()=>effectiveReview(report,{...decision,reason:''}));
});

test('processing-only work cannot select an ungenerated, active or changed chapter',()=>{
 const chapter={chapterId:'rr-261',items:[]},entry={chapterId:'rr-261',inputHash:hash(chapter)},config={chapters:[entry]};
 const processing={status:'needs-review'},generated={inputHash:entry.inputHash};
 assert.equal(processingOnlyEntry(config,'rr-261',processing,generated,chapter),entry);
 for(const state of [null,{status:'running'},{status:'published'}])assert.throws(()=>processingOnlyEntry(config,'rr-261',state,generated,chapter));
 assert.throws(()=>processingOnlyEntry(config,'rr-261',processing,null,chapter));
 assert.throws(()=>processingOnlyEntry(config,'rr-261',processing,generated,{...chapter,items:['changed']}));
 assert.throws(()=>processingOnlyEntry(config,'rr-other',processing,generated,chapter));
});

test('processing-only review retains an unaccepted omission without touching producer state or provider',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-owner-review-test-')),dir=join(root,'261');await fs.mkdir(join(dir,'review'),{recursive:true});await fs.mkdir(join(dir,'receipts'));
 const report={sha256:'a'.repeat(64),expected:'Presence missing',severity:'major'};
 const chapter={chapterId:'rr-261',items:[{customId:'s0000p0',role:'author-note',spokenText:report.expected}]};
 const entry={chapterId:'rr-261',sequence:261,root:dir,inputHash:hash(chapter)};
 const writes={'input.json':chapter,'generated.json':{inputHash:entry.inputHash},'processing.json':{status:'needs-review'},'review/s0000p0.json':report,'receipts/s0000p0.json':{sha256:report.sha256}};
 for(const [name,data]of Object.entries(writes))await fs.writeFile(join(dir,name),JSON.stringify(data));
 const bin=join(root,'bin');await fs.mkdir(bin);
 const calls=join(root,'calls');
 await fs.writeFile(join(bin,'ssh'),'#!/bin/sh\necho provider-called >> "'+calls+'"\nexit 1\n',{mode:0o755});
 await fs.writeFile(join(bin,'rsync'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 const config={root,host:'test',archive:'/test',chapters:[entry],python:'/usr/bin/true'};
 await fs.writeFile(join(root,'queue.json'),JSON.stringify(config));
 await fs.writeFile(join(root,'worker.lock'),'active-producer');await fs.writeFile(join(root,'status.json'),'producer-status');await fs.writeFile(join(root,'processing-status.json'),'producer-processing');
 try{
  const run=spawnSync(process.execPath,[resolve('tools/inworld-batch/runner.mjs'),join(root,'queue.json'),'--process-only','rr-261'],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH},timeout:10000});
  assert.equal(run.status,0,run.stderr+await fs.readFile(join(dir,'owner-processing-status.json'),'utf8'));
  assert.equal(await fs.readFile(join(root,'worker.lock'),'utf8'),'active-producer');
  assert.equal(await fs.readFile(join(root,'status.json'),'utf8'),'producer-status');
  assert.equal(await fs.readFile(join(root,'processing-status.json'),'utf8'),'producer-processing');
  assert.equal(JSON.parse(await fs.readFile(join(dir,'processing.json'),'utf8')).status,'needs-review');
  await assert.rejects(fs.access(calls));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
