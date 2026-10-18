/** Validate immutable, unprompted evidence of the selected legacy decimal defect. */
import {hash,sha} from './core.mjs';
import {decodePCM16} from './pcm-excision-core.mjs';
import {pcmASRModels} from './pcm-symbol-evidence.mjs';
const fail=()=>{throw Error('Decimal recovery diagnosis is missing, stale or unsupported');};
function raw(row){if(typeof row?.json!=='string'||sha(row.json)!==row.sha256)fail();return JSON.parse(row.json);}
const compact=text=>text.replace(/[\sˈˌː:]/gu,'');
export function validateDecimalDiagnosis({manifest,report,decision,item,baseReceipt,audio}){
 const diagnosis=manifest.diagnosis;if(!diagnosis||diagnosis.reportHash!==hash(report)||diagnosis.decisionHash!==hash(decision)
  ||report.expected!==item.spokenText||report.sha256!==baseReceipt.sha256||decision.audioSha256!==baseReceipt.sha256||decision.reportHash!==hash(report)||decision.severity!=='major')fail();
 const decoded=decodePCM16(audio),digest=sha(audio),expected=manifest.parts.find(p=>p.id===manifest.originalChild);
 if(expected?.audioSha256!==digest)fail();
 const small=raw(diagnosis.small),strong=raw(diagnosis.strong),phones=raw(diagnosis.phones),correction=diagnosis.frameCorrection?raw(diagnosis.frameCorrection):null;
 if(diagnosis.small.sha256===diagnosis.strong.sha256)fail();
 for(const [label,value]of [['small',small],['strong',strong]]){
  if(value.audioSha256!==digest||value.model!==pcmASRModels[label]||value.inputPrompt!==null||value.providerDisabled!==true||value.sampleRate!==48000
   ||value.temperature!==0||value.fp16!==false||value.condition_on_previous_text!==false||value.word_timestamps!==true||typeof value.result?.text!=='string'||!value.result.text.trim()
   ||/\bpoint\b|\d+\.\d+/iu.test(value.result.text))fail();
  if(value.decodedFrames!==decoded.frames){
   const headerFrames=Math.floor(audio.readUInt32LE(decoded.dataStart-4)/2),row=correction?.outputs?.[label];
   if(audio.readUInt32LE(decoded.dataStart-4)!==0xffffffff||headerFrames!==2147483647||value.decodedFrames!==headerFrames||correction?.kind!=='streaming-wav-header-declared-frame-count'||correction.audioSha256!==digest||correction.actualDecodedFrames!==decoded.frames||correction.declaredHeaderFrames!==headerFrames
    ||correction.rawASRPreserved!==true||correction.rawTranscriptOrModelResultChanged!==false||row?.rawDeclaredFrameCount!==value.decodedFrames||row.rawEvidenceSha256!==diagnosis[label].sha256)fail();
  }
  const timestamps=value.result.segments?.flatMap(s=>s.words??[]);if(!Array.isArray(timestamps)||!timestamps.length||timestamps.some(w=>!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<0||w.end<w.start||w.end>decoded.frames/48000+.5))fail();
 }
 if(phones.audioSha256!==digest||phones.model!=='facebook/wav2vec2-lv-60-espeak-cv-ft'||phones.revision!=='ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4'
  ||phones.inputPrompt!==null||phones.providerDisabled!==true||phones.sampleRate!==48000||phones.decodedFrames!==decoded.frames||phones.doPhonemize!==false||phones.localModelChecksumsVerified!==true
  ||typeof phones.phonemes!=='string'||!phones.phonemes.trim()||/p[ɔoɑ]ɪ?nt/u.test(compact(phones.phonemes))||!Array.isArray(phones.frames)||!phones.frames.length)fail();
 const floats=Buffer.alloc(decoded.frames*4);for(let i=0;i<decoded.frames;i++)floats.writeFloatLE(decoded.pcm.readInt16LE(i*2)/32768,i*4);
 if(phones.decodedFloatPCMSha256!==sha(floats)||correction&&correction.decodedFloatPCMSha256!==sha(floats))fail();
 // Argmax frame strings must corroborate the supplied unprompted transcript.
 let previous=null,text='';for(const frame of phones.frames){if(!Number.isInteger(frame.tokenId)||typeof frame.token!=='string')fail();if(frame.tokenId!==previous&&frame.tokenId!==phones.blankTokenId)text+=frame.token;previous=frame.tokenId;}
 if(compact(text.replaceAll('|',' '))!==compact(phones.phonemes))fail();
 return {policy:'missing-canonical-decimal-point-v1',audioSha256:digest,reportHash:diagnosis.reportHash,decisionHash:diagnosis.decisionHash,evidenceHashes:['small','strong','phones'].map(k=>diagnosis[k].sha256),pointInEitherASR:false,pointInUnpromptedCTC:false};
}
