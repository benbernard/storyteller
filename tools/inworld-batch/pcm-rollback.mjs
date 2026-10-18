/** Restore retained bytes; a rollback never approves the rejected edit. */
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {hash,sha} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {decodePCM16,replacePCM} from './pcm-excision-core.mjs';
import {editedPCMReceipt,excisionDirectory} from './pcm-excision-evidence.mjs';
import {baseRenderingContext} from './rendering-review.mjs';
import {plusCount} from './pcm-symbol-evidence.mjs';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const same=(a,b)=>fingerprint(a)===fingerprint(b);
const fail=()=>{throw Error('PCM rollback evidence or exact retained state changed');};
export async function rollbackEvidence({entry,chapter,item},expectedHash,allowedCurrent){
 const directory=excisionDirectory(entry.root,item),rollback=join(directory,'rollback'),oldPlan=await read(join(directory,'plan.json')),baseBytes=await fs.readFile(join(directory,'base-receipt.json')),base=JSON.parse(baseBytes.toString('utf8')),baseAudio=await fs.readFile(join(directory,'base.wav'));
 const context=await baseRenderingContext(entry.root,item,base,join(directory,'base.wav')),source=await read(join(entry.root,'source.json'));
 if(fingerprint(oldPlan)!==expectedHash||oldPlan.symbolPreservation||oldPlan.inputHash!==entry.inputHash||oldPlan.itemHash!==hash(item)||oldPlan.sourceHash!==chapter.source||oldPlan.sourceObjectHash!==fingerprint(source)||oldPlan.baseContextHash!==fingerprint(context)||oldPlan.baseReceiptHash!==fingerprint(base)||oldPlan.baseReceiptFileSha256!==sha(baseBytes)||oldPlan.baseAudioSha256!==sha(baseAudio)||base.sha256!==sha(baseAudio))fail();
 const validation=await read(join(directory,'validation-metadata.json'));
 if(validation.symbolPreservation||fingerprint(validation)!==oldPlan.timingValidationHash||fingerprint(await read(join(directory,'derivation.json')))!==oldPlan.derivationHash||fingerprint(await read(join(directory,'full-parent-derivation-metadata.json')))!==oldPlan.fullParentValidationHash)fail();
 const pcm=decodePCM16(baseAudio).pcm,{start,end}=oldPlan.removedParentRange??{};
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end*2>pcm.length||end-start!==oldPlan.removedFrames)fail();
 const badAudio=replacePCM(baseAudio,Buffer.concat([pcm.subarray(0,start*2),pcm.subarray(end*2)])),bad=editedPCMReceipt(base,oldPlan);
 if(sha(badAudio)!==oldPlan.audioSha256||oldPlan.pcmSha256!==sha(decodePCM16(badAudio).pcm)||!badAudio.equals(await fs.readFile(join(directory,'replacement.wav'))))fail();
 const oldPromotion=await read(join(directory,'promotion.json'));
 if(oldPromotion.state!=='complete'||oldPromotion.passage!==item.customId||oldPromotion.previousSha256!==base.sha256||!same(oldPromotion.receipt,bad))fail();
 const current=await read(join(entry.root,'receipts',item.customId+'.json')),currentAudio=await fs.readFile(join(entry.root,'audio',item.customId+'.wav'));
 if(![base,bad,...(allowedCurrent?[allowedCurrent]:[])].some(row=>same(row,current))||![base.sha256,bad.sha256,...(allowedCurrent?[allowedCurrent.sha256]:[])].includes(sha(currentAudio)))fail();
 return {directory,rollback,oldPlan,base,baseBytes,baseAudio,context,bad,badAudio,current,currentAudio};
}
export async function rollbackPlan(selected,expectedHash,allowedCurrent){
 const e=await rollbackEvidence(selected,expectedHash,allowedCurrent),{entry,item}=selected;
 const badBytes=await fs.readFile(join(e.rollback,'original-receipt.json')),audio=await fs.readFile(join(e.rollback,'original.wav'));
 if(!same(JSON.parse(badBytes.toString('utf8')),e.bad)||!audio.equals(e.badAudio))fail();
 const report=await read(join(e.rollback,'original-review.json')),effective=await read(join(e.rollback,'original-effective-review.json')),phoneme=await read(join(e.rollback,'original-phoneme-review.json')),decision=effective.modelReview;
 if(report.sha256!==e.bad.sha256||report.expected!==item.spokenText||report.comparisonExpected!==e.context.comparisonExpected||report.renderingContext?.offlinePCMExcision?.planHash!==expectedHash||effective.sha256!==report.sha256||effective.expected!==report.expected||!['major','uncertain'].includes(effective.severity)||decision?.audioSha256!==report.sha256||decision.reportHash!==hash(report)||!['major','uncertain'].includes(decision.severity)||phoneme.audioSha256!==report.sha256||phoneme.inputPrompt!==null||!phoneme.phonemes)fail();
 let proofBytes;try{proofBytes=await fs.readFile(join(e.rollback,'original-model-proof.json'));}catch(error){if(error.code!=='ENOENT')throw error;proofBytes=await fs.readFile(decision.proof);}
 const proof=JSON.parse(proofBytes.toString('utf8')),row=proof.rows?.find(row=>row.passage===item.customId);
 if(proof.authentication!=='chatgpt'||!decision.validator?.endsWith('/chatgpt')||hash(proof.value)!==decision.proofHash||!row||hash(row)!==decision.evidenceHash||row.reportHash!==hash(report)||row.phonemeHash!==hash(phoneme)||row.audioSha256!==report.sha256||!proof.value?.decisions?.some(d=>d.passage===item.customId&&d.severity===decision.severity))fail();
 const count=plusCount(e.context.comparisonExpected),plusOmission=count>0&&report.attempts?.length===2&&report.attempts.every(a=>typeof a.transcript==='string'&&plusCount(a.transcript)<count);
 const plan={schemaVersion:1,policy:'pcm-legacy-symbol-rollback-v1',chapterId:entry.chapterId,passage:item.customId,rejectedPlanHash:expectedHash,inputHash:entry.inputHash,baseReceiptHash:fingerprint(e.base),baseReceiptFileSha256:sha(e.baseBytes),baseAudioSha256:e.base.sha256,rejectedReceiptHash:fingerprint(e.bad),rejectedAudioSha256:e.bad.sha256,reportHash:hash(report),effectiveReportHash:hash(effective),phonemeHash:hash(phoneme),modelProofFileSha256:sha(proofBytes),requiredPlusOmissionVerified:plusOmission,paidCalls:0,counterChanges:false};
 return {...e,plan,proofBytes};
}
export async function validateCompletedRollback(selected,expectedHash,allowedCurrent){
 const e=await rollbackPlan(selected,expectedHash,allowedCurrent),saved=await read(join(e.rollback,'plan.json')),journal=await read(join(e.rollback,'promotion.json'));
 if(!same(saved,e.plan)||journal.state!=='complete'||journal.passage!==selected.item.customId||journal.previousSha256!==e.bad.sha256||!same(journal.receipt,e.base))fail();
 if(!allowedCurrent&&(!same(e.current,e.base)||!e.currentAudio.equals(e.baseAudio)||!(await fs.readFile(join(selected.entry.root,'receipts',selected.item.customId+'.json'))).equals(e.baseBytes)))fail();
 return e;
}
export function validateCorrection(oldPlan,rollback,plan){
 const a=oldPlan.removedChildRange,b=plan.removedChildRange;
 const fields=['policy','chapterId','passage','childId','inputHash','sourceHash','sourceObjectHash','itemHash','baseReceiptHash','baseReceiptFileSha256','baseAudioSha256','basePCMSha256','baseContextHash','childReceiptHash','childAudioSha256','children','originalFrames'];
 if(rollback.requiredPlusOmissionVerified!==true||oldPlan.symbolPreservation||!plan.symbolPreservation||fields.some(key=>!same(oldPlan[key],plan[key]))||b.start<a.start||b.end>a.end||b.end-b.start>=a.end-a.start)throw Error('PCM correction must be one strictly narrower deletion from the same rejected legacy base');
 return {...plan,legacyCorrection:{schemaVersion:1,policy:'pcm-legacy-symbol-correction-v1',rejectedPlanHash:fingerprint(oldPlan),rollbackPlanHash:fingerprint(rollback)}};
}
