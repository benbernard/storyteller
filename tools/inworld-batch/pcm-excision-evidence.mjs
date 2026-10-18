import fs from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {hash,sha} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {buildPCMExcision,pcmExcisionPolicy} from './pcm-excision-core.mjs';
import {validateCompletedRollback,validateCorrection} from './pcm-rollback.mjs';
const read=async path=>JSON.parse(await fs.readFile(path,'utf8'));
export function excisionDirectory(root,item){if(!/^[A-Za-z0-9_-]+$/.test(item.customId))throw Error('Invalid PCM passage ID');return join(root,'offline-pcm-excisions',pcmExcisionPolicy,item.customId);}
export function editedPCMReceipt(base,plan){return {...base,sha256:plan.audioSha256,duration:plan.frames/48000,offlinePCMExcision:{schemaVersion:1,policy:pcmExcisionPolicy,planPath:`offline-pcm-excisions/${pcmExcisionPolicy}/${plan.passage}/${plan.legacyCorrection?'correction/':''}plan.json`,planHash:fingerprint(plan),baseReceiptHash:fingerprint(base),baseAudioSha256:base.sha256,audioSha256:plan.audioSha256,freshFullQARequired:true}};}
export async function loadPCMExcisionEvidence(root,item,receipt,baseContext,baseAudio,baseReceiptBytes,directory,childId){
 const chapter=await read(join(root,'input.json')),children=[],attempt2=await read(join(root,'repairs',item.customId,'attempt-2','plan.json'));
 for(const part of receipt.renderingRecovery.parts){
  if(typeof part.root!=='string'||part.root.split(/[\\/]/).some(value=>value==='..')||part.root.startsWith('/'))throw Error('Unsafe PCM child root');
  if(!/^[A-Za-z0-9_-]+$/.test(part.id))throw Error('Unsafe PCM child ID');
  children.push({...part,spokenText:attempt2.items.find(row=>row.customId===part.id)?.spokenText,receipt:await read(join(root,part.root,'receipts',part.id+'.json')),audio:await fs.readFile(join(root,part.root,'audio',part.id+'.wav'))});
 }
 const validation=await read(join(directory,'validation-metadata.json')),s=validation.symbolPreservation,symbolEvidence={};
 let retained=false;try{retained=Boolean((await read(join(directory,'plan.json'))).symbolPreservation);}catch(error){if(error.code!=='ENOENT')throw error;}
 for(const row of [...(s?.asr??[]),...(s?.ctc?[{evidenceFile:s.ctc.sourceEvidenceFile,evidenceSha256:s.ctc.sourceEvidenceSha256},{evidenceFile:s.ctc.candidateEvidenceFile,evidenceSha256:s.ctc.candidateEvidenceSha256}]:[])]){
  if(!/^[a-f0-9]{64}$/.test(row.evidenceSha256??'')||typeof row.evidenceFile!=='string')throw Error('Invalid PCM symbol evidence reference');
  let bytes;try{bytes=await fs.readFile(join(directory,'symbol-evidence',row.evidenceSha256+'.json'));}catch(error){if(error.code!=='ENOENT'||retained)throw error;bytes=await fs.readFile(resolve(directory,row.evidenceFile));}
  if(sha(bytes)!==row.evidenceSha256)throw Error('PCM symbol evidence file changed');symbolEvidence[row.evidenceSha256]={bytes,value:JSON.parse(bytes.toString('utf8'))};
 }
 return {entry:{chapterId:chapter.chapterId,inputHash:hash(chapter)},chapter,item,source:await read(join(root,'source.json')),receipt,baseContext,parentAudio:baseAudio,baseReceiptFileSha256:sha(baseReceiptBytes),children,childId,
  candidateAudio:await fs.readFile(join(directory,'candidate.wav')),derivation:await read(join(directory,'derivation.json')),validation,fullParent:await read(join(directory,'full-parent-derivation-metadata.json')),symbolEvidence};
}
export async function validatePCMExcisionLayer(root,item,receipt,baseContext){
 const originalDirectory=excisionDirectory(root,item),correction=receipt.offlinePCMExcision?.planPath===`offline-pcm-excisions/${pcmExcisionPolicy}/${item.customId}/correction/plan.json`,directory=correction?join(originalDirectory,'correction'):originalDirectory,baseBytes=await fs.readFile(join(originalDirectory,'base-receipt.json')),base=JSON.parse(baseBytes.toString('utf8')),saved=await read(join(directory,'plan.json'));
 const args=await loadPCMExcisionEvidence(root,item,base,baseContext,await fs.readFile(join(originalDirectory,'base.wav')),baseBytes,directory,saved.childId),built=buildPCMExcision(args);
 if(correction){const old=await read(join(originalDirectory,'plan.json')),rollback=await validateCompletedRollback({entry:{chapterId:args.chapter.chapterId,inputHash:hash(args.chapter),root},chapter:args.chapter,item},fingerprint(old),receipt);built.plan=validateCorrection(old,rollback.plan,built.plan);}
 if(fingerprint(saved)!==fingerprint(built.plan)||fingerprint(receipt)!==fingerprint(editedPCMReceipt(base,built.plan)))throw Error('Offline PCM receipt or evidence layer changed');
 const current=await fs.readFile(join(root,'audio',item.customId+'.wav'));
 if(!current.equals(built.audio))throw Error('Current audio differs from exact offline PCM deletion');
 return {...baseContext,audioSha256:receipt.sha256,receiptHash:fingerprint(receipt),offlinePCMExcision:{policy:pcmExcisionPolicy,planHash:fingerprint(saved),baseReceiptHash:fingerprint(base),baseAudioSha256:base.sha256,audioSha256:receipt.sha256,timingValidationHash:saved.timingValidationHash,derivationHash:saved.derivationHash,fullParentValidationHash:saved.fullParentValidationHash,freshFullQARequired:true}};
}
