import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fingerprint} from '../audiobooks/dist/store.js';
import {hash,sha} from './core.mjs';
import {evidenceRow,modelReview} from './adjudication.mjs';
import {pcmASRModels} from './pcm-symbol-evidence.mjs';
import {reviewWitnessPolicy,validateReviewWitness,attachReviewWitness,loadReviewWitness,claimWitnessReview,verifyWitnessReviewClaim,verifyWitnessReviewResult,reusableReviewDecision} from './review-witness.mjs';

const raw=value=>{const json=JSON.stringify(value);return {json,sha256:sha(json)};};
function wav(frames=48000,value=0){
 const audio=Buffer.alloc(44+frames*2);audio.write('RIFF');audio.writeUInt32LE(audio.length-8,4);audio.write('WAVEfmt ',8);audio.writeUInt32LE(16,16);audio.writeUInt16LE(1,20);audio.writeUInt16LE(1,22);audio.writeUInt32LE(48000,24);audio.writeUInt32LE(96000,28);audio.writeUInt16LE(2,32);audio.writeUInt16LE(16,34);audio.write('data',36);audio.writeUInt32LE(frames*2,40);for(let i=0;i<frames;i++)audio.writeInt16LE(value,44+i*2);return audio;
}
function fixture(){
 const children=Array.from({length:13},(_,i)=>{const audio=wav(48000,i),id='p'+i;return {id,root:'parts',audio,receipt:{sha256:sha(audio),voiceId:'voice',job:'job'+i},text:i===6?'alpha Qx-average seven tail':i===9?'nine abac/def':`part ${i}`};});
 const parentAudio=wav(13*48000);for(const [i,c]of children.entries())c.audio.subarray(44).copy(parentAudio,44+i*48000*2);
 const item={customId:'parent',role:'narrator',spokenText:children.map(c=>c.text).join(' '),request:{text:'stable'}};
 const chapter={chapterId:'chapter',source:'sourcehash',items:[item],segments:[{items:[item.customId],spans:[{start:0,end:item.spokenText.length}]}]};
 const source={text:item.spokenText},receipt={sha256:sha(parentAudio),voiceId:'voice',repair:{attempt:2},renderingRecovery:{rendererVersion:'source-numeric-notation-v1'},decimalRecovery:{parts:children.map(c=>({id:c.id,root:c.root,sha256:sha(c.audio),job:c.receipt.job,reused:c.id!=='p9'}))}};
 const context={comparisonExpected:item.spokenText,renderingProof:{policy:'test'},audioSha256:receipt.sha256,receiptHash:fingerprint(receipt),decimalRecovery:{policy:'legacy-adjacent-decimal-v1'}};
 const phone={audioSha256:receipt.sha256,inputPrompt:null,phonemes:'eɪ b i eɪ s i'},report={expected:item.spokenText,sha256:receipt.sha256,attempts:[{model:pcmASRModels.small,transcript:item.spokenText},{model:pcmASRModels.strong,transcript:item.spokenText}],renderingContext:context,comparisonExpected:item.spokenText};
 const oldRow=evidenceRow(item,report,phone,{before:'',after:''},context),oldProof={authentication:'chatgpt',rows:[oldRow],value:{decisions:[{passage:item.customId,severity:'major',reason:'A specific claimed pronunciation needs independent evidence.'}]}};
 const oldDecision={...oldProof.value.decisions[0],audioSha256:receipt.sha256,reportHash:hash(report),evidenceHash:hash(oldRow),proofHash:hash(oldProof.value),proof:'old-proof'};
 const unitStart=source.text.indexOf('abac/def'),prefixStart=source.text.indexOf('Qx-average');
 const ctc=(audio,tokens)=>{
  const ids=new Map(),frames=Array.from({length:49},(_,frame)=>{const token=tokens[frame]??'<pad>';if(!ids.has(token))ids.set(token,token==='<pad>'?0:ids.size+1);return {frame,token,tokenId:ids.get(token),acousticSupportStartSample48k:frame*960,acousticSupportEndSample48k:frame*960+1200};});
  const floats=Buffer.alloc(48000*4);for(let i=0;i<48000;i++)floats.writeFloatLE(audio.readInt16LE(44+i*2)/32768,i*4);
  return raw({audioSha256:sha(audio),inputPrompt:null,providerDisabled:true,sampleRate:48000,decodedFrames:48000,model:'facebook/wav2vec2-lv-60-espeak-cv-ft',revision:'ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4',doPhonemize:false,localModelChecksumsVerified:true,frames,featureStrideSamples16k:320,featureReceptiveFieldSamples16k:400,blankTokenId:0,phonemes:tokens.join(' '),decodedFloatPCMSha256:sha(floats)});
 };
 const asr=label=>raw({audioSha256:sha(children[6].audio),inputPrompt:null,providerDisabled:true,sampleRate:48000,decodedFrames:48000,model:pcmASRModels[label],temperature:0,fp16:false,word_timestamps:true,condition_on_previous_text:false,result:{text:'alpha cue ex average seven tail',segments:[{words:[{word:'alpha',start:0,end:.8}]}]}});
 const manifest={schemaVersion:1,policy:reviewWitnessPolicy,maximumReviews:1,chapterId:chapter.chapterId,passage:item.customId,inputHash:hash(chapter),sourceObjectHash:fingerprint(source),sourceHash:chapter.source,itemHash:hash(item),receiptHash:fingerprint(receipt),audioSha256:receipt.sha256,reportHash:hash(report),normalPhoneHash:hash(phone),renderingContextHash:fingerprint(context),oldRowHash:hash(oldRow),oldDecisionHash:hash(oldDecision),oldProofHash:fingerprint(oldProof),oldReasonSha256:sha(oldDecision.reason),children:[
  {kind:'literal-unit',id:'p9',root:'parts',audioSha256:sha(children[9].audio),receiptHash:fingerprint(children[9].receipt),parentStartFrame:9*48000,parentEndFrame:10*48000,sourceRange:{start:unitStart,end:unitStart+8,sha256:sha('abac/def')},evidence:{phones:ctc(children[9].audio,['eɪ','b','i','eɪ','s','i'])}},
  {kind:'statistic-prefix',id:'p6',root:'parts',audioSha256:sha(children[6].audio),receiptHash:fingerprint(children[6].receipt),parentStartFrame:6*48000,parentEndFrame:7*48000,sourceRange:{start:prefixStart,end:prefixStart+10,sha256:sha('Qx-average')},childRange:{start:6,end:16},queuedRange:{start:prefixStart,end:prefixStart+10},evidence:{small:asr('small'),strong:asr('strong'),phones:ctc(children[6].audio,['k','j','u'])}}
 ]};
 return {manifest,chapter,item,source,receipt,report,phone,context,oldRow,oldDecision,oldProof,parentAudio,children,notationPlan:{parts:[{id:'p9',root:'parts',replacement:{}}]},notationManifest:{passages:[{passage:item.customId,sourceRanges:[{kind:'literal-unit',sourceStart:unitStart,sourceEnd:unitStart+8}]}]},attempt2Plan:{items:children.map(c=>({customId:c.id,spokenText:c.text}))}};
}
const mutateRaw=(row,work)=>{const value=JSON.parse(row.json);work(value);Object.assign(row,raw(value));};

