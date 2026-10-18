import fs from 'node:fs/promises';
import {join} from 'node:path';
import {hash,sha} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {fixture,read,save} from './notation-test-fixture.mjs';
import {renderingContext} from './rendering-review.mjs';
import {decimalPolicy,decimalNormalizationProof} from './decimal-plan.mjs';
import {pcmASRModels} from './pcm-symbol-evidence.mjs';
import {decodePCM16} from './pcm-excision-core.mjs';
import {recoverDecimalPassage,preflightDecimalRecovery} from './decimal-recovery.mjs';
export function diagnosisFor(audio,report,decision){
 const decoded=decodePCM16(audio),floats=Buffer.alloc(decoded.frames*4);for(let i=0;i<decoded.frames;i++)floats.writeFloatLE(decoded.pcm.readInt16LE(i*2)/32768,i*4);
 const encode=value=>{const json=JSON.stringify(value);return {json,sha256:sha(json)};};
 const asr=label=>encode({audioSha256:sha(audio),model:pcmASRModels[label],inputPrompt:null,providerDisabled:true,sampleRate:48000,decodedFrames:decoded.frames,temperature:0,fp16:false,condition_on_previous_text:false,word_timestamps:true,result:{text:'Weight twelve five kilograms',segments:[{words:[{word:'Weight',start:0,end:Math.min(.5,decoded.frames/48000)}]}]}});
 return {reportHash:hash(report),decisionHash:hash(decision),small:asr('small'),strong:asr('strong'),phones:encode({audioSha256:sha(audio),model:'facebook/wav2vec2-lv-60-espeak-cv-ft',revision:'ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4',inputPrompt:null,providerDisabled:true,sampleRate:48000,decodedFrames:decoded.frames,doPhonemize:false,localModelChecksumsVerified:true,decodedFloatPCMSha256:sha(floats),blankTokenId:0,phonemes:'test',frames:[...'test'].map(token=>({token,tokenId:token.charCodeAt(0)}))})};
}
export async function decimalFixture(){
 const f=await fixture({legacyDecimal:true,wav:true}),targets=await f.preflight();await f.pin();for(const t of targets)await f.recover(t);
 const item=targets[0].item,baseReceipt=await read(join(f.folder,'receipts',item.customId+'.json')),basePlan=targets[0].plan,baseContext=await renderingContext(f.folder,item),source=await read(join(f.folder,'source.json')),normalization=decimalNormalizationProof('12.5kg'),at=source.text.indexOf('12.5kg'),queued=item.spokenText.indexOf(normalization.legacy),original=f.originals.get(item.customId),originalChild=original.plan.items.find(c=>c.spokenText.includes(normalization.legacy));
 const children=[];for(const [index,p]of basePlan.parts.entries()){const current=p.replacement??original.plan.items[index],receipt=await read(join(f.folder,p.root,'receipts',p.id+'.json')),audio=await fs.readFile(join(f.folder,p.root,'audio',p.id+'.wav'));children.push({item:current,root:p.root,receipt,audioSha256:sha(audio),audio});}
 const report={expected:item.spokenText,sha256:baseReceipt.sha256,severity:'minor'},decision={passage:item.customId,audioSha256:baseReceipt.sha256,reportHash:hash(report),severity:'major',reason:'Synthetic canonical decimal point is missing.'};await save(join(f.folder,'review',item.customId+'.json'),report);await save(join(f.folder,'llm-decisions.json'),{[item.customId]:decision});
 const manifest={schemaVersion:1,policy:decimalPolicy,maximumSelectedChildren:1,maximumSubmissions:1,chapterId:f.chapter.chapterId,passage:item.customId,originalChild:originalChild.customId,inputHash:f.entry.inputHash,sourceObjectHash:fingerprint(source),canonicalTextSha256:sha(source.text),baseReceiptHash:fingerprint(baseReceipt),baseAudioSha256:baseReceipt.sha256,baseContextHash:fingerprint(baseContext),baseNotationPlanHash:baseContext.planHash,baseNotationManifestHash:basePlan.notationManifestHash,sourceRange:{start:at,end:at+6,sha256:sha('12.5kg')},queuedRange:{start:queued,end:queued+normalization.legacy.length,sha256:sha(normalization.legacy)},normalization,parts:children.map(c=>({id:c.item.customId,root:c.root,itemHash:hash(c.item),receiptHash:fingerprint(c.receipt),audioSha256:c.audioSha256})),diagnosis:diagnosisFor(children.find(c=>c.item.customId===originalChild.customId).audio,report,decision)};
 const args={entry:f.entry,chapter:f.chapter,config:f.config,voices:f.voices,read,save,run:f.run,synthesize:f.synthesize,status:async()=>{},manifest};
 return {...f,manifest,item,baseReceipt,basePlan,baseContext,children,report,decision,args,decimalPreflight:()=>preflightDecimalRecovery(args),decimalRecover:overrides=>recoverDecimalPassage({...args,...overrides})};
}
