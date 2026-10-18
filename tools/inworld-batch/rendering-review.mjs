import fs from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash,sha} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {renderVisualRedactions,verifyVisualRedactions} from '../audiobooks/dist/spoken-redactions.js';

import {buildRenderingRecoveryPlan,renderingPolicy,overlayRecoveryPolicy,isRenderingRange} from './rendering-recovery.mjs';
import {notationPolicy,notationRenderer,notationPassage,savedNotationMaterials,replayNotationInput,chapterNotationManifest} from './notation-recovery.mjs';
import {renderCombiningOverlays,verifyCombiningOverlays} from '../audiobooks/dist/spoken-overlays.js';
const rendererFor=policy=>{renderingPolicy(policy);return policy===overlayRecoveryPolicy?{render:renderCombiningOverlays,verify:verifyCombiningOverlays}:{render:renderVisualRedactions,verify:verifyVisualRedactions};};
import {excisionDirectory,validatePCMExcisionLayer} from './pcm-excision-evidence.mjs';
import {decimalDirectory,decimalContext} from './decimal-review.mjs';

const read=async path=>JSON.parse(await fs.readFile(path,'utf8'));
export const renderingFingerprint=fingerprint;

// Only this exact diagnosed visual notation may differ in the spoken comparison.
// The original queued string remains the expected field in every review report.
export function validateRenderingContext({chapter,item,receipt,plan,source,originalReceipt,attempt2Plan,originalAudioSha256,parts,notation}){
 const recovery=receipt?.renderingRecovery;
 if(!recovery)throw Error('Missing visual-redaction recovery proof');
 const policy=recovery.rendererVersion,details=renderingPolicy(policy),renderer=policy===notationPolicy?notationRenderer(item,attempt2Plan,notationPassage(notation,item)):rendererFor(policy);
 const path=`rendering-recoveries/${policy}/${item.customId}/plan.json`;
 if(recovery.schemaVersion!==1||recovery.planPath!==path
  ||recovery.planHash!==fingerprint(plan)||recovery.inputHash!==hash(chapter)||recovery.sourceHash!==chapter.source
  ||recovery.originalItemHash!==hash(item)||recovery.audioSha256!==receipt.sha256||receipt.repair?.attempt!==2)
  throw Error('Visual-redaction receipt does not match immutable inputs or audio');
 const rendering=renderer.verify(item.spokenText,recovery.renderingProof);
 if(!rendering.mapping.some(range=>isRenderingRange(range,details)))throw Error('Visual-redaction proof has no eligible source spans');
 if(plan.schemaVersion!==1||plan.rendererVersion!==policy||plan.chapterId!==chapter.chapterId
  ||plan.passage!==item.customId||plan.inputHash!==recovery.inputHash||plan.sourceHash!==chapter.source
  ||plan.sourceObjectHash!==fingerprint(source)||plan.canonicalTextSha256!==sha(source.text)
  ||plan.originalItemHash!==hash(item)||plan.originalReceiptHash!==fingerprint(originalReceipt)
  ||plan.originalAudioSha256!==originalAudioSha256||originalReceipt.sha256!==originalAudioSha256
  ||recovery.previousSha256!==originalAudioSha256||originalReceipt.repair?.attempt!==2
  ||plan.attempt2PlanHash!==fingerprint(attempt2Plan)||plan.attempt2ParentPlanHash!==hash(attempt2Plan)
  ||originalReceipt.repair.planHash!==hash(attempt2Plan)||fingerprint(receipt.repair)!==fingerprint(originalReceipt.repair)||fingerprint(plan.renderingProof)!==fingerprint(rendering))
  throw Error('Visual-redaction plan or retained original evidence changed');
 const rebuilt=buildRenderingRecoveryPlan({entry:{chapterId:chapter.chapterId,inputHash:hash(chapter)},chapter,item,source,receipt:originalReceipt,attempt2Plan,parts,render:renderer.render,verify:renderer.verify,policy,notation});
 if(fingerprint(rebuilt)!==fingerprint(plan))throw Error('Visual-redaction child/source plan differs from deterministic recovery');
 return {comparisonExpected:rendering.text,renderingProof:rendering,renderingRecoveryHash:fingerprint(recovery),
  planHash:recovery.planHash,receiptHash:fingerprint(receipt),inputHash:recovery.inputHash,sourceHash:recovery.sourceHash,
  originalItemHash:recovery.originalItemHash,audioSha256:receipt.sha256};
}

