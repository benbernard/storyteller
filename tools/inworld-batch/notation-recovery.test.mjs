import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {hash,sha,assertBudget} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {buildChapter} from './prepare.mjs';
import {notationPolicy,notationRenderer,chapterNotationManifest,replayNotationInput} from './notation-recovery.mjs';
import {preflightNotationRecovery,recoverVisualRedactionPassage,canonicalHash} from './rendering-recovery.mjs';
import {renderingContext} from './rendering-review.mjs';
import {pcmASRModels} from './pcm-symbol-evidence.mjs';
import {reviewInstructions} from './adjudication.mjs';

import {read,save,fixture} from './notation-test-fixture.mjs';

test('legacy normalization is replayed by exact historical module hash without changing queued inputs',async()=>{
 const f=await fixture();try{
  const plan=structuredClone(f.notation.manifest.preparedPlan);
  plan.segments[0].text='Weight: 12.5kg (+0%).';
  const texts=JSON.stringify(plan.segments.map(s=>s.text));
  const old=spawnSync('python3',[resolve('tools/inworld-batch/normalization/replay_v1.py')],{input:texts,encoding:'utf8'});
  assert.equal(old.status,0);
  const chapter=buildChapter(plan,JSON.parse(old.stdout),f.config),manifest=structuredClone(f.notation.manifest);
  manifest.preparedPlan=plan;manifest.inputHash=hash(chapter);
  manifest.normalizationModules['tools/mac-tts/acting-auditions/speech_parts.py']=sha(await fs.readFile(resolve('tools/inworld-batch/normalization/speech_parts_v1.py')));
  const materials={manifest,hash:fingerprint(manifest),evidence:f.notation.evidence},before=JSON.stringify(chapter);
  assert.match(chapter.items[0].spokenText,/twelve\.5kg/);
  assert.equal(await replayNotationInput(chapter,materials,f.config),true);
  assert.equal(JSON.stringify(chapter),before);
  const current=spawnSync('python3',[resolve('tools/inworld-batch/normalize.py')],{input:texts,encoding:'utf8'});
  assert.equal(current.status,0);assert.match(JSON.parse(current.stdout)[0],/twelve point five kg/);
  materials.manifest.normalizationModules['tools/mac-tts/acting-auditions/speech_parts.py']='0'.repeat(64);
  materials.hash=fingerprint(materials.manifest);await assert.rejects(()=>replayNotationInput(chapter,materials,f.config));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('three reviewed notation children share one durable allowance and retain all other source/audio/counters',async()=>{
 const f=await fixture();try{const before=await fs.readFile(join(f.folder,'input.json')),plans=await f.preflight();assert.equal(plans.flatMap(p=>p.plan.parts.filter(c=>!c.reused)).length,3);await f.pin();for(const target of plans)await f.recover(target);assert.equal(f.paid(),3);assert.deepEqual(await fs.readFile(join(f.folder,'input.json')),before);
 for(const target of plans){const receipt=await read(join(f.folder,'receipts',target.item.customId+'.json'));assert.deepEqual(receipt.repair,f.originals.get(target.item.customId).receipt.repair);const context=await renderingContext(f.folder,target.item);assert.equal(context.renderingProof.policy,notationPolicy);assert.equal(context.audioSha256,receipt.sha256);}
 for(const target of await f.preflight())await f.recover(target);assert.equal(f.paid(),3);
 const changed=structuredClone(f.notation.manifest);changed.passages.pop();const priorHash=f.notation.hash;f.notation.manifest=changed;f.notation.hash=fingerprint(changed);await assert.rejects(f.preflight);assert.equal(f.paid(),3);f.notation.hash=priorHash;
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('all-target preflight rejects immutable provenance/selection/context/voice/cap corruption before any submission',async()=>{
 const mutations=[f=>{f.entry.inputHash='bad';},f=>{f.config.maxRetakes=3;},f=>{f.notation.manifest.inputHash='0'.repeat(64);},f=>{f.notation.manifest.sourceObjectHash='0'.repeat(64);},f=>{f.notation.manifest.preparedPlan.title='changed';},f=>{f.notation.manifest.normalizationModules['tools/inworld-batch/normalize.py']='0'.repeat(64);},f=>{f.notation.manifest.passages[0].sourceRanges[0].itemStart++;},f=>{f.notation.manifest.passages[0].unitField.quantityHash='0'.repeat(64);},f=>{f.notation.manifest.passages[0].selectedChildren.push('ordinary-child');},f=>{f.notation.manifest.passages[0].originalReceiptHash='0'.repeat(64);},f=>{f.notation.evidence[Object.keys(f.notation.evidence)[0]].bytes=Buffer.from('tampered');}];
 for(const mutate of mutations){const f=await fixture();try{mutate(f);f.notation.hash=fingerprint(f.notation.manifest);await assert.rejects(f.preflight);assert.equal(f.paid(),0);assert.deepEqual(await read(join(f.root,'jobs.json')),[]);}finally{await fs.rm(f.root,{recursive:true,force:true});}}
 const f=await fixture();try{const child=f.originals.values().next().value.parts[0].item;await fs.writeFile(join(f.folder,'repairs',f.chapter.items[0].customId,'attempt-2/audio',child.customId+'.wav'),'changed retained audio');await assert.rejects(f.preflight);assert.equal(f.paid(),0);}finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('completed later-target audio and saved acoustic corruption block an earlier pending target before new payment',async()=>{
 for(const what of ['audio','evidence','duration','schema','policy','receipt-field']){const f=await fixture();try{const plans=await f.preflight();await f.pin();await f.recover(plans[1]);const count=f.paid();if(what==='audio')await fs.writeFile(join(f.folder,'audio',plans[1].item.customId+'.wav'),'corrupt');else if(what==='evidence'){const digest=f.notation.manifest.evidence[0].sha256;await fs.writeFile(join(f.folder,'rendering-recoveries',notationPolicy,plans[1].item.customId,'evidence',digest+'.json'),'corrupt');}else{const path=join(f.folder,'receipts',plans[1].item.customId+'.json'),value=await read(path);if(what==='duration')delete value.duration;else if(what==='schema')value.renderingRecovery.schemaVersion=9;else if(what==='policy')value.renderingRecovery.rendererVersion='other';else value.unreviewed='changed';await save(path,value);}await assert.rejects(f.preflight);assert.equal(f.paid(),count);}finally{await fs.rm(f.root,{recursive:true,force:true});}}
});

test('source notation resumes the exact prepared audio/receipt promotion without new paid submissions',async()=>{
 const f=await fixture();try{const plans=await f.preflight();await f.pin();let failed=false;const crash=async(path,value)=>{if(!failed&&path===join(f.folder,'receipts',plans[0].item.customId+'.json')&&value.renderingRecovery){failed=true;throw Error('crash after audio');}await save(path,value);};await assert.rejects(()=>f.recover(plans[0],crash),/crash after audio/);const count=f.paid();const resumed=await f.preflight();await f.recover(resumed[0]);assert.equal(f.paid(),count);assert.equal((await read(join(f.folder,'receipts',plans[0].item.customId+'.json'))).repair.attempt,2);}finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('uncertain submission and the existing shared ceiling prevent duplicate or fourth migration work',async()=>{
 const f=await fixture();try{const plans=await f.preflight();await f.pin();await f.recover(plans[0]);f.setUncertain(true);await assert.rejects(()=>f.recover(plans[1]),/Uncertain/);const before=await fs.readFile(join(f.root,'jobs.json')),count=f.paid();await assert.rejects(()=>f.recover(plans[1]),/Uncertain/);assert.equal(f.paid(),count);assert.deepEqual(await fs.readFile(join(f.root,'jobs.json')),before);}finally{await fs.rm(f.root,{recursive:true,force:true});}
 const g=await fixture();try{const plans=await g.preflight();await g.pin();await save(join(g.root,'jobs.json'),[{phase:'submitting',items:[{customId:'held-elsewhere'}],reservedUSD:50}]);await assert.rejects(()=>g.recover(plans[0]),/budget|ceiling/i);assert.equal(g.paid(),0);}finally{await fs.rm(g.root,{recursive:true,force:true});}
});

test('subscription instructions bind finite source notation without granting a normalization waiver',()=>{
 assert.match(reviewInstructions,/source-numeric-notation-v1/);assert.match(reviewInstructions,/never guesses a unit expansion/);assert.match(reviewInstructions,/including every reused clip/);assert.match(reviewInstructions,/immutable original queued string/);
});
