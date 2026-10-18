import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {sha,hash} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {decimalPolicy,decimalNormalizationProof} from './decimal-plan.mjs';
import {decimalFixture} from './decimal-test-fixture.mjs';
import {read,save,wave} from './notation-test-fixture.mjs';
import {renderingContext} from './rendering-review.mjs';
import {validateDecimalDiagnosis} from './decimal-diagnosis.mjs';
const cleanup=f=>fs.rm(f.root,{recursive:true,force:true});

test('one distinct legacy decimal child preserves the exhausted notation base, twelve current WAVs, input and cap',async()=>{
 const f=await decimalFixture();try{
  const before=await fs.readFile(join(f.folder,'input.json')),jobs=await read(join(f.root,'jobs.json')),paid=f.paid(),planned=await f.decimalPreflight();assert.equal(planned.plan.parts.filter(p=>!p.reused).length,1);assert.equal(planned.plan.parts.find(p=>!p.reused).id,f.manifest.originalChild+'dp1');
  assert.equal(await fs.access(join(f.folder,'rendering-recoveries',decimalPolicy)).then(()=>true,()=>false),false);
  await f.decimalRecover();assert.equal(f.paid(),paid+1);assert.deepEqual((await read(join(f.root,'jobs.json'))).slice(0,jobs.length),jobs);assert.deepEqual(await fs.readFile(join(f.folder,'input.json')),before);
  const receipt=await read(join(f.folder,'receipts',f.item.customId+'.json'));assert.deepEqual(receipt.renderingRecovery,f.baseReceipt.renderingRecovery);assert.deepEqual(receipt.repair,f.baseReceipt.repair);assert.equal(receipt.repair.attempt,2);
  for(const child of f.children)assert.equal(sha(await fs.readFile(join(f.folder,child.root,'audio',child.item.customId+'.wav'))),child.audioSha256);
  const context=await renderingContext(f.folder,f.item);assert.equal(context.renderingProof.policy,decimalPolicy);assert.equal(context.decimalRecovery.freshFullQARequired,true);assert.equal(context.audioSha256,receipt.sha256);assert.equal(receipt.decimalRecovery.parts.filter(p=>p.reused).length,12);
  await f.decimalRecover();assert.equal(f.paid(),paid+1);
  const other=structuredClone(f.manifest);other.originalChild=f.basePlan.parts.find(p=>!p.reused).originalId;f.args.manifest=other;await assert.rejects(f.decimalRecover);assert.equal(f.paid(),paid+1);
 }finally{await cleanup(f);}
});

test('every reviewed source, base, selection, hold and acoustic binding fails before the decimal submission',async()=>{
 const changes=[f=>f.manifest.inputHash='bad',f=>f.manifest.sourceRange.start++,f=>f.manifest.queuedRange.end++,f=>f.manifest.normalization.text+=' extra',f=>f.manifest.baseAudioSha256='bad',f=>f.manifest.baseReceiptHash='bad',f=>f.manifest.baseContextHash='bad',f=>f.manifest.parts[3].audioSha256='bad',f=>f.manifest.originalChild=f.basePlan.parts.find(p=>!p.reused).originalId,f=>f.manifest.maximumSelectedChildren=2,f=>f.config.maxRetakes=3,f=>f.manifest.diagnosis.reportHash='bad',f=>f.manifest.diagnosis.decisionHash='bad',f=>f.manifest.diagnosis.small.json+=' ',f=>{const raw=JSON.parse(f.manifest.diagnosis.strong.json);raw.model='wrong-model';f.manifest.diagnosis.strong={json:JSON.stringify(raw),sha256:sha(JSON.stringify(raw))};},f=>{const raw=JSON.parse(f.manifest.diagnosis.phones.json);raw.inputPrompt='prompt';f.manifest.diagnosis.phones={json:JSON.stringify(raw),sha256:sha(JSON.stringify(raw))};}];
 for(const change of changes){const f=await decimalFixture();try{const paid=f.paid();change(f);await assert.rejects(f.decimalRecover);assert.equal(f.paid(),paid);}finally{await cleanup(f);}}
});

test('prepared decimal promotion resumes at either receipt/audio crash point without another submission',async()=>{
 for(const phase of ['receipt','journal']){const f=await decimalFixture();try{let crashed=false;const dir=join(f.folder,'rendering-recoveries',decimalPolicy,f.item.customId);const failSave=async(path,value)=>{if(!crashed&&(phase==='receipt'&&path===join(f.folder,'receipts',f.item.customId+'.json')&&value.decimalRecovery||phase==='journal'&&path===join(dir,'promotion.json')&&value.state==='complete')){crashed=true;throw Error('intentional crash');}await save(path,value);};await assert.rejects(()=>f.decimalRecover({save:failSave}),/intentional crash/);const paid=f.paid();await f.decimalPreflight();await f.decimalRecover();assert.equal(f.paid(),paid);assert.equal((await read(join(dir,'promotion.json'))).state,'complete');await renderingContext(f.folder,f.item);}finally{await cleanup(f);}}
});

test('uncertain decimal submissions retain the existing shared reservation and never repeat or bypass the ceiling',async()=>{
 const f=await decimalFixture();try{f.setUncertain(true);await assert.rejects(f.decimalRecover,/Uncertain/);const paid=f.paid(),ledger=await fs.readFile(join(f.root,'jobs.json'));await assert.rejects(f.decimalRecover,/Uncertain/);assert.equal(f.paid(),paid);assert.deepEqual(await fs.readFile(join(f.root,'jobs.json')),ledger);}finally{await cleanup(f);}
 const g=await decimalFixture();try{await save(join(g.root,'jobs.json'),[{phase:'submitting',items:[{customId:'other-held'}],reservedUSD:50}]);const paid=g.paid();await assert.rejects(g.decimalRecover,/budget|ceiling/i);assert.equal(g.paid(),paid);}finally{await cleanup(g);}
});

