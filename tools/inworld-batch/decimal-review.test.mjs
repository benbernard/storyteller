import test from 'node:test';
import {diagnosisFor} from './decimal-test-fixture.mjs';
import assert from 'node:assert/strict';
import {hash} from './core.mjs';
import {pcmASRModels} from './pcm-symbol-evidence.mjs';
import {evidenceRow,modelReview,needsModelReview,reviewInstructions} from './adjudication.mjs';

function evidence(){
 const item={customId:'s0001p0',role:'author-note',spokenText:'Mass twelve.5kg remains.'};
 const context={audioSha256:'current-audio',comparisonExpected:'Mass twelve point five kg remains.',renderingProof:{policy:'source-numeric-notation-v1'},decimalRecovery:{policy:'legacy-adjacent-decimal-v1',planHash:'bound-plan',manifestHash:'bound-manifest',freshFullQARequired:true}};
 const report={expected:item.spokenText,sha256:context.audioSha256,severity:'pass',comparisonExpected:context.comparisonExpected,renderingContext:context,attempts:[{model:pcmASRModels.small,transcript:context.comparisonExpected},{model:pcmASRModels.strong,transcript:context.comparisonExpected}]};
 const phone={audioSha256:report.sha256,inputPrompt:null,phonemes:'unprompted independent phones'};
 return {item,context,report,phone};
}

test('decimal review retains queued expected and requires subscription review despite ASR pass',()=>{
 const {item,context,report,phone}=evidence();
 const row=evidenceRow(item,report,phone,[],context);
 assert.equal(row.expected,item.spokenText);assert.equal(row.comparisonExpected,context.comparisonExpected);
 assert.equal(needsModelReview(item,report,{decimalRecovery:context.decimalRecovery}),true);
 assert.match(reviewInstructions,/legacy-adjacent-decimal-v1/);
 assert.match(reviewInstructions,/no acceptance of a disputed unit pronunciation/);
});

test('decimal review cannot accept single-model, duplicate-model, stale audio or context evidence',()=>{
 const {item,context,report,phone}=evidence();
 for(const attempts of [report.attempts.slice(0,1),[report.attempts[0],report.attempts[0]],[...report.attempts].reverse(),report.attempts.map(row=>({...row,model:'arbitrary'})),[{},{}]])
  assert.throws(()=>evidenceRow(item,{...report,attempts},phone,[],context),/both independent/);
 assert.throws(()=>evidenceRow(item,report,{...phone,audioSha256:'old-audio'},[],context),/Stale/);
 assert.throws(()=>evidenceRow(item,report,phone,[],{...context,decimalRecovery:{...context.decimalRecovery,planHash:'different'}}),/Unbound/);
 assert.throws(()=>evidenceRow(item,{...report,comparisonExpected:'Mass twelve kg remains.'},phone,[],context),/Unbound/);
 assert.throws(()=>evidenceRow(item,report,phone,[]),/verified recovery/);
});

test('decimal decision row hashes bind audio, both transcripts, phonemes and layered policy',()=>{
 const {item,context,report,phone}=evidence(),row=evidenceRow(item,report,phone,[],context);
 const held={...report,severity:'major'},decision={severity:'pass',evidenceHash:hash(row)};
 assert.equal(modelReview(held,decision,row).severity,'pass');
 const changed=[{...row,phonemes:'different'},{...row,audioSha256:'old'},
  {...row,attempts:[...row.attempts.slice(0,1),{...row.attempts[1],transcript:'different'}]},
  {...row,renderingContext:{...context,decimalRecovery:{...context.decimalRecovery,manifestHash:'different'}}}];
 for(const value of changed)assert.equal(modelReview(held,decision,value).severity,'major');
});

import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {sha} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {buildDecimalRecoveryPlan,decimalNormalizationProof,decimalPolicy,decimalReceipt} from './decimal-plan.mjs';
import {validateDecimalContext,decimalContext} from './decimal-review.mjs';

