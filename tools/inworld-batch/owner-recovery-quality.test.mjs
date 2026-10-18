import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {hash} from './core.mjs';
import {pcmASRModels} from './pcm-symbol-evidence.mjs';
import {decimalFixture} from './decimal-test-fixture.mjs';
import {read,save} from './notation-test-fixture.mjs';
import {renderingContext} from './rendering-review.mjs';
import {evidenceRow,reviewInstructions} from './adjudication.mjs';

test('quality keeps raw recovery rows cached, then applies exact owner acceptance without new inference',async()=>{
 const f=await decimalFixture();
 try{
  await f.decimalRecover();
  const rows=[],rawReports={};
  for(const [index,item]of f.chapter.items.entries()){
   const receipt=await read(join(f.folder,'receipts',item.customId+'.json')),context=await renderingContext(f.folder,item);
   const report={sha256:receipt.sha256,expected:item.spokenText,severity:'minor',attempts:[
    {model:pcmASRModels.small,transcript:context.comparisonExpected},
    {model:pcmASRModels.strong,transcript:context.comparisonExpected}],comparisonExpected:context.comparisonExpected,renderingContext:context};
   const phone={audioSha256:receipt.sha256,inputPrompt:null,phonemes:'independent synthetic phones'};
   await save(join(f.folder,'review',item.customId+'.json'),report);await save(join(f.folder,'phoneme-review',item.customId+'.json'),phone);
   rawReports[item.customId]=report;
   rows.push(evidenceRow(item,report,phone,{before:f.chapter.items[index-1]?.spokenText??'',after:f.chapter.items[index+1]?.spokenText??''},context));
  }
  const key=hash({instructions:reviewInstructions,model:'gpt-6.1-sol',rows}),proofPath=join(f.folder,'llm-review',key+'.json');
  const value={decisions:rows.map(row=>({passage:row.passage,severity:'major',reason:'Synthetic automated review holds the exact recording.'}))};
  await save(proofPath,{value,authentication:'chatgpt',rows});
  const target=f.item.customId,other=f.chapter.items.find(item=>item.customId!==target).customId;
  const owner={action:'accept',audioSha256:rawReports[target].sha256,reportHash:hash(rawReports[target]),reason:'Owner accepts this exact one-letter recording difference.',ownerInstruction:'Never block for one letter.',recordedAt:'2026-10-18T23:30:00Z'};
  await save(join(f.folder,'owner-reviews.json'),{[target]:owner});
  await save(join(f.folder,'generated.json'),{inputHash:f.entry.inputHash});
  const bin=join(f.root,'bin'),calls=join(f.root,'forbidden-calls');await fs.mkdir(bin);
  await fs.writeFile(join(bin,'rsync'),'#!/bin/sh\nexit 0\n',{mode:0o755});
  await fs.writeFile(join(bin,'ssh'),'#!/bin/sh\necho forbidden >> "'+calls+'"\nexit 1\n',{mode:0o755});
  const adapter=join(f.root,'forbidden-analysis.mjs');
  await fs.writeFile(adapter,"import fs from 'node:fs/promises';export async function runCodexAnalysis(){await fs.appendFile("+JSON.stringify(calls)+",'model called');throw Error('Unexpected model inference');}\n");
  const config={...f.config,chapters:[f.entry],host:'synthetic.invalid',archive:'/synthetic',python:'/usr/bin/true',phonemePython:'/usr/bin/true',analysisModule:adapter};
  await save(join(f.root,'queue.json'),config);
  for(const name of ['worker.lock','status.json','processing-status.json'])await fs.writeFile(join(f.root,name),'unchanged producer '+name);
  const run=spawnSync(process.execPath,[resolve('tools/inworld-batch/runner.mjs'),join(f.root,'queue.json'),'--process-only',f.entry.chapterId],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH},timeout:10000});
  assert.equal(run.status,0,run.stderr+await fs.readFile(join(f.folder,'owner-processing-status.json'),'utf8'));
  const reports=await read(join(f.folder,'effective-reviews.json')),decisions=await read(join(f.folder,'llm-decisions.json'));
  assert.equal(reports[target].severity,'minor');assert.equal(reports[target].automatedSeverity,'major');assert.deepEqual(reports[target].ownerReview,owner);
  assert.equal(reports[target].modelReview.severity,'major');assert.equal(reports[target].modelReview.reportHash,hash(rawReports[target]));
  assert.equal(reports[target].modelReview.evidenceHash,hash(rows.find(row=>row.passage===target)));assert.equal(reports[target].modelReview.proof,proofPath);
  assert.equal(reports[other].severity,'major');assert.deepEqual((await read(join(f.folder,'processing.json'))).passages,[other]);
  for(const item of f.chapter.items){assert.deepEqual(await read(join(f.folder,'review',item.customId+'.json')),rawReports[item.customId]);assert.equal(decisions[item.customId].reportHash,hash(rawReports[item.customId]));}
  for(const name of ['worker.lock','status.json','processing-status.json'])assert.equal(await fs.readFile(join(f.root,name),'utf8'),'unchanged producer '+name);
  await assert.rejects(fs.access(calls));await assert.rejects(fs.access(join(f.folder,'assembly.json')));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