test('new acoustic witness adds one row field; all original audio, reports and source remain unchanged',()=>{
 const data=fixture(),before=hash({...data,parentAudio:undefined,children:undefined}),w=validateReviewWitness(data);
 assert.equal(w.automaticAcceptance,false);assert.equal(w.observations[0].requiredSequenceCount,1);assert.equal(w.observations[0].challengedVariantCount,0);assert.deepEqual(w.observations[0].parentSupportSamples48k,[432000,438000]);assert.equal(w.observations[1].observations.rows.length,2);
 assert.equal(hash({...data,parentAudio:undefined,children:undefined}),before);
 const row=evidenceRow(data.item,data.report,data.phone,data.oldRow.neighbors,data.context,w),{supplementalAcousticWitness,...original}=row;assert.deepEqual(original,data.oldRow);assert.equal(supplementalAcousticWitness.maximumReviews,1);assert.notEqual(hash(row),hash(data.oldRow));
});

test('wrong immutable hashes, selected clips, ranges and retained PCM fail closed',()=>{
 for(const mutate of [d=>d.manifest.inputHash='bad',d=>d.manifest.sourceObjectHash='bad',d=>d.manifest.receiptHash='bad',d=>d.manifest.reportHash='bad',d=>d.manifest.normalPhoneHash='bad',d=>d.manifest.renderingContextHash='bad',d=>d.manifest.oldDecisionHash='bad',d=>d.manifest.oldRowHash='bad',d=>d.manifest.children[0].id='p8',d=>d.manifest.children[1].sourceRange.start++,d=>d.manifest.children[0].parentEndFrame++,d=>d.children[0].audio[44]++,d=>d.parentAudio[44]++,d=>d.manifest.children.push(d.manifest.children[0]),d=>d.receipt.repair.attempt=0]){
  const data=fixture();mutate(data);assert.throws(()=>validateReviewWitness(data),/witness/);
 }
});

