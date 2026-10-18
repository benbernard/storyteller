import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {hash,sha} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {renderVisualRedactions,verifyVisualRedactions} from '../audiobooks/dist/spoken-redactions.js';
import {buildRenderingRecoveryPlan,recoveryPolicy} from './rendering-recovery.mjs';
import {buildPCMExcision,decodePCM16,replacePCM} from './pcm-excision-core.mjs';
import {editedPCMReceipt,excisionDirectory} from './pcm-excision-evidence.mjs';
import {baseRenderingContext,renderingContext} from './rendering-review.mjs';
import {planPCMExcision,assertPCMRuntime,applyPCMExcision,rollbackPCMExcision} from './pcm-excision.mjs';
import {pcmASRModels} from './pcm-symbol-evidence.mjs';
import {rollbackPlan,validateCorrection} from './pcm-rollback.mjs';
import {evidenceRow,modelReview} from './adjudication.mjs';
const save=async(path,value)=>{await fs.mkdir(dirname(path),{recursive:true});await fs.writeFile(path,JSON.stringify(value,null,2)+'\n');};
const read=async path=>JSON.parse(await fs.readFile(path,'utf8'));
function wave(pcm,placeholder=false){const b=Buffer.alloc(44);b.write('RIFF');b.writeUInt32LE(pcm.length+36,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(48000,24);b.writeUInt32LE(96000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(placeholder?0xffffffff:pcm.length,40);return Buffer.concat([b,pcm]);}
function samples(frames){const b=Buffer.alloc(frames*2);for(let i=0;i<frames;i++)b.writeInt16LE(i%199-99,i*2);return b;}
async function fixture({start=10000,end=11000}={}){
 const root=await fs.mkdtemp(join(tmpdir(),'pcm-excision-')),folder=join(root,'chapter'),candidateDirectory=join(root,'candidate');
 const texts=['Before ██ after.','Target grade E+ ordinary words.','End.'],spokenText=texts.join(' '),item={customId:'passage',role:'narrator',spokenText,request:{text:'[read] '+spokenText}},source={text:spokenText},chapter={chapterId:'synthetic',source:'source-object',items:[item],segments:[{text:spokenText,spans:[{uid:'span',start:0,end:spokenText.length}],items:[item.customId]}]},entry={chapterId:chapter.chapterId,inputHash:hash(chapter),root:folder};
 const childPCM=[samples(10000),samples(30000),samples(10000)];for(const n of [9999,10000,10499,10500,10999,11000])childPCM[1].writeInt16LE(0,n*2);
 const children=texts.map((text,i)=>({customId:'child'+i,role:'narrator',spokenText:text,request:{text:'[read] '+text}})),attempt2Plan={attempt:2,passage:item.customId,items:children},parts=[];
 for(const [i,child]of children.entries()){
  const audio=wave(childPCM[i],i===1),receipt={sha256:sha(audio),voiceId:'saved-female',requestHash:hash({...child.request,voiceId:'saved-female'}),job:'original-'+i,duration:childPCM[i].length/96000};parts.push({item:child,receipt,audioSha256:sha(audio)});
  await save(join(folder,'repairs',item.customId,'attempt-2','receipts',child.customId+'.json'),receipt);await fs.mkdir(join(folder,'repairs',item.customId,'attempt-2','audio'),{recursive:true});await fs.writeFile(join(folder,'repairs',item.customId,'attempt-2','audio',child.customId+'.wav'),audio);
 }
 const originalAudio=wave(Buffer.concat(childPCM)),originalReceipt={sha256:sha(originalAudio),voiceId:'saved-female',requestHash:hash({...item.request,voiceId:'saved-female'}),job:'original-parent',repair:{attempt:2,planHash:hash(attempt2Plan),parts:parts.map((p,i)=>({id:children[i].customId,sha256:p.audioSha256,job:p.receipt.job}))}};
 const renderPlan=buildRenderingRecoveryPlan({entry,chapter,item,source,receipt:originalReceipt,attempt2Plan,parts,render:renderVisualRedactions,verify:verifyVisualRedactions}),renderDirectory=join(folder,'rendering-recoveries',recoveryPolicy,item.customId),finalParts=[];
 for(const [i,part]of renderPlan.parts.entries()){
  const audio=wave(childPCM[i],i===1),request=part.reused?children[i].request:part.replacement.request,proof=part.reused?parts[i].receipt:{sha256:sha(audio),voiceId:'saved-female',requestHash:hash({...request,voiceId:'saved-female'}),job:'migration-child',duration:childPCM[i].length/96000};
  await save(join(folder,part.root,'receipts',part.id+'.json'),proof);await fs.mkdir(join(folder,part.root,'audio'),{recursive:true});await fs.writeFile(join(folder,part.root,'audio',part.id+'.wav'),audio);finalParts.push({id:part.id,root:part.root,sha256:sha(audio),job:proof.job,reused:part.reused});
 }
 const parentAudio=wave(Buffer.concat(childPCM)),receipt={...originalReceipt,sha256:sha(parentAudio),duration:50000/48000,renderingRecovery:{schemaVersion:1,rendererVersion:recoveryPolicy,planPath:`rendering-recoveries/${recoveryPolicy}/${item.customId}/plan.json`,planHash:fingerprint(renderPlan),inputHash:entry.inputHash,sourceHash:chapter.source,originalItemHash:hash(item),previousSha256:originalReceipt.sha256,renderingProof:renderPlan.renderingProof,parts:finalParts,audioSha256:sha(parentAudio)}};
 await save(join(folder,'input.json'),chapter);await save(join(folder,'source.json'),source);await save(join(folder,'processing.json'),{status:'needs-review',passages:[item.customId]});await save(join(folder,'receipts',item.customId+'.json'),receipt);await fs.mkdir(join(folder,'audio'),{recursive:true});await fs.writeFile(join(folder,'audio',item.customId+'.wav'),parentAudio);await save(join(folder,'repairs',item.customId,'attempt-2','plan.json'),attempt2Plan);
 await save(join(renderDirectory,'plan.json'),renderPlan);await save(join(renderDirectory,'original-receipt.json'),originalReceipt);await save(join(renderDirectory,'attempt2-plan.json'),attempt2Plan);await fs.writeFile(join(renderDirectory,'original.wav'),originalAudio);
 const baseContext=await renderingContext(folder,item),baseBytes=await fs.readFile(join(folder,'receipts',item.customId+'.json')),child=await fs.readFile(join(folder,finalParts[1].root,'audio',finalParts[1].id+'.wav')),candidatePCM=Buffer.concat([childPCM[1].subarray(0,start*2),childPCM[1].subarray(end*2)]),candidateAudio=wave(candidatePCM),pcm=Buffer.concat([childPCM[0],candidatePCM,childPCM[2]]);
 const derivation={schemaVersion:1,sourceAudioSha256:sha(child),sourcePCMSha256:sha(childPCM[1]),candidateAudioSha256:sha(candidateAudio),candidatePCMSha256:sha(candidatePCM),sampleRate:48000,channels:1,sampleWidthBytes:2,originalFrames:30000,candidateFrames:30000-(end-start),removedFrames:end-start,removedRangeHalfOpen:{startSample:start,endSample:end},seamValuesPCM16:{leftLastRetained:0,leftFirstRemoved:0,rightLastRemoved:0,rightFirstRetained:0},retainedRanges:[{originalStart:0,originalEnd:start,candidateStart:0,candidateEnd:start,sha256:sha(childPCM[1].subarray(0,start*2))},{originalStart:end,originalEnd:30000,candidateStart:start,candidateEnd:30000-(end-start),sha256:sha(childPCM[1].subarray(end*2))}],retainedPCMBitExact:true,crossfadeSamples:0,resampling:false,sourceAudioUnchanged:true,productionPromotion:false,sourceInputReceiptCounterLedgerChanges:false};
 const validation={schemaVersion:1,derivation,productionHoldUnchanged:true,paidCalls:0,asr:['small','strong'].map(model=>({model,confirmedUnrelatedWordAbsent:true,recognizedTokensExactlyEqualOriginalMinusConfirmedInsertion:true,sourceTokenImmediatelyBeforeInsertionRecognized:true,sourceTokenImmediatelyAfterInsertionRecognized:true})),ctc:{confirmedUnrelatedPhonemesAbsent:true,boundaryCrossingNonblankRuns:0,leftNearestEightObservedPhonemeTokensExactlyPreserved:true,rightNearestEightObservedPhonemeTokensExactlyPreserved:true,leftObservedPhonemeGuardMarginSamples:1000,rightObservedPhonemeGuardMarginSamples:1000},conclusion:{isolatedTrialRemovesConfirmedInsertion:true,productionHoldRemains:true,fullContentResolutionClaimed:false}};
 let offset=0;const fullParts=finalParts.map((part,i)=>{const row={index:i,id:part.id,root:part.root,audioSha256:part.sha256,pcmSha256:sha(childPCM[i]),startFrameWithinParent:offset,frames:childPCM[i].length/2,endFrameWithinParent:offset+childPCM[i].length/2,isBadReusedChild:i===1};offset=row.endFrameWithinParent;return row;});
 const fullParent={schemaVersion:1,chapterId:chapter.chapterId,passage:item.customId,baseParentAudioSha256:receipt.sha256,baseParentReceiptFileSha256:sha(baseBytes),baseParentPCMSha256:sha(decodePCM16(parentAudio).pcm),baseParentFrames:50000,sumChildFrames:50000,baseParentExactlyEqualsConcatenatedDecodedChildren:true,ffmpegPaddingOrHeaderFramesDetected:false,targetChildIndex:1,targetChildStartFrameWithinParent:10000,targetChildAudioSha256:sha(child),candidateChildAudioSha256:sha(candidateAudio),oneGlobalRemovalRangeHalfOpen:{startFrame:10000+start,endFrame:10000+end,removedFrames:end-start},candidateParentFrames:50000-(end-start),candidateParentPCMSha256:sha(pcm),singleParentDeletionExactlyEqualsReplacingOnlyTargetChild:true,otherChildPCMUnchanged:true,parentOriginalStillUnchanged:true,productionChanges:false,furtherQARequired:true,parts:fullParts};
 await fs.mkdir(candidateDirectory,{recursive:true});await fs.writeFile(join(candidateDirectory,'candidate.wav'),candidateAudio);await save(join(candidateDirectory,'derivation.json'),derivation);await save(join(candidateDirectory,'validation-metadata.json'),validation);await save(join(candidateDirectory,'full-parent-derivation-metadata.json'),fullParent);
 const completeChildren=await Promise.all(finalParts.map(async (part,i)=>({...part,spokenText:texts[i],receipt:await read(join(folder,part.root,'receipts',part.id+'.json')),audio:await fs.readFile(join(folder,part.root,'audio',part.id+'.wav'))})));
 const symbolEvidence={};
 const retain=async(name,value)=>{const bytes=Buffer.from(JSON.stringify(value)),digest=sha(bytes);symbolEvidence[digest]={bytes,value};await fs.writeFile(join(candidateDirectory,name),bytes);return digest;};
 const asr=[];for(const model of ['small','strong']){const transcript=texts[1].replaceAll('+',' plus '),evidenceFile=model+'.json',value={model:pcmASRModels[model],audioSha256:sha(candidateAudio),inputPrompt:null,result:{text:transcript}};asr.push({model,transcript,transcriptSha256:sha(transcript),audioSha256:sha(candidateAudio),inputPrompt:null,evidenceFile,evidenceSha256:await retain(evidenceFile,value)});}
 const ctc={requiredSymbolsPreserved:true,sourceAudioSha256:sha(child),candidateAudioSha256:sha(candidateAudio),boundaryCrossingNonblankRuns:0,unrelatedWordPhonemesAbsent:true,leftNearestEightPhonemeTokensPreserved:true,rightNearestEightPhonemeTokensPreserved:true,sourcePlusSupportSamples:[{startSample:5000,endSample:6000}],candidatePlusSupportSamples:[{startSample:5000,endSample:6000}],sourceEvidenceFile:'source-phones.json',candidateEvidenceFile:'candidate-phones.json'};
 for(const side of ['source','candidate'])ctc[side+'EvidenceSha256']=await retain(ctc[side+'EvidenceFile'],{audioSha256:ctc[side+'AudioSha256'],inputPrompt:null,sampleRate:48000,model:'facebook/wav2vec2-lv-60-espeak-cv-ft',revision:'ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4',frames:['p','l','ʌ','s'].map((token,i)=>({token,tokenId:i+1,acousticSupportStartSample48k:5000+i*200,acousticSupportEndSample48k:5100+i*200})),blankTokenId:0});
 validation.symbolPreservation={policy:'pcm-required-plus-v1',comparisonPolicy:'spoken-plus-v1',expectedTextSha256:sha(texts[1]),parentExpectedTextSha256:sha(baseContext.comparisonExpected),sourceAudioSha256:sha(child),candidateAudioSha256:sha(candidateAudio),requiredSymbols:[{sourceStart:texts[1].indexOf('+'),sourceEnd:texts[1].indexOf('+')+1,symbol:'+',spoken:'plus'}],asr,ctc};await save(join(candidateDirectory,'validation-metadata.json'),validation);
 const args={entry,chapter,item,source,receipt,baseContext,parentAudio,symbolEvidence,baseReceiptFileSha256:sha(baseBytes),children:completeChildren,childId:'child1',candidateAudio,derivation,validation,fullParent};
 const configuration=join(root,'config.json');await save(configuration,{root,chapterIds:[chapter.chapterId],sourceCommit:'0'.repeat(40),sourceRoot:join(root,'old-runtime'),maxRetakes:2,originalVoices:{narrator:{voiceId:'saved-female'}}});await save(join(root,'queue.json'),{chapters:[entry],maxRetakes:2});await save(join(root,'voices.json'),{narrator:{voiceId:'saved-female'}});await save(join(root,'paid-ledger.json'),{reservedUSD:9,uncertain:'retained'});
 return {root,folder,entry,item,chapter,args,candidateDirectory,configuration,baseBytes};
}
test('one offline PCM deletion preserves every retained parent and child byte, original proof and attempt counters',async()=>{
 const f=await fixture();try{
  const {plan,audio}=buildPCMExcision(f.args),original=decodePCM16(f.args.parentAudio).pcm,edited=decodePCM16(audio).pcm;
  assert.deepEqual(plan.removedParentRange,{start:20000,end:21000});assert.equal(plan.removedFrames,1000);assert.equal(plan.paidCalls,0);
  assert.ok(edited.equals(Buffer.concat([original.subarray(0,40000),original.subarray(42000)])));
  const next=editedPCMReceipt(f.args.receipt,plan);assert.deepEqual(next.renderingRecovery,f.args.receipt.renderingRecovery);assert.deepEqual(next.repair,f.args.receipt.repair);
  assert.equal(next.repair.attempt,2);assert.equal(next.voiceId,f.args.receipt.voiceId);assert.equal(next.requestHash,f.args.receipt.requestHash);
  const dry=await planPCMExcision(f.configuration,f.chapter.chapterId,f.item.customId,'child1',f.candidateDirectory);assert.equal(dry.planHash,fingerprint(plan));
  await assert.rejects(applyPCMExcision(f.configuration,f.chapter.chapterId,f.item.customId,'child1',f.candidateDirectory,dry.planHash),/installed committed runtime/);
  assert.deepEqual(await fs.readFile(join(f.folder,'receipts',f.item.customId+'.json')),f.baseBytes);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
async function retainSymbols(f,directory){await fs.mkdir(join(directory,'symbol-evidence'),{recursive:true});for(const [digest,e]of Object.entries(f.args.symbolEvidence))await fs.writeFile(join(directory,'symbol-evidence',digest+'.json'),e.bytes);}
async function enableRuntime(f){
 const config=await read(f.configuration),runtime=join(f.root,'runtime');await fs.mkdir(join(runtime,'tools/inworld-batch'),{recursive:true});
 for(const name of ['runner.mjs','chapter-processing-lock.mjs'])await fs.copyFile(fileURLToPath(new URL('./'+name,import.meta.url)),join(runtime,'tools/inworld-batch',name));
 config.sourceRoot=runtime;config.sourceCommit='1'.repeat(40);await fs.writeFile(join(runtime,'source-commit.txt'),config.sourceCommit+'\n');await save(f.configuration,config);
}
test('apply requires the exact reviewed plan, an unlocked held target and unchanged counter/voice settings',async()=>{
 const f=await fixture();try{
  await enableRuntime(f);const {planHash}=await planPCMExcision(f.configuration,f.chapter.chapterId,f.item.customId,'child1',f.candidateDirectory),invoke=expected=>applyPCMExcision(f.configuration,f.chapter.chapterId,f.item.customId,'child1',f.candidateDirectory,expected);
  await assert.rejects(invoke('0'.repeat(64)),/plan fingerprint changed/);
  const config=await read(f.configuration);await save(f.configuration,{...config,maxRetakes:3});await assert.rejects(invoke(planHash),/unchanged two-retake bound/);await save(f.configuration,config);
  await save(join(f.root,'voices.json'),{narrator:{voiceId:'different'}});await assert.rejects(invoke(planHash),/original voice changed/);await save(join(f.root,'voices.json'),{narrator:{voiceId:'saved-female'}});
  for(const name of ['assembly.json','published.json']){await save(join(f.folder,name),{});await assert.rejects(invoke(planHash),/immutable/);await fs.unlink(join(f.folder,name));}
  await save(join(f.folder,'processing.json'),{status:'running',passages:[f.item.customId]});await assert.rejects(invoke(planHash),/held for fidelity review/);await save(join(f.folder,'processing.json'),{status:'needs-review',passages:[f.item.customId]});
  const directory=excisionDirectory(f.folder,f.item);await save(join(directory,'promotion.json'),{state:'corrupt'});await assert.rejects(invoke(planHash),/promotion journal state/);await fs.unlink(join(directory,'promotion.json'));
  await fs.writeFile(join(f.folder,'owner-review.lock'),String(process.pid));await assert.rejects(invoke(planHash),/chapter is locked/);await fs.unlink(join(f.folder,'owner-review.lock'));
  await save(join(f.root,'processing-status.json'),{status:'running',chapter:f.chapter.chapterId});await assert.rejects(invoke(planHash),/active generation or QA lane/);
  await save(join(f.root,'processing-status.json'),{status:'running',chapter:'other-chapter'});
  const protectedFiles=['input.json','source.json','processing.json'],originals=await Promise.all(protectedFiles.map(n=>fs.readFile(join(f.folder,n)))),ledger=await fs.readFile(join(f.root,'paid-ledger.json')),children=f.args.children.map(row=>Buffer.from(row.audio));
  assert.equal((await invoke(planHash)).freshFullQARequired,true);
  for(const [i,n]of protectedFiles.entries())assert.deepEqual(await fs.readFile(join(f.folder,n)),originals[i]);assert.deepEqual(await fs.readFile(join(f.root,'paid-ledger.json')),ledger);
  for(const [i,row]of f.args.children.entries())assert.deepEqual(await fs.readFile(join(f.folder,row.root,'audio',row.id+'.wav')),children[i]);
  const next=await read(join(f.folder,'receipts',f.item.customId+'.json'));assert.deepEqual(next.renderingRecovery,f.args.receipt.renderingRecovery);assert.equal(next.repair.attempt,2);
  await assert.rejects(invoke(planHash),/cannot be repeated/);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('a prepared promotion interrupted between WAV and receipt resumes only the same retained exact bytes',async()=>{
 const f=await fixture();try{
  await enableRuntime(f);const built=buildPCMExcision(f.args),directory=excisionDirectory(f.folder,f.item),next=editedPCMReceipt(f.args.receipt,built.plan);await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(join(directory,'base-receipt.json'),f.baseBytes);await fs.writeFile(join(directory,'base.wav'),f.args.parentAudio);await fs.writeFile(join(directory,'replacement.wav'),built.audio);await save(join(directory,'plan.json'),built.plan);await retainSymbols(f,directory);
  for(const n of ['candidate.wav','derivation.json','validation-metadata.json','full-parent-derivation-metadata.json','small.json','strong.json','source-phones.json','candidate-phones.json'])await fs.copyFile(join(f.candidateDirectory,n),join(directory,n));
  await save(join(directory,'promotion.json'),{state:'prepared',passage:f.item.customId,previousSha256:f.args.receipt.sha256,receipt:next});
  await fs.writeFile(join(f.folder,'audio',f.item.customId+'.wav'),built.audio); // Power loss before receipt rename.
  assert.equal((await applyPCMExcision(f.configuration,f.chapter.chapterId,f.item.customId,'child1',f.candidateDirectory,fingerprint(built.plan))).applied,true);
  assert.deepEqual(await read(join(f.folder,'receipts',f.item.customId+'.json')),next);assert.equal((await read(join(directory,'promotion.json'))).state,'complete');
  assert.equal((await renderingContext(f.folder,f.item)).audioSha256,next.sha256);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('source, timing, retained PCM, reused child and broad or repeated excisions fail closed',async()=>{
 const f=await fixture();try{
  const mutations=[a=>{a.source.text+=' changed';},a=>{a.validation.ctc.boundaryCrossingNonblankRuns=1;},a=>{a.derivation.removedRangeHalfOpen.endSample=29000;},a=>{a.candidateAudio=Buffer.from(a.candidateAudio);a.candidateAudio[a.candidateAudio.length-2]^=1;},a=>{a.children[1].audio=Buffer.from(a.children[1].audio);a.children[1].audio[100]^=1;},a=>{a.children[1].reused=false;},a=>{a.receipt={...a.receipt,offlinePCMExcision:{}};},a=>{a.fullParent.targetChildStartFrameWithinParent++;}];
  for(const mutate of mutations){const a={...f.args,source:structuredClone(f.args.source),receipt:structuredClone(f.args.receipt),children:f.args.children.map(child=>({...child})),derivation:structuredClone(f.args.derivation),validation:structuredClone(f.args.validation),fullParent:structuredClone(f.args.fullParent)};mutate(a);assert.throws(()=>buildPCMExcision(a));}
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('layered rendering validates the immutable base first and forces fresh full-text ASR, phonemes and AI evidence',async()=>{
 const f=await fixture();try{
  const built=buildPCMExcision(f.args),next=editedPCMReceipt(f.args.receipt,built.plan),directory=excisionDirectory(f.folder,f.item);await fs.mkdir(directory,{recursive:true});
  await fs.writeFile(join(directory,'base-receipt.json'),f.baseBytes);await fs.writeFile(join(directory,'base.wav'),f.args.parentAudio);await save(join(directory,'plan.json'),built.plan);await retainSymbols(f,directory);
  for(const name of ['candidate.wav','derivation.json','validation-metadata.json','full-parent-derivation-metadata.json','small.json','strong.json','source-phones.json','candidate-phones.json'])await fs.copyFile(join(f.candidateDirectory,name),join(directory,name));
  await save(join(f.folder,'receipts',f.item.customId+'.json'),next);await fs.writeFile(join(f.folder,'audio',f.item.customId+'.wav'),built.audio);
  const context=await renderingContext(f.folder,f.item);assert.equal(context.audioSha256,next.sha256);assert.equal(context.comparisonExpected,f.args.baseContext.comparisonExpected);assert.equal(context.offlinePCMExcision.planHash,fingerprint(built.plan));
  const oldReport={sha256:f.args.receipt.sha256,expected:f.item.spokenText,attempts:[],severity:'pass',comparisonExpected:context.comparisonExpected,renderingContext:f.args.baseContext};
  assert.throws(()=>evidenceRow(f.item,oldReport,{audioSha256:oldReport.sha256,phonemes:'old',inputPrompt:null},{},context),/Unbound/);
  const report={...oldReport,sha256:next.sha256,renderingContext:context};assert.throws(()=>evidenceRow(f.item,report,{audioSha256:oldReport.sha256,phonemes:'old',inputPrompt:null},{},context),/Stale/);
  const row=evidenceRow(f.item,report,{audioSha256:next.sha256,phonemes:'fresh',inputPrompt:null},{},context);assert.equal(row.expected,f.item.spokenText);assert.equal(row.comparisonExpected,context.comparisonExpected);
  assert.deepEqual(modelReview(report,{evidenceHash:'old',severity:'pass'},row),report);
  const changed=Buffer.from(built.audio);changed[changed.length-2]^=1;await fs.writeFile(join(f.folder,'audio',f.item.customId+'.wav'),changed);await assert.rejects(renderingContext(f.folder,f.item),/differs from exact offline/);await fs.writeFile(join(f.folder,'audio',f.item.customId+'.wav'),built.audio);
  const badBase=structuredClone(f.args.receipt);badBase.renderingRecovery.renderingProof.text='Unrelated text';await save(join(directory,'base-receipt.json'),badBase);await assert.rejects(renderingContext(f.folder,f.item));await fs.writeFile(join(directory,'base-receipt.json'),f.baseBytes);
  const retained=f.args.children[1],retainedPath=join(f.folder,retained.root,'audio',retained.id+'.wav');await fs.writeFile(retainedPath,Buffer.from('changed retained child'));await assert.rejects(renderingContext(f.folder,f.item));await fs.writeFile(retainedPath,retained.audio);
  await fs.writeFile(join(directory,'base.wav'),Buffer.from('tampered'));await assert.rejects(renderingContext(f.folder,f.item),/audio no longer matches/);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
async function rejectedLegacy(f){
 const built=buildPCMExcision(f.args),plan=structuredClone(built.plan),validation=structuredClone(f.args.validation);delete plan.symbolPreservation;delete validation.symbolPreservation;plan.timingValidationHash=fingerprint(validation);
 const directory=excisionDirectory(f.folder,f.item),bad=editedPCMReceipt(f.args.receipt,plan),context={...f.args.baseContext,audioSha256:bad.sha256,receiptHash:fingerprint(bad),offlinePCMExcision:{planHash:fingerprint(plan)}};
 await fs.mkdir(directory,{recursive:true});await fs.writeFile(join(directory,'base-receipt.json'),f.baseBytes);await fs.writeFile(join(directory,'base.wav'),f.args.parentAudio);await fs.writeFile(join(directory,'replacement.wav'),built.audio);await save(join(directory,'plan.json'),plan);
 for(const name of ['candidate.wav','derivation.json','full-parent-derivation-metadata.json'])await fs.copyFile(join(f.candidateDirectory,name),join(directory,name));await save(join(directory,'validation-metadata.json'),validation);
 await save(join(directory,'promotion.json'),{state:'complete',passage:f.item.customId,previousSha256:f.args.receipt.sha256,receipt:bad});await save(join(f.folder,'receipts',f.item.customId+'.json'),bad);await fs.writeFile(join(f.folder,'audio',f.item.customId+'.wav'),built.audio);
 const report={sha256:bad.sha256,expected:f.item.spokenText,comparisonExpected:context.comparisonExpected,renderingContext:context,attempts:['small','strong'].map(model=>({model,transcript:f.item.spokenText.replaceAll('+','')})),severity:'major'},phoneme={audioSha256:bad.sha256,inputPrompt:null,phonemes:'unprompted synthetic evidence'},row=evidenceRow(f.item,report,phoneme,{},context),value={decisions:[{passage:f.item.customId,severity:'major',reason:'Required qualifier omitted'}]},proof=join(f.folder,'llm-review','synthetic.json');
 await save(proof,{authentication:'chatgpt',value,rows:[row]});const decision={...value.decisions[0],audioSha256:bad.sha256,reportHash:hash(report),evidenceHash:hash(row),proof,proofHash:hash(value),validator:'subscription/chatgpt'},effective={...report,modelReview:decision};
 await save(join(f.folder,'review',f.item.customId+'.json'),report);await save(join(f.folder,'effective-reviews.json'),{[f.item.customId]:effective});await save(join(f.folder,'phoneme-review',f.item.customId+'.json'),phoneme);await save(join(f.folder,'llm-decisions.json'),{[f.item.customId]:decision});
 return {plan,planHash:fingerprint(plan),bad,audio:built.audio,directory,report,effective,phoneme};
}
async function manualRollback(f,legacy,state='complete'){
 const directory=join(legacy.directory,'rollback');await fs.mkdir(directory,{recursive:true});
 await fs.writeFile(join(directory,'original.wav'),legacy.audio);await save(join(directory,'original-receipt.json'),legacy.bad);await save(join(directory,'original-review.json'),legacy.report);await save(join(directory,'original-effective-review.json'),legacy.effective);await save(join(directory,'original-phoneme-review.json'),legacy.phoneme);
 await fs.writeFile(join(directory,'replacement.wav'),f.args.parentAudio);await save(join(directory,'promotion.json'),{state,passage:f.item.customId,previousSha256:legacy.bad.sha256,receipt:f.args.receipt});await fs.writeFile(join(f.folder,'audio',f.item.customId+'.wav'),f.args.parentAudio);if(state==='complete')await fs.writeFile(join(f.folder,'receipts',f.item.customId+'.json'),f.baseBytes);
}
test('rollback restores exact retained base without counters or payment changes and adopts a completed compatible journal',async()=>{
 for(const manual of [false,true,'prepared']){
  const f=await fixture();try{
   await enableRuntime(f);const legacy=await rejectedLegacy(f),ledger=await fs.readFile(join(f.root,'paid-ledger.json'));
   if(manual)await manualRollback(f,legacy,manual===true?'complete':'prepared');
   const result=await rollbackPCMExcision(f.configuration,f.chapter.chapterId,f.item.customId,legacy.planHash);assert.equal(result.adopted,manual===true);assert.equal(result.paidCalls,0);
   assert.deepEqual(await fs.readFile(join(f.folder,'audio',f.item.customId+'.wav')),f.args.parentAudio);assert.deepEqual(await read(join(f.folder,'receipts',f.item.customId+'.json')),f.args.receipt);assert.deepEqual(await fs.readFile(join(f.root,'paid-ledger.json')),ledger);
   assert.deepEqual(await fs.readFile(join(legacy.directory,'replacement.wav')),legacy.audio);assert.deepEqual(await read(join(legacy.directory,'plan.json')),legacy.plan);assert.equal((await read(join(legacy.directory,'rollback','plan.json'))).requiredPlusOmissionVerified,true);
   assert.equal((await rollbackPCMExcision(f.configuration,f.chapter.chapterId,f.item.customId,legacy.planHash)).adopted,true);
   await assert.rejects(planPCMExcision(f.configuration,f.chapter.chapterId,f.item.customId,'child1',f.candidateDirectory),/cannot be reapplied/);
  }finally{await fs.rm(f.root,{recursive:true,force:true});}
 }
});
test('rollback refuses wrong plan, changed review/model evidence, publication, locks and unrelated current PCM',async()=>{
 const f=await fixture();try{
  await enableRuntime(f);const legacy=await rejectedLegacy(f),invoke=hash=>rollbackPCMExcision(f.configuration,f.chapter.chapterId,f.item.customId,hash);
  await assert.rejects(invoke('f'.repeat(64)),/rollback evidence/);
  await save(join(f.folder,'published.json'),{});await assert.rejects(invoke(legacy.planHash),/immutable/);await fs.unlink(join(f.folder,'published.json'));
  await fs.writeFile(join(f.folder,'owner-review.lock'),String(process.pid));await assert.rejects(invoke(legacy.planHash),/locked/);await fs.unlink(join(f.folder,'owner-review.lock'));
  const wav=join(f.folder,'audio',f.item.customId+'.wav');await fs.writeFile(wav,Buffer.from('changed'));await assert.rejects(invoke(legacy.planHash),/rollback evidence/);await fs.writeFile(wav,legacy.audio);
  await manualRollback(f,legacy);const report=join(legacy.directory,'rollback','original-review.json');await save(report,{...legacy.report,expected:'changed'});await assert.rejects(invoke(legacy.planHash),/rollback evidence/);await save(report,legacy.report);
  const proof=legacy.effective.modelReview.proof;await save(proof,{value:{decisions:[]},rows:[]});await assert.rejects(invoke(legacy.planHash),/rollback evidence/);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('one legacy correction requires verified rollback, a narrower original-base cut and fresh symbol-aware evidence',async()=>{
 const f=await fixture(),candidate=await fixture({start:10500});try{
  await enableRuntime(f);const legacy=await rejectedLegacy(f);
  await assert.rejects(planPCMExcision(f.configuration,f.chapter.chapterId,f.item.customId,'child1',candidate.candidateDirectory,true));
  await rollbackPCMExcision(f.configuration,f.chapter.chapterId,f.item.customId,legacy.planHash);
  // The independently built candidate has identical immutable source/base bytes.
  const dry=await planPCMExcision(f.configuration,f.chapter.chapterId,f.item.customId,'child1',candidate.candidateDirectory,true);assert.deepEqual(dry.plan.removedChildRange,{start:10500,end:11000});assert.equal(dry.plan.legacyCorrection.rejectedPlanHash,legacy.planHash);
  const args=[f.configuration,f.chapter.chapterId,f.item.customId,'child1',candidate.candidateDirectory,dry.planHash,true];assert.equal((await applyPCMExcision(...args)).freshFullQARequired,true);
  const current=await read(join(f.folder,'receipts',f.item.customId+'.json'));assert.match(current.offlinePCMExcision.planPath,/correction\/plan.json$/);assert.equal(current.repair.attempt,2);const context=await renderingContext(f.folder,f.item);assert.equal(context.audioSha256,current.sha256);assert.equal(context.comparisonExpected,f.args.baseContext.comparisonExpected);
  await assert.rejects(applyPCMExcision(...args));
  const old=legacy.plan,newPlan={...dry.plan};delete newPlan.legacyCorrection;
  for(const change of [p=>{p.removedChildRange=old.removedChildRange;},p=>{p.childId='other';},p=>{p.baseAudioSha256='f'.repeat(64);},p=>{p.removedChildRange={start:old.removedChildRange.start-1,end:old.removedChildRange.end-1};}]){const mutated=structuredClone(newPlan);change(mutated);assert.throws(()=>validateCorrection(old,{requiredPlusOmissionVerified:true},mutated));}
 }finally{await fs.rm(f.root,{recursive:true,force:true});await fs.rm(candidate.root,{recursive:true,force:true});}
});
test('symbol evidence rejects legacy punctuation stripping, missing plus, moved support and raw proof tampering',async()=>{
 const f=await fixture();try{
  const clone=()=>({...f.args,validation:structuredClone(f.args.validation),symbolEvidence:{...f.args.symbolEvidence}});
  for(const change of [a=>{delete a.validation.symbolPreservation;},a=>{a.validation.symbolPreservation.comparisonPolicy='old';},a=>{a.validation.symbolPreservation.requiredSymbols=[];},a=>{a.validation.symbolPreservation.ctc.sourcePlusSupportSamples[0].endSample=10500;},a=>{const r=a.validation.symbolPreservation.asr[0];r.transcript=r.transcript.replace('plus','');r.transcriptSha256=sha(r.transcript);},a=>{const d=a.validation.symbolPreservation.ctc.candidateEvidenceSha256;a.symbolEvidence[d]={bytes:Buffer.from('{}'),value:{}};}]){const a=clone();change(a);assert.throws(()=>buildPCMExcision(a),/symbol preservation/);}
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('required qualifier anchors use whole tokens, so E plus cannot match grade plus',async()=>{
 const f=await fixture();try{
  const a={...f.args,validation:structuredClone(f.args.validation),symbolEvidence:{...f.args.symbolEvidence}};
  for(const row of a.validation.symbolPreservation.asr){const transcript=row.transcript.replace('E plus','grade plus'),raw={model:pcmASRModels[row.model],audioSha256:row.audioSha256,inputPrompt:null,result:{text:transcript}},bytes=Buffer.from(JSON.stringify(raw)),digest=sha(bytes);row.transcript=transcript;row.transcriptSha256=sha(transcript);row.evidenceSha256=digest;a.symbolEvidence[digest]={bytes,value:raw};}
  assert.throws(()=>buildPCMExcision(a),/symbol preservation/);
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
test('small and strong ASR proofs must have distinct digests and their exact pinned model identity',async()=>{
 const f=await fixture();try{
  const clone=()=>({...f.args,validation:structuredClone(f.args.validation),symbolEvidence:{...f.args.symbolEvidence}}),sameProof=clone();
  sameProof.validation.symbolPreservation.asr[1]={...sameProof.validation.symbolPreservation.asr[0],model:'strong'};assert.throws(()=>buildPCMExcision(sameProof),/symbol preservation/);
  for(const model of ['small','strong']){
   const a=clone(),row=a.validation.symbolPreservation.asr.find(row=>row.model===model),raw={...a.symbolEvidence[row.evidenceSha256].value,model:pcmASRModels[model==='small'?'strong':'small']},bytes=Buffer.from(JSON.stringify(raw)),digest=sha(bytes);row.evidenceSha256=digest;a.symbolEvidence[digest]={bytes,value:raw};assert.throws(()=>buildPCMExcision(a),/symbol preservation/);
  }
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