function wav(pcm){
 const result=Buffer.alloc(44+pcm.length);result.write('RIFF');result.writeUInt32LE(result.length-8,4);result.write('WAVEfmt ',8);
 result.writeUInt32LE(16,16);result.writeUInt16LE(1,20);result.writeUInt16LE(1,22);result.writeUInt32LE(48000,24);result.writeUInt32LE(96000,28);
 result.writeUInt16LE(2,32);result.writeUInt16LE(16,34);result.write('data',36);result.writeUInt32LE(pcm.length,40);pcm.copy(result,44);return result;
}
function layerFixture(){
 const canonical='12.5kg',normalization=decimalNormalizationProof(canonical),source={text:'Weight: '+canonical+' '+Array.from({length:12},(_,i)=>'Part '+i+'.').join(' ')};
 const originals=Array.from({length:13},(_,i)=>{const spokenText=i===0?'Weight: '+normalization.legacy:'Part '+(i-1)+'.';return {customId:'child'+i,role:'author-note',spokenText,request:{text:'[read] '+spokenText}};});
 const item={customId:'s0001p0',role:'author-note',spokenText:originals.map(row=>row.spokenText).join(' '),request:{text:'unused parent'}};
 const chapter={chapterId:'synthetic',source:'source-id',items:[item],segments:[{text:source.text,spans:[{start:0,end:source.text.length}],items:[item.customId]}]};
 const attempt2Plan={attempt:2,items:originals},basePlan={notationManifestHash:sha('notation-manifest'),parts:originals.map(row=>({id:row.customId,root:'repairs/s0001p0/attempt-2',reused:true,replacement:null}))};
 const pcms=originals.map((_,i)=>Buffer.alloc(960,i+1)),baseAudio=wav(Buffer.concat(pcms));
 const baseReceipt={sha256:sha(baseAudio),duration:13*.01,voiceId:'female',requestHash:hash({...item.request,voiceId:'female'}),repair:{attempt:2,planHash:hash(attempt2Plan)},renderingRecovery:{rendererVersion:'source-numeric-notation-v1',planHash:fingerprint(basePlan)}};
 const baseContext={comparisonExpected:item.spokenText,renderingProof:{policy:'source-numeric-notation-v1',text:item.spokenText,fingerprint:'base-proof',mapping:[{kind:'copy',sourceStart:0,sourceEnd:item.spokenText.length,spokenStart:0,spokenEnd:item.spokenText.length}]},planHash:fingerprint(basePlan),audioSha256:baseReceipt.sha256,receiptHash:fingerprint(baseReceipt)};
 const children=originals.map((row,index)=>({item:row,root:basePlan.parts[index].root,receipt:{sha256:sha(wav(pcms[index])),voiceId:'female',requestHash:hash({...row.request,voiceId:'female'}),duration:.01,job:'old-job'},audioSha256:sha(wav(pcms[index])),audio:wav(pcms[index])}));
 const manifest={schemaVersion:1,policy:decimalPolicy,maximumSelectedChildren:1,maximumSubmissions:1,chapterId:chapter.chapterId,passage:item.customId,originalChild:originals[0].customId,inputHash:hash(chapter),sourceObjectHash:fingerprint(source),canonicalTextSha256:sha(source.text),baseReceiptHash:fingerprint(baseReceipt),baseAudioSha256:baseReceipt.sha256,baseContextHash:fingerprint(baseContext),baseNotationPlanHash:baseContext.planHash,baseNotationManifestHash:basePlan.notationManifestHash,sourceRange:{start:8,end:14,sha256:sha(canonical)},queuedRange:{start:8,end:8+normalization.legacy.length,sha256:sha(normalization.legacy)},normalization,parts:children.map(child=>({id:child.item.customId,root:child.root,itemHash:hash(child.item),receiptHash:fingerprint(child.receipt),audioSha256:child.audioSha256}))};
 const report={expected:item.spokenText,sha256:baseReceipt.sha256,severity:'minor'},decision={audioSha256:baseReceipt.sha256,reportHash:hash(report),severity:'major'};manifest.diagnosis=diagnosisFor(children[0].audio,report,decision);
 const plan=buildDecimalRecoveryPlan({chapter,item,source,baseReceipt,baseContext,basePlan,attempt2Plan,children,manifest});
 const finalChildren=plan.parts.map((part,index)=>{const audio=wav(index===0?Buffer.alloc(960,22):pcms[index]);return {id:part.id,root:part.root,audio,receipt:part.reused?children[index].receipt:{sha256:sha(audio),voiceId:'female',requestHash:hash({...part.replacement.request,voiceId:'female'}),duration:.01,job:'new-job'}};});
 const currentAudio=wav(Buffer.concat(finalChildren.map(part=>part.audio.subarray(44)))),receipt=decimalReceipt(baseReceipt,plan,{audioSha256:sha(currentAudio),duration:.13,parts:finalChildren.map(part=>({id:part.id,root:part.root,sha256:part.receipt.sha256,job:part.receipt.job,reused:part.id!=='child0dp1'}))});
 return {chapter,item,source,receipt,plan,baseReceipt,baseContext,basePlan,attempt2Plan,children,manifest,report,decision,baseAudio,finalChildren,currentAudio};
}

test('decimal comparison layer changes exactly one field and retains all original notation proof',()=>{
 const data=layerFixture(),before=fingerprint(data),context=validateDecimalContext(data);
 assert.equal(fingerprint(data),before);assert.equal(context.renderingProof.policy,decimalPolicy);
 assert.equal(context.comparisonExpected,data.baseContext.comparisonExpected.replace('twelve.5kg','twelve point five kg'));
 assert.equal(context.baseRenderingContext,data.baseContext);assert.equal(data.receipt.renderingRecovery,data.baseReceipt.renderingRecovery);
 assert.equal(context.audioSha256,data.receipt.sha256);assert.equal(context.decimalRecovery.freshFullQARequired,true);
 assert.equal(data.plan.parts.filter(part=>part.reused).length,12);assert.equal(data.receipt.repair.attempt,2);
});

