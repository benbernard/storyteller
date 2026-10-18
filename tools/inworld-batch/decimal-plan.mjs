/** One reviewed canonical decimal defect; no provider, file or model operations. */
import {hash,sha,validateCoverage} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
export const decimalPolicy='legacy-adjacent-decimal-v1';
export const historicalDecimalFormatterSha='2d273c9d185975c3cfef49f8fd6e893e657f13893650560188d505dee9053b6a';
export const correctedDecimalFormatterSha='7b801358b405e535b22e4c5b590e7a820c2963ad6fec8ca1004bdf5e025ac21a';
const fail=()=>{throw Error('Decimal recovery source, base or selected child changed');};
const small=['zero','one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve','thirteen','fourteen','fifteen','sixteen','seventeen','eighteen','nineteen'];
function integer(value){
 if(value<20)return small[value];
 if(value<100)return ['', '', 'twenty','thirty','forty','fifty','sixty','seventy','eighty','ninety'][Math.floor(value/10)]+(value%10?' '+small[value%10]:'');
 for(const [scale,name]of [[1e6,'million'],[1e3,'thousand'],[100,'hundred']])if(value>=scale)return integer(Math.floor(value/scale))+' '+name+(value%scale?' '+integer(value%scale):'');
 fail();
}
export function decimalNormalizationProof(source){
 const match=/^(0|[1-9]\d{0,8})\.(\d{1,6})(kg)$/.exec(source);if(!match)fail();
 const legacy=integer(Number(match[1]))+'.'+match[2]+match[3],text=integer(Number(match[1]))+' point '+[...match[2]].map(d=>small[Number(d)]).join(' ')+' '+match[3];
 const content={policy:decimalPolicy,source,sourceHash:sha(source),legacy,legacyHash:sha(legacy),text,spokenHash:sha(text),historicalFormatterSha:historicalDecimalFormatterSha,correctedFormatterSha:correctedDecimalFormatterSha};
 return {...content,fingerprint:fingerprint(content)};
}
export function validateDecimalManifest(manifest){
 if(manifest?.schemaVersion!==1||manifest.policy!==decimalPolicy||manifest.maximumSelectedChildren!==1||manifest.maximumSubmissions!==1
  ||typeof manifest.chapterId!=='string'||typeof manifest.passage!=='string'||typeof manifest.originalChild!=='string'
  ||!Array.isArray(manifest.parts)||manifest.parts.length!==13||new Set(manifest.parts.map(p=>p.id)).size!==13)fail();
 return manifest;
}
export function buildDecimalRecoveryPlan({chapter,item,source,baseReceipt,baseContext,basePlan,attempt2Plan,children,manifest}){
 validateDecimalManifest(manifest);validateCoverage(chapter.segments,source.text);
 if(!chapter.items.some(value=>hash(value)===hash(item)))fail();
 if(manifest.chapterId!==chapter.chapterId||manifest.passage!==item.customId||manifest.inputHash!==hash(chapter)||manifest.sourceObjectHash!==fingerprint(source)
  ||manifest.canonicalTextSha256!==sha(source.text)||manifest.baseReceiptHash!==fingerprint(baseReceipt)||manifest.baseAudioSha256!==baseReceipt.sha256
  ||manifest.baseContextHash!==fingerprint(baseContext)||manifest.baseNotationPlanHash!==baseContext.planHash
  ||manifest.baseNotationManifestHash!==basePlan.notationManifestHash||baseReceipt.decimalRecovery||baseReceipt.offlinePCMExcision
  ||baseReceipt.repair?.attempt!==2||baseReceipt.renderingRecovery?.rendererVersion!=='source-numeric-notation-v1'
  ||baseContext.audioSha256!==baseReceipt.sha256||baseContext.planHash!==fingerprint(basePlan)||baseContext.renderingProof?.policy!=='source-numeric-notation-v1'
  ||baseContext.comparisonExpected!==baseContext.renderingProof.text||basePlan.parts.length!==13||children.length!==13
  ||attempt2Plan.attempt!==2||hash(attempt2Plan)!==baseReceipt.repair.planHash)fail();
 const sr=manifest.sourceRange,qr=manifest.queuedRange;
 for(const range of [sr,qr])if(!Number.isInteger(range?.start)||!Number.isInteger(range?.end)||range.start<0||range.end<=range.start)fail();
 if(sr.end>source.text.length||qr.end>item.spokenText.length||/^[\p{L}\p{N}\p{M}_]/u.test(source.text.slice(sr.end))||/^[\p{L}\p{N}\p{M}_]/u.test(item.spokenText.slice(qr.end))||!/\bWeight\s*:\s*$/iu.test(item.spokenText.slice(Math.max(0,qr.start-24),qr.start)))fail();
 const segment=chapter.segments.find(s=>s.items.includes(item.customId));
 if(!segment||segment.presentation||!segment.spans.some(s=>sr.start>=s.start&&sr.end<=s.end)||!/\bWeight\s*:\s*$/iu.test(source.text.slice(Math.max(0,sr.start-24),sr.start)))fail();
 const canonical=source.text.slice(sr.start,sr.end),normalization=decimalNormalizationProof(canonical);
 if(sr.sha256!==sha(canonical)||qr.sha256!==sha(item.spokenText.slice(qr.start,qr.end))||item.spokenText.slice(qr.start,qr.end)!==normalization.legacy
  ||fingerprint(manifest.normalization)!==fingerprint(normalization))fail();
 const copy=baseContext.renderingProof.mapping.find(p=>p.kind==='copy'&&qr.start>=p.sourceStart&&qr.end<=p.sourceEnd);
 if(!copy)fail();const start=copy.spokenStart+qr.start-copy.sourceStart,end=start+qr.end-qr.start,baseText=baseContext.comparisonExpected;
 if(baseText.slice(start,end)!==normalization.legacy)fail();
 let cursor=0,selected=0;const parts=[];
 for(const [index,base]of basePlan.parts.entries()){
  const original=attempt2Plan.items[index],current=children[index],pinned=manifest.parts[index];
  const at=item.spokenText.indexOf(original.spokenText,cursor);if(at<cursor||item.spokenText.slice(cursor,at).trim())fail();cursor=at+original.spokenText.length;
  const expected=base.replacement??original;
  if(current.item.customId!==base.id||hash(current.item)!==hash(expected)||current.root!==base.root||current.receipt.sha256!==current.audioSha256
   ||current.receipt.voiceId!==baseReceipt.voiceId||current.receipt.requestHash!==hash({...expected.request,voiceId:baseReceipt.voiceId})
   ||fingerprint(pinned)!==fingerprint({id:base.id,root:base.root,itemHash:hash(expected),receiptHash:fingerprint(current.receipt),audioSha256:current.audioSha256}))fail();
  const target=original.customId===manifest.originalChild;let replacement=null;
  if(target){
   if(!base.reused||qr.start<at||qr.end>cursor||original.role!==item.role||!original.request.text.endsWith(original.spokenText))fail();selected++;
   const text=original.spokenText.slice(0,qr.start-at)+normalization.text+original.spokenText.slice(qr.end-at);
   replacement={...original,customId:original.customId+'dp1',spokenText:text,request:{...original.request,text:original.request.text.slice(0,-original.spokenText.length)+text}};
  }
  parts.push({id:replacement?.customId??base.id,originalId:base.id,root:replacement?`rendering-recoveries/${decimalPolicy}/${item.customId}/generated`:base.root,reused:!replacement,baseItem:expected,baseReceiptHash:fingerprint(current.receipt),baseAudioSha256:current.audioSha256,replacement});
 }
 if(selected!==1||item.spokenText.slice(cursor).trim())fail();
 // Mapping offsets are UTF16 in the verified base comparison view, whose
 // SHA is inputSpokenHash; sourceHash separately pins immutable queued text.
 const text=baseText.slice(0,start)+normalization.text+baseText.slice(end),content={policy:decimalPolicy,sourceHash:sha(item.spokenText),inputSpokenHash:sha(baseText),spokenHash:sha(text),text,baseRenderingProofFingerprint:baseContext.renderingProof.fingerprint,normalization,sourceRange:sr,queuedRange:qr,mapping:[{kind:'copy',sourceStart:0,sourceEnd:start,spokenStart:0,spokenEnd:start},{kind:'decimal',sourceStart:start,sourceEnd:end,spokenStart:start,spokenEnd:start+normalization.text.length},{kind:'copy',sourceStart:end,sourceEnd:baseText.length,spokenStart:start+normalization.text.length,spokenEnd:text.length}]};
 return {schemaVersion:1,policy:decimalPolicy,chapterId:chapter.chapterId,passage:item.customId,inputHash:hash(chapter),sourceHash:chapter.source,sourceObjectHash:fingerprint(source),manifestHash:fingerprint(manifest),baseReceiptHash:fingerprint(baseReceipt),baseAudioSha256:baseReceipt.sha256,baseContextHash:fingerprint(baseContext),baseNotationPlanHash:baseContext.planHash,renderingProof:{...content,fingerprint:fingerprint(content)},parts};
}

/** The complete allowed receipt delta; all earlier proof fields stay identical. */
export function decimalReceipt(baseReceipt,plan,{audioSha256,duration,parts}){
 if(!/^[a-f0-9]{64}$/.test(audioSha256??'')||!Number.isFinite(duration)||duration<=0||!Array.isArray(parts)||parts.length!==13
  ||parts.some((p,i)=>p.id!==plan.parts[i].id||p.root!==plan.parts[i].root||p.reused!==plan.parts[i].reused||!/^[a-f0-9]{64}$/.test(p.sha256??'')||typeof p.job!=='string'))fail();
 return {...baseReceipt,sha256:audioSha256,duration,decimalRecovery:{schemaVersion:1,policy:decimalPolicy,planPath:`rendering-recoveries/${decimalPolicy}/${plan.passage}/plan.json`,planHash:fingerprint(plan),manifestHash:plan.manifestHash,inputHash:plan.inputHash,sourceHash:plan.sourceHash,baseReceiptHash:plan.baseReceiptHash,baseAudioSha256:plan.baseAudioSha256,renderingProof:plan.renderingProof,parts,audioSha256}};
}
