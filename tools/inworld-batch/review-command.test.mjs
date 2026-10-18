import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {asrReviewCommand} from './review-command.mjs';

test('automatic GPU ASR is limited to a matching installed Mac runtime and does not nest leases',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'review-command-')),runtime=join(root,'runtime'),here=join(runtime,'tools/inworld-batch'),credential=join(root,'.local/share/mac-tts/auth.json');
 const config={python:'/review/python',sourceRoot:runtime,sourceCommit:'a'.repeat(40)};
 const cpu={command:'/usr/bin/nice',args:['-n','15',config.python,join(here,'review.py'),'/chapter']};
 try{
  await fs.mkdir(runtime,{recursive:true});await fs.writeFile(join(runtime,'source-commit.txt'),config.sourceCommit+'\n');
  await fs.mkdir(join(root,'.local/share/mac-tts'),{recursive:true});await fs.writeFile(credential,'not read by command selection');
  const options={platform:'darwin',home:root,env:{}};
  const selected=await asrReviewCommand(config,here,'/chapter',options);
  assert.deepEqual(selected,{command:'/usr/bin/nice',args:['-n','15',process.execPath,join(here,'review-gpu.mjs'),credential,'--auto','--',config.python,join(here,'review.py'),'/chapter']});
  for(const alternate of [{...options,platform:'linux'},{...options,env:{INWORLD_REVIEW_GPU_LEASE:'1'}}])assert.deepEqual(await asrReviewCommand(config,here,'/chapter',alternate),cpu);
  assert.deepEqual(await asrReviewCommand({...config,sourceRoot:undefined},here,'/chapter',options),cpu);
  assert.deepEqual(await asrReviewCommand({...config,sourceCommit:'b'.repeat(40)},here,'/chapter',options),cpu);
  await fs.unlink(credential);assert.deepEqual(await asrReviewCommand(config,here,'/chapter',options),cpu);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