test('decimal comparison rejects altered source, base, audio, plan, child provenance and extra receipt deltas',()=>{
 const edits=[d=>d.source.text+=' extra',d=>d.baseContext.comparisonExpected+=' extra',d=>d.baseAudio[50]^=1,d=>d.plan.renderingProof.text+=' extra',
  d=>d.receipt.renderingRecovery={...d.receipt.renderingRecovery,changed:true},d=>d.receipt.repair={...d.receipt.repair,attempt:3},
  d=>d.receipt.decimalRecovery.manifestHash=sha('other'),d=>d.receipt.decimalRecovery.parts[1].sha256=sha('other'),
  d=>d.finalChildren[1].audio[50]^=1,d=>d.finalChildren[0].receipt.requestHash=sha('other'),d=>d.currentAudio[50]^=1,
  d=>d.receipt.duration=.5,d=>d.receipt.ownerReview={accepted:true},d=>d.manifest.maximumSubmissions=2,d=>d.item.spokenText+=' extra'];
 for(const edit of edits){const data=layerFixture();edit(data);assert.throws(()=>validateDecimalContext(data));}
});

test('decimal verification rejects a hash-bound base parent that is not its thirteen children',()=>{
 const data=layerFixture();data.baseAudio[50]^=1;
 data.baseReceipt.sha256=sha(data.baseAudio);
 data.baseContext.audioSha256=data.baseReceipt.sha256;data.baseContext.receiptHash=fingerprint(data.baseReceipt);
 data.manifest.baseReceiptHash=fingerprint(data.baseReceipt);data.manifest.baseAudioSha256=data.baseReceipt.sha256;data.manifest.baseContextHash=fingerprint(data.baseContext);
 data.plan=buildDecimalRecoveryPlan(data);
 data.receipt=decimalReceipt(data.baseReceipt,data.plan,{audioSha256:sha(data.currentAudio),duration:.13,parts:data.receipt.decimalRecovery.parts});
 assert.throws(()=>validateDecimalContext(data));
});

async function diskLayer(){
 const data=layerFixture(),root=await fs.mkdtemp(join(tmpdir(),'decimal-review-'));
 const write=async(path,value)=>{const file=join(root,path);await fs.mkdir(dirname(file),{recursive:true});await fs.writeFile(file,Buffer.isBuffer(value)?value:JSON.stringify(value));};
 await write('input.json',data.chapter);await write('source.json',data.source);
 const dir=`rendering-recoveries/${decimalPolicy}/${data.item.customId}`;
 for(const [file,value]of Object.entries({'manifest.json':data.manifest,'plan.json':data.plan,'base-receipt.json':data.baseReceipt,'base.wav':data.baseAudio,'base-context.json':data.baseContext,'base-plan.json':data.basePlan,'attempt2-plan.json':data.attempt2Plan,'original-review.json':data.report,'original-decision.json':data.decision}))await write(dir+'/'+file,value);
 await write(`rendering-recoveries/${decimalPolicy}/manifest.json`,data.manifest);
 await write('rendering-recoveries/source-numeric-notation-v1/s0001p0/plan.json',data.basePlan);
 await write('repairs/s0001p0/attempt-2/plan.json',data.attempt2Plan);
 for(const child of data.children){await write(child.root+'/receipts/'+child.item.customId+'.json',child.receipt);const final=data.finalChildren.find(row=>row.id===child.item.customId);await write(child.root+'/audio/'+child.item.customId+'.wav',final?final.audio:wav(Buffer.alloc(960,1)));}
 for(const child of data.finalChildren){await write(child.root+'/receipts/'+child.id+'.json',child.receipt);await write(child.root+'/audio/'+child.id+'.wav',child.audio);}
 await write('audio/'+data.item.customId+'.wav',data.currentAudio);
 return {data,root,dir,write};
}

test('saved decimal layer requires chapter-wide manifest and exact retained base context',async()=>{
 const {data,root,dir,write}=await diskLayer();
 try{
  assert.equal((await decimalContext(root,data.item,data.receipt,data.baseContext)).comparisonExpected,data.plan.renderingProof.text);
  await write(dir+'/base-context.json',{...data.baseContext,audioSha256:sha('other')});
  await assert.rejects(decimalContext(root,data.item,data.receipt,data.baseContext));
  await write(dir+'/base-context.json',data.baseContext);
  await write(`rendering-recoveries/${decimalPolicy}/manifest.json`,{...data.manifest,maximumSubmissions:2});
  await assert.rejects(decimalContext(root,data.item,data.receipt,data.baseContext));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