test('source policy rejects partial units, inferred values and arbitrary fields while matching both pinned formatter APIs',()=>{
 for(const source of ['12.5kgx','12.5kgé','12.5kg\u0301','-12.5kg','12.5lb','012.5kg','12.5.6kg','ordinary'])assert.throws(()=>decimalNormalizationProof(source));
 for(const source of ['0.05kg','12.5kg','1234.567kg']){const proof=decimalNormalizationProof(source),result=spawnSync('python3',['tools/inworld-batch/normalize.py'],{input:JSON.stringify([source]),encoding:'utf8'});assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout)[0],proof.text);}
});

test('a self-consistent notation receipt cannot hide base PCM drift before the one decimal POST',async()=>{
 const f=await decimalFixture();try{
  const path=join(f.folder,'audio',f.item.customId+'.wav'),bytes=await fs.readFile(path);bytes[50]^=1;await fs.writeFile(path,bytes);
  const receipt=await read(join(f.folder,'receipts',f.item.customId+'.json'));receipt.sha256=sha(bytes);receipt.renderingRecovery.audioSha256=receipt.sha256;await save(join(f.folder,'receipts',f.item.customId+'.json'),receipt);
  const context=await renderingContext(f.folder,f.item);f.manifest.baseAudioSha256=receipt.sha256;f.manifest.baseReceiptHash=fingerprint(receipt);f.manifest.baseContextHash=fingerprint(context);
  const paid=f.paid();await assert.rejects(f.decimalPreflight,/PCM differs/);assert.equal(f.paid(),paid);
 }finally{await cleanup(f);}
});

test('corrupted pending audio or receipt fields cannot be installed or trigger another paid attempt',async()=>{
 for(const what of ['pcm','duration','schema','extra-field']){const f=await decimalFixture();try{
  const dir=join(f.folder,'rendering-recoveries',decimalPolicy,f.item.customId);const crash=async(path,value)=>{if(path===join(f.folder,'receipts',f.item.customId+'.json')&&value.decimalRecovery)throw Error('crash after audio');await save(path,value);};await assert.rejects(()=>f.decimalRecover({save:crash}),/crash after audio/);const paid=f.paid(),pending=await read(join(dir,'promotion.json'));
  await fs.copyFile(join(dir,'base.wav'),join(f.folder,'audio',f.item.customId+'.wav'));
  if(what==='pcm'){const bytes=await fs.readFile(join(dir,'replacement.wav'));bytes[60]^=1;await fs.writeFile(join(dir,'replacement.wav'),bytes);pending.receipt.sha256=sha(bytes);pending.receipt.decimalRecovery.audioSha256=sha(bytes);}
  if(what==='duration')delete pending.receipt.duration;
  if(what==='schema')pending.receipt.decimalRecovery.schemaVersion=9;
  if(what==='extra-field')pending.receipt.arbitrary='unreviewed';
  await save(join(dir,'promotion.json'),pending);await assert.rejects(f.decimalRecover);assert.equal(f.paid(),paid);assert.equal((await read(join(f.folder,'receipts',f.item.customId+'.json'))).decimalRecovery,undefined);
 }finally{await cleanup(f);}}
});

test('retained original diagnosis survives replacement or absence of the current QA files',async()=>{
 const f=await decimalFixture();try{await f.decimalRecover();const paid=f.paid();await fs.rm(join(f.folder,'review',f.item.customId+'.json'));await fs.rm(join(f.folder,'llm-decisions.json'));await f.decimalRecover();assert.equal(f.paid(),paid);await renderingContext(f.folder,f.item);}finally{await cleanup(f);}
});

test('the actual decimal CLI respects supervisor, paid-worker and chapter locks and rejects an unreviewed manifest before provider work',async()=>{
 const f=await decimalFixture();try{
  const manifestPath=join(f.root,'proposed.json'),configPath=join(f.root,'config.json');await save(manifestPath,f.manifest);await save(configPath,{...f.config,chapters:[f.entry],originalVoices:f.voices});const ledger=await fs.readFile(join(f.root,'jobs.json'));
  for(const lock of ['supervisor.lock','worker.lock','chapter']){const path=lock==='chapter'?join(f.folder,'owner-review.lock'):join(f.root,lock);await fs.writeFile(path,String(process.pid));const before=await fs.readFile(path);const result=spawnSync(process.execPath,['tools/inworld-batch/runner.mjs',configPath,'--recover-decimal',f.entry.chapterId,manifestPath,fingerprint(f.manifest)],{encoding:'utf8',timeout:20000});assert.equal(result.status,1);assert.deepEqual(await fs.readFile(path),before);assert.deepEqual(await fs.readFile(join(f.root,'jobs.json')),ledger);await fs.rm(path);}
  const result=spawnSync(process.execPath,['tools/inworld-batch/runner.mjs',configPath,'--recover-decimal',f.entry.chapterId,manifestPath,'0'.repeat(64)],{encoding:'utf8',timeout:20000});assert.equal(result.status,1);assert.match((await read(join(f.root,'rendering-recovery-status.json'))).reason,/reviewed manifest changed/);assert.deepEqual(await fs.readFile(join(f.root,'jobs.json')),ledger);for(const path of [join(f.root,'worker.lock'),join(f.folder,'owner-review.lock')])assert.equal(await fs.access(path).then(()=>true,()=>false),false);
 }finally{await cleanup(f);}
});
