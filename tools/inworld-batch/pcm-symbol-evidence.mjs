/** Required spoken qualifiers cannot be discarded as punctuation. */
import {sha} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
export const pcmSymbolPolicy='pcm-required-plus-v1';
export const comparisonPolicy='spoken-plus-v1';
export const pcmASRModels={small:'models--mlx-community--whisper-small-mlx/snapshots/45f3915923c7a79a5a5b5a7d909d39aeb0e5630e',strong:'models--mlx-community--whisper-large-v3-turbo/snapshots/a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb'};
const fail=()=>{throw Error('PCM symbol preservation evidence is missing or changed');};
const tokens=text=>(text.replace(/<[^>]*>/g,' ').replace(/\+/g,' plus ').toLowerCase().match(/[a-z]+/g)??[]);
export const plusCount=text=>tokens(text).filter(word=>word==='plus').length;
function symbols(text){const result=[];for(let i=0;i<text.length;i++)if(text[i]==='+')result.push({sourceStart:i,sourceEnd:i+1,symbol:'+',spoken:'plus'});return result;}
function evidence(all,digest){const file=all?.[digest];if(!/^[a-f0-9]{64}$/.test(digest??'')||!file||sha(file.bytes)!==digest||fingerprint(JSON.parse(file.bytes.toString('utf8')))!==fingerprint(file.value))fail();return file.value;}
function phones(proof,range){
 let previous=null;const result=[];
 for(const frame of proof.frames??[]){
  if(frame.acousticSupportStartSample48k<range.startSample||frame.acousticSupportEndSample48k>range.endSample)continue;
  if(frame.tokenId===proof.blankTokenId){previous=null;continue;}
  if(frame.token!==previous)result.push(frame.token);previous=frame.token;
 }
 return result.join('');
}
export function validatePCMSymbols({validation,child,baseContext,candidateAudio,derivation,symbolEvidence}){
 const s=validation.symbolPreservation,expected=child.spokenText,required=symbols(expected),candidateSha=sha(candidateAudio);
 if(!s||s.policy!==pcmSymbolPolicy||s.comparisonPolicy!==comparisonPolicy||s.expectedTextSha256!==sha(expected)||s.parentExpectedTextSha256!==sha(baseContext.comparisonExpected)||s.sourceAudioSha256!==derivation.sourceAudioSha256||s.candidateAudioSha256!==candidateSha||fingerprint(s.requiredSymbols)!==fingerprint(required))fail();
 if(!Array.isArray(s.asr)||s.asr.length!==2||new Set(s.asr.map(row=>row.evidenceSha256)).size!==2||!['small','strong'].every(model=>s.asr.filter(row=>row.model===model).length===1))fail();
 const expectedTokens=tokens(expected),requiredPlus=plusCount(expected);
 for(const row of s.asr){
  const raw=evidence(symbolEvidence,row.evidenceSha256);
  if(row.inputPrompt!==null||row.audioSha256!==candidateSha||typeof row.transcript!=='string'||sha(row.transcript)!==row.transcriptSha256||raw.model!==pcmASRModels[row.model]||raw.audioSha256!==candidateSha||raw.inputPrompt!==null||raw.result?.text!==row.transcript)fail();
  const recognized=tokens(row.transcript);if(plusCount(row.transcript)!==requiredPlus)fail();
  // Every source qualifier must retain its preceding grade/name in order.
  const expectedPlus=expectedTokens.flatMap((word,i)=>word==='plus'?[i]:[]),recognizedPlus=recognized.flatMap((word,i)=>word==='plus'?[i]:[]);
  for(const [i,at]of expectedPlus.entries())if(at>0&&(recognizedPlus[i]===0||recognized[recognizedPlus[i]-1]!==expectedTokens[at-1]))fail();
 }
 const c=s.ctc;
 if(!c||c.requiredSymbolsPreserved!==true||c.sourceAudioSha256!==s.sourceAudioSha256||c.candidateAudioSha256!==candidateSha||c.boundaryCrossingNonblankRuns!==0||c.unrelatedWordPhonemesAbsent!==true||c.leftNearestEightPhonemeTokensPreserved!==true||c.rightNearestEightPhonemeTokensPreserved!==true)fail();
 const source=evidence(symbolEvidence,c.sourceEvidenceSha256),candidate=evidence(symbolEvidence,c.candidateEvidenceSha256);
 if(source.audioSha256!==s.sourceAudioSha256||candidate.audioSha256!==candidateSha||source.inputPrompt!==null||candidate.inputPrompt!==null||source.sampleRate!==48000||candidate.sampleRate!==48000||source.model!=='facebook/wav2vec2-lv-60-espeak-cv-ft'||candidate.model!==source.model||source.revision!=='ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4'||candidate.revision!==source.revision)fail();
 if(!Array.isArray(c.sourcePlusSupportSamples)||c.sourcePlusSupportSamples.length!==requiredPlus||!Array.isArray(c.candidatePlusSupportSamples)||c.candidatePlusSupportSamples.length!==requiredPlus)fail();
 const start=derivation.removedRangeHalfOpen.startSample,end=derivation.removedRangeHalfOpen.endSample,removed=end-start;
 for(const [i,r]of c.sourcePlusSupportSamples.entries()){
  if(!Number.isSafeInteger(r.startSample)||!Number.isSafeInteger(r.endSample)||r.startSample<0||r.endSample<=r.startSample||r.endSample>derivation.originalFrames)fail();
  if(!(r.endSample<=start-480||r.startSample>=end+480))fail();
  const mapped={startSample:r.startSample>=end?r.startSample-removed:r.startSample,endSample:r.endSample>=end?r.endSample-removed:r.endSample};
  if(fingerprint(mapped)!==fingerprint(c.candidatePlusSupportSamples[i])||phones(source,r)!=='plʌs'||phones(candidate,mapped)!=='plʌs')fail();
 }
 return {policy:pcmSymbolPolicy,comparisonPolicy,hash:fingerprint(s)};
}
