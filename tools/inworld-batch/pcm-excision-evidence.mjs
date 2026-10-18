import fs from 'node:fs/promises';
import {join} from 'node:path';
import {hash,sha} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {buildPCMExcision,pcmExcisionPolicy} from './pcm-excision-core.mjs';
const read=async path=>JSON.parse(await fs.readFile(path,'utf8'));
export function excisionDirectory(root,item){if(!/^[A-Za-z0-9_-]+$/.test(item.customId))throw Error('Invalid PCM passage ID');return join(root,'offline-pcm-excisions',pcmExcisionPolicy,item.customId);}
export function editedPCMReceipt(base,plan){return {...base,sha256:plan.audioSha256,duration:plan.frames/48000,offlinePCMExcision:{schemaVersion:1,policy:pcmExcisionPolicy,planPath:`offline-pcm-excisions/${pcmExcisionPolicy}/${plan.passage}/plan.json`,planHash:fingerprint(plan),baseReceiptHash:fingerprint(base),baseAudioSha256:base.sha256,audioSha256:plan.audioSha256,freshFullQARequired:true}};}
export async function loadPCMExcisionEvidence(root,item,receipt,baseContext,baseAudio,baseReceiptBytes,directory,childId){
 const chapter=await read(join(root,'input.json')),children=[];
 for(const part of receipt.renderingRecovery.parts){
  if(typeof part.root!=='string'||part.root.split(/[\\/]/).some(value=>value==='..')||part.root.startsWith('/'))throw Error('Unsafe PCM child root');
  if(!/^[A-Za-z0-9_-]+$/.test(part.id))throw Error('Unsafe PCM child ID');
  children.push({...part,receipt:await read(join(root,part.root,'receipts',part.id+'.json')),audio:await fs.readFile(join(root,part.root,'audio',part.id+'.wav'))});
 }
 return {entry:{chapterId:chapter.chapterId,inputHash:hash(chapter)},chapter,item,source:await read(join(root,'source.json')),receipt,baseContext,parentAudio:baseAudio,baseReceiptFileSha256:sha(baseReceiptBytes),children,childId,
  candidateAudio:await fs.readFile(join(directory,'candidate.wav')),derivation:await read(join(directory,'derivation.json')),validation:await read(join(directory,'validation-metadata.json')),fullParent:await read(join(directory,'full-parent-derivation-metadata.json'))};
}
export async function validatePCMExcisionLayer(root,item,receipt,baseContext){
 const directory=excisionDirectory(root,item),baseBytes=await fs.readFile(join(directory,'base-receipt.json')),base=JSON.parse(baseBytes.toString('utf8')),saved=await read(join(directory,'plan.json'));
 const built=buildPCMExcision(await loadPCMExcisionEvidence(root,item,base,baseContext,await fs.readFile(join(directory,'base.wav')),baseBytes,directory,saved.childId));
 if(fingerprint(saved)!==fingerprint(built.plan)||fingerprint(receipt)!==fingerprint(editedPCMReceipt(base,built.plan)))throw Error('Offline PCM receipt or evidence layer changed');
 const current=await fs.readFile(join(root,'audio',item.customId+'.wav'));
 if(!current.equals(built.audio))throw Error('Current audio differs from exact offline PCM deletion');
 return {...baseContext,audioSha256:receipt.sha256,receiptHash:fingerprint(receipt),offlinePCMExcision:{policy:pcmExcisionPolicy,planHash:fingerprint(saved),baseReceiptHash:fingerprint(base),baseAudioSha256:base.sha256,audioSha256:receipt.sha256,timingValidationHash:saved.timingValidationHash,derivationHash:saved.derivationHash,fullParentValidationHash:saved.fullParentValidationHash,freshFullQARequired:true}};
}
