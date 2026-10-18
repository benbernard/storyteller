/** One bounded, zero-paid PCM deletion. This never decides content fidelity. */
import {sha,hash,validateCoverage} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
export const pcmExcisionPolicy='pcm-insertion-excision-v1';
const fail=message=>{throw Error('PCM insertion excision: '+message);};
const exact=(a,b,message)=>{if(fingerprint(a)!==fingerprint(b))fail(message);};
export function decodePCM16(wav){
 if(!Buffer.isBuffer(wav)||wav.length<44||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE')fail('unsupported WAV');
 let fmt=false,data;
 for(let offset=12;offset+8<=wav.length;){
  const id=wav.toString('ascii',offset,offset+4),declared=wav.readUInt32LE(offset+4),start=offset+8;
  const size=id==='data'&&declared===0xffffffff?wav.length-start:declared;
  if(start+size>wav.length)fail('truncated WAV chunk');
  if(id==='fmt '){if(fmt||size<16||wav.readUInt16LE(start)!==1||wav.readUInt16LE(start+2)!==1||wav.readUInt32LE(start+4)!==48000||wav.readUInt32LE(start+8)!==96000||wav.readUInt16LE(start+12)!==2||wav.readUInt16LE(start+14)!==16)fail('requires mono 48 kHz PCM16');fmt=true;}
  if(id==='data'){if(data||start+size!==wav.length||size%2)fail('unsupported PCM data layout');data={pcm:wav.subarray(start,start+size),dataStart:start,frames:size/2};}
  offset=start+size+(size%2);
 }
 if(!fmt||!data)fail('missing PCM WAV chunks');return data;
}
export function replacePCM(wav,pcm){
 const decoded=decodePCM16(wav);if(pcm.length%2)fail('unaligned PCM');
 const result=Buffer.concat([wav.subarray(0,decoded.dataStart),pcm]);
 result.writeUInt32LE(result.length-8,4);result.writeUInt32LE(pcm.length,decoded.dataStart-4);return result;
}
export function buildPCMExcision({entry,chapter,item,source,receipt,baseContext,parentAudio,baseReceiptFileSha256,children,childId,candidateAudio,derivation,validation,fullParent}){
 if(hash(chapter)!==entry.inputHash||chapter.chapterId!==entry.chapterId||!chapter.items.some(row=>hash(row)===hash(item)))fail('queued input changed');
 if(receipt.offlinePCMExcision||receipt.repair?.attempt!==2||!receipt.renderingRecovery)fail('requires one unedited exhausted rendering recovery');
 if(baseContext.audioSha256!==receipt.sha256||baseContext.receiptHash!==fingerprint(receipt)||sha(parentAudio)!==receipt.sha256)fail('base rendering/audio proof changed');
 validateCoverage(chapter.segments,source.text);
 if(children.length!==receipt.renderingRecovery.parts.length)fail('child coverage changed');
 const parent=decodePCM16(parentAudio),decoded=children.map(child=>decodePCM16(child.audio));
 if(!Buffer.concat(decoded.map(child=>child.pcm)).equals(parent.pcm))fail('base parent is not the exact concatenated children');
 let childOffset=0;const mapped=[];
 for(const [index,child]of children.entries()){
  const saved=receipt.renderingRecovery.parts[index],audioSha256=sha(child.audio);
  exact({id:child.id,root:child.root,reused:child.reused,sha256:audioSha256,job:child.receipt.job},saved,'base child provenance changed');
  if(child.receipt.sha256!==audioSha256||child.receipt.voiceId!==receipt.voiceId)fail('child audio/voice changed');
  mapped.push({index,id:child.id,root:child.root,audioSha256,pcmSha256:sha(decoded[index].pcm),startFrameWithinParent:childOffset,frames:decoded[index].frames,endFrameWithinParent:childOffset+decoded[index].frames,isBadReusedChild:child.id===childId});
  childOffset+=decoded[index].frames;
 }
 const matches=children.map((child,index)=>child.id===childId?index:-1).filter(index=>index>=0);
 if(matches.length!==1)fail('requires exactly one target child');const index=matches[0],child=children[index],old=decoded[index],candidate=decodePCM16(candidateAudio);
 if(!child.reused)fail('target must be an unchanged reused child');
 const start=derivation.removedRangeHalfOpen?.startSample,end=derivation.removedRangeHalfOpen?.endSample,removed=end-start;
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<480||end>old.frames-480||removed<1||removed>96000||removed>old.frames*.2)fail('deletion is broad or outside retained guards');
 const seams=[old.pcm.readInt16LE((start-1)*2),old.pcm.readInt16LE(start*2),old.pcm.readInt16LE((end-1)*2),old.pcm.readInt16LE(end*2)];
 if(seams.some(value=>value!==0))fail('all four seam samples must be zero');
 const retained=Buffer.concat([old.pcm.subarray(0,start*2),old.pcm.subarray(end*2)]);
 if(!candidate.pcm.equals(retained))fail('candidate changes retained child PCM');
 const ranges=[{originalStart:0,originalEnd:start,candidateStart:0,candidateEnd:start,sha256:sha(old.pcm.subarray(0,start*2))},{originalStart:end,originalEnd:old.frames,candidateStart:start,candidateEnd:candidate.frames,sha256:sha(old.pcm.subarray(end*2))}];
 if(derivation.schemaVersion!==1||derivation.sourceAudioSha256!==sha(child.audio)||derivation.sourcePCMSha256!==sha(old.pcm)||derivation.candidateAudioSha256!==sha(candidateAudio)||derivation.candidatePCMSha256!==sha(candidate.pcm)||derivation.originalFrames!==old.frames||derivation.candidateFrames!==candidate.frames||derivation.removedFrames!==removed||derivation.sampleRate!==48000||derivation.channels!==1||derivation.sampleWidthBytes!==2||derivation.retainedPCMBitExact!==true||derivation.crossfadeSamples!==0||derivation.resampling!==false||derivation.sourceAudioUnchanged!==true||derivation.productionPromotion!==false||derivation.sourceInputReceiptCounterLedgerChanges!==false)fail('timing derivation differs from exact PCM');
 exact(derivation.retainedRanges,ranges,'retained range proof changed');
 exact(derivation.seamValuesPCM16,{leftLastRetained:0,leftFirstRemoved:0,rightLastRemoved:0,rightFirstRetained:0},'seam proof changed');
 exact(validation.derivation,derivation,'timing validation belongs to another derivation');
 if(validation.schemaVersion!==1||validation.productionHoldUnchanged!==true||validation.paidCalls!==0||validation.conclusion?.isolatedTrialRemovesConfirmedInsertion!==true||validation.conclusion?.productionHoldRemains!==true||validation.conclusion?.fullContentResolutionClaimed!==false||!Array.isArray(validation.asr)||validation.asr.length!==2||new Set(validation.asr.map(row=>row.model)).size!==2||!['small','strong'].every(model=>validation.asr.some(row=>row.model===model))||validation.asr.some(row=>row.confirmedUnrelatedWordAbsent!==true||row.recognizedTokensExactlyEqualOriginalMinusConfirmedInsertion!==true||row.sourceTokenImmediatelyBeforeInsertionRecognized!==true||row.sourceTokenImmediatelyAfterInsertionRecognized!==true))fail('independent ASR timing guards are incomplete');
 const ctc=validation.ctc;
 if(ctc?.confirmedUnrelatedPhonemesAbsent!==true||ctc.boundaryCrossingNonblankRuns!==0||ctc.leftNearestEightObservedPhonemeTokensExactlyPreserved!==true||ctc.rightNearestEightObservedPhonemeTokensExactlyPreserved!==true||!Number.isSafeInteger(ctc.leftObservedPhonemeGuardMarginSamples)||ctc.leftObservedPhonemeGuardMarginSamples<480||!Number.isSafeInteger(ctc.rightObservedPhonemeGuardMarginSamples)||ctc.rightObservedPhonemeGuardMarginSamples<480)fail('independent phoneme timing guards are incomplete');
 const parentStart=mapped[index].startFrameWithinParent+start,parentEnd=mapped[index].startFrameWithinParent+end;
 const pcm=Buffer.concat([parent.pcm.subarray(0,parentStart*2),parent.pcm.subarray(parentEnd*2)]);
 const combined=Buffer.concat(decoded.map((value,i)=>i===index?candidate.pcm:value.pcm));if(!combined.equals(pcm))fail('parent requires more than one deletion');
 if(fullParent.schemaVersion!==1||fullParent.chapterId!==chapter.chapterId||fullParent.passage!==item.customId||fullParent.baseParentAudioSha256!==receipt.sha256||fullParent.baseParentReceiptFileSha256!==baseReceiptFileSha256||fullParent.baseParentPCMSha256!==sha(parent.pcm)||fullParent.baseParentFrames!==parent.frames||fullParent.sumChildFrames!==parent.frames||fullParent.baseParentExactlyEqualsConcatenatedDecodedChildren!==true||fullParent.ffmpegPaddingOrHeaderFramesDetected!==false||fullParent.targetChildIndex!==index||fullParent.targetChildStartFrameWithinParent!==mapped[index].startFrameWithinParent||fullParent.targetChildAudioSha256!==sha(child.audio)||fullParent.candidateChildAudioSha256!==sha(candidateAudio)||fullParent.candidateParentFrames!==pcm.length/2||fullParent.candidateParentPCMSha256!==sha(pcm)||fullParent.singleParentDeletionExactlyEqualsReplacingOnlyTargetChild!==true||fullParent.otherChildPCMUnchanged!==true||fullParent.parentOriginalStillUnchanged!==true||fullParent.productionChanges!==false||fullParent.furtherQARequired!==true)fail('full-parent timing proof changed');
 exact(fullParent.parts,mapped,'full-parent child mapping changed');
 const range=fullParent.oneGlobalRemovalRangeHalfOpen;
 if(range?.startFrame!==parentStart||range.endFrame!==parentEnd||range.removedFrames!==removed)fail('full-parent deletion range changed');
 const audio=replacePCM(parentAudio,pcm),plan={schemaVersion:1,policy:pcmExcisionPolicy,chapterId:chapter.chapterId,passage:item.customId,childId,inputHash:entry.inputHash,sourceHash:chapter.source,sourceObjectHash:fingerprint(source),itemHash:hash(item),baseReceiptHash:fingerprint(receipt),baseReceiptFileSha256,baseAudioSha256:receipt.sha256,basePCMSha256:sha(parent.pcm),baseContextHash:fingerprint(baseContext),derivationHash:fingerprint(derivation),timingValidationHash:fingerprint(validation),fullParentValidationHash:fingerprint(fullParent),candidateChildAudioSha256:sha(candidateAudio),childReceiptHash:fingerprint(child.receipt),childAudioSha256:sha(child.audio),children:mapped,removedChildRange:{start,end},removedParentRange:{start:parentStart,end:parentEnd},removedFrames:removed,originalFrames:parent.frames,frames:pcm.length/2,pcmSha256:sha(pcm),audioSha256:sha(audio),freshFullQARequired:true,paidCalls:0};
 return {plan,audio};
}
