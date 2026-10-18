import test from 'node:test';
import assert from 'node:assert/strict';
import {hash,sha} from './core.mjs';
import {wave} from './notation-test-fixture.mjs';
import {diagnosisFor} from './decimal-test-fixture.mjs';
import {validateDecimalDiagnosis} from './decimal-diagnosis.mjs';
function evidence(streaming=false){const audio=wave(Buffer.alloc(96000,7));if(streaming)audio.writeUInt32LE(0xffffffff,40);const item={spokenText:'Weight twelve.5kg.'},baseReceipt={sha256:sha('current notation base')},report={expected:item.spokenText,sha256:baseReceipt.sha256},decision={audioSha256:baseReceipt.sha256,reportHash:hash(report),severity:'major'},manifest={originalChild:'child',parts:[{id:'child',audioSha256:sha(audio)}],diagnosis:diagnosisFor(audio,report,decision)};return {audio,item,baseReceipt,report,decision,manifest};}
const mutateRaw=(data,label,change)=>{const value=JSON.parse(data.manifest.diagnosis[label].json);change(value);const json=JSON.stringify(value);data.manifest.diagnosis[label]={json,sha256:sha(json)};};
test('only the exact streaming WAV sentinel can explain preserved raw ASR frame metadata',()=>{
 const data=evidence(true),d=data.manifest.diagnosis,outputs={};for(const label of ['small','strong']){mutateRaw(data,label,v=>{v.decodedFrames=2147483647;});outputs[label]={rawDeclaredFrameCount:2147483647,rawEvidenceSha256:d[label].sha256};}
 const correction={kind:'streaming-wav-header-declared-frame-count',audioSha256:sha(data.audio),actualDecodedFrames:48000,declaredHeaderFrames:2147483647,rawASRPreserved:true,rawTranscriptOrModelResultChanged:false,decodedFloatPCMSha256:JSON.parse(d.phones.json).decodedFloatPCMSha256,outputs},json=JSON.stringify(correction);d.frameCorrection={json,sha256:sha(json)};assert.equal(validateDecimalDiagnosis(data).pointInEitherASR,false);
 for(const change of [v=>v.declaredHeaderFrames--,v=>v.actualDecodedFrames--,v=>v.outputs.small.rawDeclaredFrameCount--,v=>v.outputs.strong.rawEvidenceSha256='wrong',v=>v.decodedFloatPCMSha256='wrong']){const copy=structuredClone(correction);change(copy);const text=JSON.stringify(copy);d.frameCorrection={json:text,sha256:sha(text)};assert.throws(()=>validateDecimalDiagnosis(data));}
 const arbitrary=evidence();mutateRaw(arbitrary,'small',v=>{v.decodedFrames=999;});arbitrary.manifest.diagnosis.frameCorrection={json,sha256:sha(json)};assert.throws(()=>validateDecimalDiagnosis(arbitrary));
});
test('point already spoken, prompted/stale/changed acoustic input and fabricated CTC text cannot buy repair',()=>{
 for(const change of [d=>mutateRaw(d,'small',v=>{v.result.text='Weight twelve point five kilograms';}),d=>mutateRaw(d,'strong',v=>{v.result.text='Weight 12.5kg';}),d=>mutateRaw(d,'phones',v=>{v.phonemes='pɔɪnt';}),d=>mutateRaw(d,'phones',v=>{v.phonemes='unsupported';}),d=>mutateRaw(d,'phones',v=>{v.inputPrompt='source';}),d=>mutateRaw(d,'strong',v=>{v.model=JSON.parse(d.manifest.diagnosis.small.json).model;}),d=>mutateRaw(d,'small',v=>{v.audioSha256='stale';}),d=>{d.decision.reportHash='stale';}]){const data=evidence();change(data);assert.throws(()=>validateDecimalDiagnosis(data));}
});