export async function renderingContext(root,item){
 let receipt;
 try{receipt=await read(join(root,'receipts',item.customId+'.json'));}
 catch(error){if(error.code==='ENOENT')return null;throw error;}
 if(receipt.decimalRecovery){
  if(receipt.offlinePCMExcision)throw Error('Conflicting audio recovery layers');
  const directory=decimalDirectory(root,item),base=await read(join(directory,'base-receipt.json'));
  const context=await baseRenderingContext(root,item,base,join(directory,'base.wav'));
  return await decimalContext(root,item,receipt,context);
 }
 if(receipt.offlinePCMExcision){
  const directory=excisionDirectory(root,item),base=await read(join(directory,'base-receipt.json'));
  const context=await baseRenderingContext(root,item,base,join(directory,'base.wav'));
  return await validatePCMExcisionLayer(root,item,receipt,context);
 }
 return await baseRenderingContext(root,item,receipt);
}
export async function baseRenderingContext(root,item,receipt,audioPath=join(root,'audio',item.customId+'.wav')){
 if(!receipt.renderingRecovery)return null;
 if(!/^[A-Za-z0-9_-]+$/.test(item.customId))throw Error('Invalid visual-redaction passage ID');
 const chapter=await read(join(root,'input.json'));
 const original=chapter.items?.find(value=>value.customId===item.customId);
 if(!original||hash(original)!==hash(item))throw Error('Visual-redaction review item differs from queued input');
 const policy=receipt.renderingRecovery.rendererVersion;renderingPolicy(policy);
 const directory=join(root,'rendering-recoveries',policy,item.customId);
 const plan=await read(join(directory,'plan.json'));
 const attempt2Plan=await read(join(root,'repairs',item.customId,'attempt-2','plan.json'));
 const notation=policy===notationPolicy?await savedNotationMaterials(directory):null;
 if(notation){await chapterNotationManifest(root,notation,async(path,fallback)=>{try{return await read(path);}catch(error){if(error.code==='ENOENT')return fallback;throw error;}});await replayNotationInput(chapter,notation,notation.manifest.preparationSettings);}
 const originalReceipt=await read(join(directory,'original-receipt.json'));
 if(fingerprint(await read(join(directory,'attempt2-plan.json')))!==fingerprint(attempt2Plan))throw Error('Retained attempt-2 plan differs from canonical evidence');
 if(receipt.voiceId!==originalReceipt.voiceId||receipt.requestHash!==originalReceipt.requestHash||receipt.requestHash!==hash({...item.request,voiceId:originalReceipt.voiceId}))throw Error('Visual-redaction original voice/request changed');
 const parts=[];
 for(const originalItem of attempt2Plan.items){
  const originalRoot=join(root,'repairs',item.customId,'attempt-2');
  const proof=await read(join(originalRoot,'receipts',originalItem.customId+'.json'));
  if(proof.requestHash!==hash({...originalItem.request,voiceId:originalReceipt.voiceId}))throw Error('Retained child request or voice changed');
  parts.push({item:originalItem,receipt:proof,audioSha256:sha(await fs.readFile(join(originalRoot,'audio',originalItem.customId+'.wav')))});
 }
 const context=validateRenderingContext({chapter,item,receipt,plan,source:await read(join(root,'source.json')),notation,
  originalReceipt,attempt2Plan,parts,
  originalAudioSha256:sha(await fs.readFile(join(directory,'original.wav')))});
 if(!Array.isArray(receipt.renderingRecovery.parts)||receipt.renderingRecovery.parts.length!==plan.parts.length)throw Error('Recovery final child coverage changed');
 for(const [index,part]of plan.parts.entries()){
  const proof=await read(join(root,part.root,'receipts',part.id+'.json'));
  const digest=sha(await fs.readFile(join(root,part.root,'audio',part.id+'.wav')));
  const expectedRequest=part.reused?attempt2Plan.items[index].request:part.replacement.request;
  if(proof.sha256!==digest||proof.requestHash!==hash({...expectedRequest,voiceId:originalReceipt.voiceId})||proof.voiceId!==originalReceipt.voiceId)throw Error('Recovery child audio/request/voice changed');
  if(part.reused&&(fingerprint(proof)!==part.originalReceiptHash||digest!==part.originalAudioSha256))throw Error('Recovery changed a reused child');
  const final={id:part.id,root:part.root,sha256:digest,job:proof.job,reused:part.reused};
  if(fingerprint(final)!==fingerprint(receipt.renderingRecovery.parts[index]))throw Error('Recovery final child provenance changed');
 }
 if(sha(await fs.readFile(audioPath))!==context.audioSha256)throw Error('Visual-redaction audio no longer matches its receipt');
 return context;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const root=resolve(process.argv[2]),id=process.argv[3];
  const chapter=await read(join(root,'input.json')),item=chapter.items?.find(value=>value.customId===id);
  if(!item)throw Error('Unknown visual-redaction passage');
  console.log(JSON.stringify(await renderingContext(root,item)));
 }catch{console.error('Visual-redaction rendering proof failed validation');process.exitCode=1;}
}