test('tampered, prompted, wrong-model and fabricated frame evidence cannot attach',()=>{
 for(const mutate of [d=>d.manifest.children[0].evidence.phones.sha256='bad',d=>mutateRaw(d.manifest.children[0].evidence.phones,v=>v.inputPrompt='prompt'),d=>mutateRaw(d.manifest.children[0].evidence.phones,v=>v.frames[2].frame++),d=>mutateRaw(d.manifest.children[0].evidence.phones,v=>v.frames[2].acousticSupportStartSample48k++),d=>mutateRaw(d.manifest.children[0].evidence.phones,v=>v.decodedFloatPCMSha256='bad'),d=>mutateRaw(d.manifest.children[1].evidence.strong,v=>v.model=pcmASRModels.small),d=>mutateRaw(d.manifest.children[1].evidence.small,v=>v.result.text+=' unrelated'),d=>mutateRaw(d.manifest.children[1].evidence.phones,v=>v.frames.pop())]){
  const data=fixture();mutate(data);assert.throws(()=>validateReviewWitness(data),/witness/);
 }
});

test('attachment requires quiet paused job and owns both locks; changed manifest and second review are refused',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'review-witness-')),chapterRoot=join(root,'chapter');await fs.mkdir(chapterRoot);const data=fixture(),entry={chapterId:data.chapter.chapterId,inputHash:hash(data.chapter),root:chapterRoot};
 const save=(path,value)=>fs.writeFile(path,JSON.stringify(value));
 try{
  await save(join(root,'status.json'),{status:'running'});await save(join(root,'supervisor-status.json'),{status:'paused'});
  await fs.writeFile(join(root,'pause.requested'),'');
  await assert.rejects(attachReviewWitness({root},entry,data.manifest,fingerprint(data.manifest),{loadMaterials:async()=>data}));
  await save(join(root,'status.json'),{status:'paused'});
  const options={loadMaterials:async()=>{assert.equal(await fs.readFile(join(root,'worker.lock'),'utf8'),String(process.pid));assert.equal(await fs.readFile(join(chapterRoot,'owner-review.lock'),'utf8'),String(process.pid));return data;}};
  const witness=await attachReviewWitness({root},entry,data.manifest,fingerprint(data.manifest),options);
  assert.equal(witness.manifestHash,fingerprint(data.manifest));await assert.rejects(fs.stat(join(root,'worker.lock')));await assert.rejects(fs.stat(join(chapterRoot,'owner-review.lock')));
  await attachReviewWitness({root},entry,data.manifest,fingerprint(data.manifest),options);
  const changed={...data.manifest,extra:'variant'};await assert.rejects(attachReviewWitness({root},entry,changed,fingerprint(changed),{loadMaterials:async()=>({...data,manifest:changed})}));
  const row={audioSha256:data.receipt.sha256,supplementalAcousticWitness:witness};await claimWitnessReview(chapterRoot,row,'key');await verifyWitnessReviewClaim(chapterRoot,row,'key');await assert.rejects(claimWitnessReview(chapterRoot,row,'key'),/EEXIST/);await assert.rejects(verifyWitnessReviewClaim(chapterRoot,{...row,audioSha256:'changed'},'key'));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('unchanged cached row requires exact instructions/model/path/result and cannot reuse stale or unrelated proof',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'review-witness-cache-'));await fs.mkdir(join(root,'llm-review'));const data=fixture(),instructions='strict rules',model='subscription-model';
 try{
  const key=hash({instructions,model,rows:data.oldProof.rows}),path=join(root,'llm-review',key+'.json'),decision={...data.oldDecision,proof:path,validator:model+'/chatgpt'};await fs.writeFile(path,JSON.stringify(data.oldProof));assert.deepEqual(await reusableReviewDecision(root,data.oldRow,decision,instructions,model),decision);
  assert.equal(await reusableReviewDecision(root,{...data.oldRow,audioSha256:'stale'},decision,instructions,model),null);
  await assert.rejects(reusableReviewDecision(root,data.oldRow,decision,'changed',model));await assert.rejects(reusableReviewDecision(root,data.oldRow,decision,instructions,'other-model'));
  await assert.rejects(reusableReviewDecision(root,data.oldRow,{...decision,validator:'other/chatgpt'},instructions,model));
  const tampered=structuredClone(data.oldProof);tampered.value.decisions[0].severity='pass';await fs.writeFile(path,JSON.stringify(tampered));await assert.rejects(reusableReviewDecision(root,data.oldRow,decision,instructions,model));
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('pause removal or supervisor restart during validation prevents attachment without dropping foreign locks',async()=>{
 for(const race of ['pause','supervisor']){
  const root=await fs.mkdtemp(join(tmpdir(),'review-witness-race-')),chapterRoot=join(root,'chapter');await fs.mkdir(chapterRoot);const data=fixture(),entry={chapterId:data.chapter.chapterId,inputHash:hash(data.chapter),root:chapterRoot};
  try{
   for(const name of ['status.json','supervisor-status.json'])await fs.writeFile(join(root,name),JSON.stringify({status:'paused'}));await fs.writeFile(join(root,'pause.requested'),'');
   await assert.rejects(attachReviewWitness({root},entry,data.manifest,fingerprint(data.manifest),{loadMaterials:async()=>{if(race==='pause')await fs.unlink(join(root,'pause.requested'));else await fs.writeFile(join(root,'supervisor.lock'),'foreign');return data;}}));
   await assert.rejects(fs.stat(join(chapterRoot,'review-witness/manifest.json')));await assert.rejects(fs.stat(join(root,'worker.lock')));
   if(race==='supervisor')assert.equal(await fs.readFile(join(root,'supervisor.lock'),'utf8'),'foreign');
  }finally{await fs.rm(root,{recursive:true,force:true});}
 }
});

test('one immutable witness review claim survives a crash; cached result requires exact current row and major or uncertain still holds',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'review-witness-claim-'));await fs.mkdir(join(root,'review-witness'));const data=fixture(),witness=validateReviewWitness(data),row=evidenceRow(data.item,data.report,data.phone,data.oldRow.neighbors,data.context,witness);
 try{
  await claimWitnessReview(root,row,'key');
  await assert.rejects(claimWitnessReview(root,row,'key'),/EEXIST/);await assert.rejects(claimWitnessReview(root,{...row,extra:'variant'},'new-key'),/EEXIST/);
  await verifyWitnessReviewResult(root,row,'key',{rows:[row]});await assert.rejects(verifyWitnessReviewResult(root,row,'key',{rows:[data.oldRow]}));await assert.rejects(verifyWitnessReviewResult(root,row,'key',{rows:[{...row,audioSha256:'stale'}]}));
  for(const severity of ['major','uncertain'])assert.equal(modelReview(data.report,{evidenceHash:hash(row),severity},row).severity,severity);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('missing or changed activation manifest cannot silently bypass a reserved witness',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'review-witness-pin-')),d=join(root,'review-witness');await fs.mkdir(d);const manifest=fixture().manifest;
 try{
  const item={customId:'unrelated'};assert.equal(await loadReviewWitness(root,item),null);
  const pin={schemaVersion:1,policy:reviewWitnessPolicy,manifestHash:fingerprint(manifest),audioSha256:manifest.audioSha256,originalDecisionHash:manifest.oldDecisionHash,maximumReviews:1};await fs.writeFile(join(d,'pin.json'),JSON.stringify(pin));
  await assert.rejects(loadReviewWitness(root,item));
  await fs.writeFile(join(d,'manifest.json'),JSON.stringify({...manifest,passage:'unknown'}));await assert.rejects(loadReviewWitness(root,item));
  await fs.writeFile(join(d,'manifest.json'),JSON.stringify(manifest));assert.equal(await loadReviewWitness(root,item),null);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
