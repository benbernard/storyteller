/** Verify one source-decimal recovery layer; never accepts content or submits speech. */
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {hash,sha} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {buildDecimalRecoveryPlan,decimalPolicy,decimalReceipt} from './decimal-plan.mjs';
import {validateDecimalDiagnosis} from './decimal-diagnosis.mjs';
import {decodePCM16} from './pcm-excision-core.mjs';

const read=async path=>JSON.parse(await fs.readFile(path,'utf8'));
const fail=()=>{throw Error('Decimal recovery comparison proof failed validation');};
const exact=(left,right)=>{if(fingerprint(left)!==fingerprint(right))fail();};
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]+$/.test(value);
function safeRoot(value){
 if(typeof value!=='string'||value.startsWith('/')||value.split(/[\\/]/).some(part=>!part||part==='.'||part==='..'))fail();
 return value;
}
export function decimalDirectory(root,item){if(!safeId(item.customId))fail();return join(root,'rendering-recoveries',decimalPolicy,item.customId);}

/** baseContext must already have passed the retained notation/source/audio verifier. */
export function validateDecimalContext({chapter,item,source,receipt,plan,baseReceipt,baseContext,basePlan,attempt2Plan,children,manifest,report,decision,baseAudio,finalChildren,currentAudio}){
 if(!baseContext||sha(baseAudio)!==baseReceipt.sha256||baseContext.receiptHash!==fingerprint(baseReceipt)
  ||!chapter.items.some(row=>hash(row)===hash(item))||receipt.offlinePCMExcision||!receipt.decimalRecovery)fail();
 if(!Array.isArray(children)||children.length!==13||!Buffer.concat(children.map(child=>{
  if(!Buffer.isBuffer(child.audio)||sha(child.audio)!==child.audioSha256)fail();
  return decodePCM16(child.audio).pcm;
 })).equals(decodePCM16(baseAudio).pcm))fail();
 validateDecimalDiagnosis({manifest,report,decision,item,baseReceipt,audio:children.find(c=>c.item.customId===manifest.originalChild)?.audio});
 const rebuilt=buildDecimalRecoveryPlan({chapter,item,source,baseReceipt,baseContext,basePlan,attempt2Plan,children,manifest});
 exact(plan,rebuilt);
 if(!Array.isArray(finalChildren)||finalChildren.length!==plan.parts.length)fail();
 const finals=[],pcm=[];
 for(const [index,part]of plan.parts.entries()){
  const child=finalChildren[index],expected=part.replacement??part.baseItem;
  if(child.id!==part.id||child.root!==part.root||!safeId(child.id))fail();
  const digest=sha(child.audio),proof=child.receipt;
  if(proof.sha256!==digest||proof.voiceId!==baseReceipt.voiceId||proof.requestHash!==hash({...expected.request,voiceId:baseReceipt.voiceId}))fail();
  if(part.reused&&(digest!==part.baseAudioSha256||fingerprint(proof)!==part.baseReceiptHash))fail();
  pcm.push(decodePCM16(child.audio).pcm);
  finals.push({id:part.id,root:part.root,sha256:digest,job:proof.job,reused:part.reused});
 }
 const decoded=decodePCM16(currentAudio),audioSha256=sha(currentAudio);
 if(!Buffer.concat(pcm).equals(decoded.pcm)||receipt.sha256!==audioSha256||!Number.isFinite(receipt.duration)||receipt.duration<=0||Math.abs(receipt.duration-decoded.frames/48000)>1/48000)fail();
 exact(receipt,decimalReceipt(baseReceipt,plan,{audioSha256,duration:receipt.duration,parts:finals}));
 return {...baseContext,comparisonExpected:plan.renderingProof.text,renderingProof:plan.renderingProof,
  baseRenderingContext:baseContext,audioSha256,receiptHash:fingerprint(receipt),
  decimalRecovery:{policy:decimalPolicy,planHash:fingerprint(plan),manifestHash:fingerprint(manifest),baseReceiptHash:fingerprint(baseReceipt),baseAudioSha256:baseReceipt.sha256,baseContextHash:fingerprint(baseContext),audioSha256,freshFullQARequired:true}};
}

export async function decimalContext(root,item,receipt,baseContext){
 const directory=decimalDirectory(root,item),chapter=await read(join(root,'input.json'));
 const [source,baseReceipt,baseAudio,basePlan,attempt2Plan,plan,manifest,chapterManifest,savedContext,report,decision]=await Promise.all([
  read(join(root,'source.json')),read(join(directory,'base-receipt.json')),fs.readFile(join(directory,'base.wav')),
  read(join(directory,'base-plan.json')),read(join(directory,'attempt2-plan.json')),read(join(directory,'plan.json')),
  read(join(directory,'manifest.json')),read(join(root,'rendering-recoveries',decimalPolicy,'manifest.json')),read(join(directory,'base-context.json')),read(join(directory,'original-review.json')),read(join(directory,'original-decision.json'))]);
 exact(manifest,chapterManifest);exact(savedContext,baseContext);
 exact(basePlan,await read(join(root,'rendering-recoveries',baseReceipt.renderingRecovery?.rendererVersion??'',item.customId,'plan.json')));
 exact(attempt2Plan,await read(join(root,'repairs',item.customId,'attempt-2','plan.json')));
 const children=[],finalChildren=[];
 for(const [index,part]of basePlan.parts.entries()){
  const original=attempt2Plan.items[index],current=part.replacement??original;
  if(!safeId(part.id)||!current)fail();
  const path=join(root,safeRoot(part.root));
  const audio=await fs.readFile(join(path,'audio',part.id+'.wav'));
  children.push({item:current,root:part.root,receipt:await read(join(path,'receipts',part.id+'.json')),audioSha256:sha(audio),audio});
 }
 // Rebuild before opening final part paths; only deterministic roots are trusted.
 exact(plan,buildDecimalRecoveryPlan({chapter,item,source,baseReceipt,baseContext,basePlan,attempt2Plan,children,manifest}));
 for(const part of plan.parts){
  if(!safeId(part.id))fail();const path=join(root,safeRoot(part.root));
  finalChildren.push({id:part.id,root:part.root,receipt:await read(join(path,'receipts',part.id+'.json')),audio:await fs.readFile(join(path,'audio',part.id+'.wav'))});
 }
 return validateDecimalContext({chapter,item,source,receipt,plan,baseReceipt,baseContext,basePlan,attempt2Plan,children,manifest,report,decision,baseAudio,finalChildren,currentAudio:await fs.readFile(join(root,'audio',item.customId+'.wav'))});
}
