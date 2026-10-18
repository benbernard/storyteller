/** One source-bound supplemental acoustic review. No inference or provider access. */
import fs from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {hash,sha} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {decodePCM16} from './pcm-excision-core.mjs';
import {pcmASRModels} from './pcm-symbol-evidence.mjs';
import {renderingContext} from './rendering-review.mjs';
import {withChapterProcessingLock} from './chapter-processing-lock.mjs';
import {evidenceRow} from './adjudication.mjs';

export const reviewWitnessPolicy='contested-acoustic-review-v1';
const here=dirname(fileURLToPath(import.meta.url));
const fail=()=>{throw Error('Contested review witness is stale, changed or unsupported');};
const exact=(a,b)=>{if(fingerprint(a)!==fingerprint(b))fail();};
const safe=value=>typeof value==='string'&&/^[A-Za-z0-9_-]+$/.test(value);
const compact=text=>text.replace(/[\sˈˌː:]/gu,'').replaceAll('ɹ','r');
const read=async path=>JSON.parse(await fs.readFile(path,'utf8'));
const optional=async path=>{try{return await read(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const directory=root=>join(root,'review-witness');
const raw=row=>{if(typeof row?.json!=='string'||sha(row.json)!==row.sha256)fail();return JSON.parse(row.json);};
const letterPhones={a:'eɪ',b:'bi',c:'si',d:'di',e:'i',f:'ɛf',g:'dʒi',h:'eɪtʃ',i:'aɪ',j:'dʒeɪ',k:'keɪ',l:'ɛl',m:'ɛm',n:'ɛn',o:'oʊ',p:'pi',q:'kju',r:'ɑɹ',s:'ɛs',t:'ti',u:'ju',v:'vi',w:'dʌbəlju',x:'ɛks',y:'waɪ',z:'zi'};

function acoustic(row,audio,kind){
 const value=raw(row),decoded=decodePCM16(audio),digest=sha(audio);
 if(value.audioSha256!==digest||value.inputPrompt!==null||value.providerDisabled!==true||value.sampleRate!==48000||value.decodedFrames!==decoded.frames)fail();
 if(kind!=='phones'){
  if(value.model!==pcmASRModels[kind]||value.temperature!==0||value.fp16!==false||value.word_timestamps!==true||value.condition_on_previous_text!==false||typeof value.result?.text!=='string'||!value.result.text.trim())fail();
  const words=value.result.segments?.flatMap(s=>s.words??[]);
  if(!words?.length||words.some(w=>!Number.isFinite(w.start)||!Number.isFinite(w.end)||w.start<0||w.end<w.start||w.end>decoded.frames/48000+.5))fail();
  return value;
 }
 if(value.model!=='facebook/wav2vec2-lv-60-espeak-cv-ft'||value.revision!=='ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4'||value.doPhonemize!==false||value.localModelChecksumsVerified!==true||typeof value.phonemes!=='string'||!value.phonemes.trim()||!Array.isArray(value.frames)||value.frames.length!==Math.floor((Math.ceil(decoded.frames/3)-400)/320)+1||value.featureStrideSamples16k!==320||value.featureReceptiveFieldSamples16k!==400||value.blankTokenId!==0)fail();
 const floats=Buffer.alloc(decoded.frames*4);for(let i=0;i<decoded.frames;i++)floats.writeFloatLE(decoded.pcm.readInt16LE(i*2)/32768,i*4);
 if(value.decodedFloatPCMSha256!==sha(floats))fail();
 const groups=[];
 for(const [i,frame]of value.frames.entries()){
  if(frame.frame!==i||!Number.isSafeInteger(frame.tokenId)||frame.tokenId<0||typeof frame.token!=='string'||frame.acousticSupportStartSample48k!==i*960||frame.acousticSupportEndSample48k!==i*960+1200||frame.acousticSupportStartSample48k>=decoded.frames)fail();
  if(groups.at(-1)?.id===frame.tokenId)groups.at(-1).last=frame;
  else groups.push({id:frame.tokenId,first:frame,last:frame});
 }
 const mapping=[],tokens=[];
 for(const group of groups)if(group.id!==value.blankTokenId){const token=compact(group.first.token.replaceAll('|',' '));tokens.push(token);for(const character of token)mapping.push({character,group});}
 const text=tokens.join('');if(text!==compact(value.phonemes))fail();
 return {value,text,mapping};
}

/** Current rendering context must have passed the full retained-base verifier first. */
export function validateReviewWitness({manifest,chapter,item,source,receipt,report,phone,context,oldRow,oldDecision,oldProof,parentAudio,children,notationPlan,notationManifest,attempt2Plan,observe=observePrefix}){
 if(manifest?.schemaVersion!==1||manifest.policy!==reviewWitnessPolicy||manifest.maximumReviews!==1||manifest.chapterId!==chapter.chapterId||manifest.passage!==item.customId||!safe(item.customId)
  ||manifest.inputHash!==hash(chapter)||manifest.sourceObjectHash!==fingerprint(source)||manifest.sourceHash!==chapter.source||manifest.itemHash!==hash(item)||manifest.receiptHash!==fingerprint(receipt)
  ||manifest.audioSha256!==receipt.sha256||manifest.reportHash!==hash(report)||manifest.normalPhoneHash!==hash(phone)||manifest.renderingContextHash!==fingerprint(context)
  ||manifest.oldRowHash!==hash(oldRow)||manifest.oldDecisionHash!==hash(oldDecision)||manifest.oldProofHash!==fingerprint(oldProof)
  ||manifest.oldReasonSha256!==sha(oldDecision.reason)
  ||oldDecision.severity!=='major'||oldDecision.audioSha256!==receipt.sha256||oldDecision.reportHash!==hash(report)||oldDecision.evidenceHash!==hash(oldRow)||oldDecision.proofHash!==hash(oldProof.value)
  ||oldProof.authentication!=='chatgpt'||!oldProof.rows.some(row=>hash(row)===hash(oldRow))||!oldProof.value?.decisions?.some(row=>row.passage===item.customId&&row.severity===oldDecision.severity&&row.reason===oldDecision.reason)
  ||oldRow.audioSha256!==receipt.sha256||oldRow.reportHash!==hash(report)||oldRow.phonemeHash!==hash(phone)||oldRow.expected!==item.spokenText||phone.audioSha256!==receipt.sha256||phone.inputPrompt!==null||!phone.phonemes.trim()
  ||report.expected!==item.spokenText||report.sha256!==receipt.sha256||context.audioSha256!==receipt.sha256||context.receiptHash!==fingerprint(receipt)||!context.decimalRecovery||receipt.repair?.attempt!==2||!receipt.decimalRecovery||receipt.offlinePCMExcision)fail();
 exact(oldRow.renderingContext,context);exact(report.renderingContext,context);
 const at=chapter.items.findIndex(row=>row.customId===item.customId);
 exact(oldRow,evidenceRow(item,report,phone,{before:chapter.items[at-1]?.spokenText??'',after:chapter.items[at+1]?.spokenText??''},context));
 const audioSha256=sha(parentAudio),decoded=decodePCM16(parentAudio),saved=receipt.decimalRecovery.parts;
 if(audioSha256!==receipt.sha256||children.length!==13||saved.length!==13||!Buffer.concat(children.map(c=>decodePCM16(c.audio).pcm)).equals(decoded.pcm)||!Array.isArray(manifest.children)||manifest.children.length!==2||new Set(manifest.children.map(c=>c.id)).size!==2)fail();
 let cursor=0;const current=[];
 for(const [index,child]of children.entries()){
  const metadata=saved[index],digest=sha(child.audio),frames=decodePCM16(child.audio).frames;
  if(child.id!==metadata.id||child.root!==metadata.root||child.receipt.sha256!==digest||metadata.sha256!==digest||child.receipt.voiceId!==receipt.voiceId||metadata.job!==child.receipt.job)fail();
  current.push({...child,start:cursor,end:cursor+frames});cursor+=frames;
 }
 const observations=[];
 for(const selection of manifest.children){
  const child=current.find(c=>c.id===selection.id);if(!child||selection.root!==child.root||selection.audioSha256!==sha(child.audio)||selection.receiptHash!==fingerprint(child.receipt)||selection.parentStartFrame!==child.start||selection.parentEndFrame!==child.end)fail();
  const field=selection.sourceRange;if(!field||![field.start,field.end].every(Number.isSafeInteger)||field.start<0||field.end<=field.start||field.end>source.text.length)fail();
  const literal=source.text.slice(field.start,field.end);if(field.sha256!==sha(literal)||!chapter.segments.some(s=>s.items.includes(item.customId)&&s.spans.some(span=>field.start>=span.start&&field.end<=span.end)))fail();
  const phones=acoustic(selection.evidence?.phones,child.audio,'phones');
  if(selection.kind==='literal-unit'){
   const passage=notationManifest.passages.find(p=>p.passage===item.customId),range=passage?.sourceRanges.find(r=>r.kind==='literal-unit');
   const part=notationPlan.parts.find(p=>p.id===child.id);
   if(!range||range.sourceStart!==field.start||range.sourceEnd!==field.end||!part?.replacement||part.reused||part.root!==child.root||!/^[a-z]{4}\/[a-z]{3}$/.test(literal)||Object.keys(selection.evidence).join(',')!=='phones')fail();
   const numerator=literal.slice(0,4),expected=compact([...numerator].map(c=>letterPhones[c]).join(''));
   const offsets=[...phones.text.matchAll(new RegExp(expected,'gu'))].map(m=>m.index);if(offsets.length!==1)fail();
   // The challenged claim is specifically a third-letter a/i substitution.
   if(numerator[2]!=='a')fail();const alternative=compact([...numerator.slice(0,2)+'i'+numerator.slice(3)].map(c=>letterPhones[c]).join(''));
   if(phones.text.includes(alternative)||!compact(phone.phonemes).includes(expected)||compact(phone.phonemes).includes(alternative))fail();
   const first=phones.mapping[offsets[0]].group.first,last=phones.mapping[offsets[0]+expected.length-1].group.last;
   observations.push({kind:selection.kind,child:child.id,audioSha256:sha(child.audio),sourceRange:field,requiredSourceLetterPhones:expected,challengedVariantPhones:alternative,requiredSequenceCount:1,challengedVariantCount:0,firstArgmaxFrame:first.frame,lastArgmaxFrame:last.frame,childSupportSamples48k:[first.acousticSupportStartSample48k,last.acousticSupportEndSample48k],parentSupportSamples48k:[child.start+first.acousticSupportStartSample48k,child.start+last.acousticSupportEndSample48k],evidenceSha256:selection.evidence.phones.sha256});
  }else if(selection.kind==='statistic-prefix'){
   const original=attempt2Plan.items.find(c=>c.customId===child.id),a=selection.childRange,q=selection.queuedRange;
   if(!original||!/^[A-Za-z]{2}-[A-Za-z]{7}$/.test(literal)||/[\p{L}\p{N}\p{M}_]$/u.test(source.text.slice(0,field.start))||/^[\p{L}\p{N}\p{M}_]/u.test(source.text.slice(field.end))||!a||!q||![a.start,a.end,q.start,q.end].every(Number.isSafeInteger)||a.start<0||a.end-a.start!==literal.length||original.spokenText.slice(a.start,a.end)!==literal||item.spokenText.slice(q.start,q.end)!==literal||q.end-q.start!==literal.length||q.start!==item.spokenText.indexOf(original.spokenText)+a.start||!saved.find(p=>p.id===child.id)?.reused)fail();
   const small=acoustic(selection.evidence.small,child.audio,'small'),strong=acoustic(selection.evidence.strong,child.audio,'strong');if(selection.evidence.small.sha256===selection.evidence.strong.sha256||Object.keys(selection.evidence).sort().join(',')!=='phones,small,strong')fail();
   observations.push({kind:selection.kind,child:child.id,audioSha256:sha(child.audio),sourceRange:field,observations:observe(original.spokenText,literal,[small.result.text,strong.result.text]),phonemes:phones.value.phonemes,evidenceSha256:['small','strong','phones'].map(k=>selection.evidence[k].sha256)});
  }else fail();
 }
 if(observations.filter(o=>o.kind==='literal-unit').length!==1||observations.filter(o=>o.kind==='statistic-prefix').length!==1)fail();
 return {schemaVersion:1,policy:reviewWitnessPolicy,manifestHash:fingerprint(manifest),originalDecisionHash:hash(oldDecision),originalEvidenceHash:hash(oldRow),audioSha256,
  purpose:'One independent review of new, separately collected source-bound acoustic evidence. This is evidence, not an acceptance decision or authority to waive any mismatch. Apply the existing strict materiality rules to the entire unchanged passage. Argmax timing is approximate, not forced alignment. The prefix has no established literal-letter pronunciation contract; assess observed speech without assuming one.',observations,automaticAcceptance:false,maximumReviews:1};
}
function observePrefix(expected,literal,transcripts){
 const child=spawnSync('python3',[join(here,'review_witness_observations.py')],{input:JSON.stringify({expected,literal,transcripts}),encoding:'utf8',maxBuffer:1e6});
 if(child.status!==0)fail();return JSON.parse(child.stdout);
}

export async function reviewWitnessMaterials(root,passage,manifest){
 const chapter=await read(join(root,'input.json')),item=chapter.items.find(i=>i.customId===passage);if(!item)fail();
 const receipt=await read(join(root,'receipts',passage+'.json')),report=await read(join(root,'review',passage+'.json')),phone=await read(join(root,'phoneme-review',passage+'.json'));
 const d=directory(root),oldDecision=await optional(join(d,'original-decision.json'))??(await read(join(root,'llm-decisions.json')))[passage];
 const oldProof=await optional(join(d,'original-proof.json'))??await read(oldDecision.proof),oldRow=oldProof.rows.find(row=>hash(row)===oldDecision.evidenceHash);
 const children=[];for(const part of receipt.decimalRecovery?.parts??[]){
  if(!safe(part.id)||typeof part.root!=='string'||part.root.startsWith('/')||part.root.split(/[\\/]/u).some(p=>!p||p==='.'||p==='..'))fail();
  children.push({id:part.id,root:part.root,receipt:await read(join(root,part.root,'receipts',part.id+'.json')),audio:await fs.readFile(join(root,part.root,'audio',part.id+'.wav'))});
 }
 return {manifest,chapter,item,receipt,report,phone,source:await read(join(root,'source.json')),context:await renderingContext(root,item),oldDecision,oldProof,oldRow,parentAudio:await fs.readFile(join(root,'audio',passage+'.wav')),children,
  notationPlan:await read(join(root,'rendering-recoveries',receipt.renderingRecovery.rendererVersion,passage,'plan.json')),notationManifest:await read(join(root,'rendering-recoveries',receipt.renderingRecovery.rendererVersion,'manifest.json')),attempt2Plan:await read(join(root,'repairs',passage,'attempt-2','plan.json'))};
}
export async function loadReviewWitness(root,item){
 const manifest=await optional(join(directory(root),'manifest.json')),pin=await optional(join(directory(root),'pin.json'));
 if(!manifest&&!pin)return null;
 if(!manifest||!pin)fail();exact(pin,witnessPin(manifest));
 if(manifest.passage!==item.customId)return null;
 if(await fs.readFile(join(root,'owner-review.lock'),'utf8')!==String(process.pid))fail();
 return validateReviewWitness(await reviewWitnessMaterials(root,item.customId,manifest));
}
const witnessPin=manifest=>({schemaVersion:1,policy:reviewWitnessPolicy,manifestHash:fingerprint(manifest),audioSha256:manifest.audioSha256,originalDecisionHash:manifest.oldDecisionHash,maximumReviews:1});
export async function attachReviewWitness(config,entry,manifest,expectedHash,{loadMaterials=reviewWitnessMaterials}={}){
 if(fingerprint(manifest)!==expectedHash||entry.chapterId!==manifest.chapterId)fail();
 const root=config.root,lock=join(root,'worker.lock');
 for(const name of ['worker.lock','supervisor.lock'])if(await fs.stat(join(root,name)).then(()=>true,()=>false))fail();
 const quiet=async()=>{if(!await fs.stat(join(root,'pause.requested')).then(()=>true,()=>false)||await fs.stat(join(root,'supervisor.lock')).then(()=>true,()=>false)||(await read(join(root,'status.json'))).status!=='paused'||(await read(join(root,'supervisor-status.json'))).status!=='paused'||await optional(join(entry.root,'published.json')))fail();};
 await quiet();
 const handle=await fs.open(lock,'wx',0o600);await handle.writeFile(String(process.pid));const identity=await handle.stat();
 try{return await withChapterProcessingLock(entry.root,async()=>{
  await quiet();
  const materials=await loadMaterials(entry.root,manifest.passage,manifest),witness=validateReviewWitness(materials),d=directory(entry.root);
  if(entry.inputHash!==hash(materials.chapter))fail();
  await quiet();
  const prior=await optional(join(d,'manifest.json')),pin=await optional(join(d,'pin.json'));if(pin)exact(pin,witnessPin(manifest));if(prior){exact(prior,manifest);if(!pin)fail();return witness;}
  await fs.mkdir(d,{recursive:true});
  if(!pin)await fs.writeFile(join(d,'pin.json'),JSON.stringify(witnessPin(manifest),null,2)+'\n',{flag:'wx',mode:0o600});
  // The pin reserves the immutable manifest first; its activation manifest is created last.
  for(const [name,value]of [['original-decision.json',materials.oldDecision],['original-proof.json',materials.oldProof]]){
   const file=join(d,name),old=await optional(file);if(old)exact(old,value);else await fs.writeFile(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  await fs.writeFile(join(d,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx',mode:0o600});return witness;
 },{waitForOwner:false});}finally{await handle.close();const current=await fs.stat(lock);if(current.ino!==identity.ino||current.dev!==identity.dev||await fs.readFile(lock,'utf8')!==String(process.pid))fail();await fs.unlink(lock);}
}
export async function claimWitnessReview(root,row,key){
 const path=join(directory(root),'review-attempt.json'),value={schemaVersion:1,policy:reviewWitnessPolicy,manifestHash:row.supplementalAcousticWitness.manifestHash,audioSha256:row.audioSha256,rowHash:hash(row),key,maximumReviews:1};
 await fs.writeFile(path,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});return value;
}
export async function verifyWitnessReviewClaim(root,row,key){
 const value=await read(join(directory(root),'review-attempt.json'));
 exact(value,{schemaVersion:1,policy:reviewWitnessPolicy,manifestHash:row.supplementalAcousticWitness.manifestHash,audioSha256:row.audioSha256,rowHash:hash(row),key,maximumReviews:1});
}
export async function verifyWitnessReviewResult(root,row,key,result){
 await verifyWitnessReviewClaim(root,row,key);
 if(hash(result?.rows)!==hash([row]))fail();
}
export async function reusableReviewDecision(root,row,decision,instructions,model){
 if(!decision||decision.evidenceHash!==hash(row)||decision.audioSha256!==row.audioSha256||decision.reportHash!==row.reportHash)return null;
 const proof=await read(decision.proof),key=hash({instructions,model,rows:proof.rows});
 if(decision.validator!==model+'/chatgpt'||resolve(decision.proof)!==resolve(root,'llm-review',key+'.json')||proof.authentication!=='chatgpt'||hash(proof.value)!==decision.proofHash||!Array.isArray(proof.rows)||!proof.rows.some(r=>hash(r)===hash(row))||proof.value.decisions.length!==proof.rows.length)fail();
 const at=proof.rows.findIndex(r=>hash(r)===hash(row)),saved=proof.value.decisions[at];
 if(saved.passage!==row.passage||saved.severity!==decision.severity||saved.reason!==decision.reason||!['pass','minor','major','uncertain'].includes(saved.severity))fail();
 return decision;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [configPath,chapterId,manifestPath,expectedHash,mode]=process.argv.slice(2);if(!configPath||!chapterId||!manifestPath||!expectedHash||mode&&mode!=='--attach')throw Error('Usage: review-witness.mjs QUEUE CHAPTER_ID MANIFEST_JSON REVIEWED_SHA256 [--attach]');
  const config=await read(configPath),entry=config.chapters.find(e=>e.chapterId===chapterId),manifest=await read(manifestPath);if(!entry||entry.chapterId!==manifest.chapterId||fingerprint(manifest)!==expectedHash)fail();
  let witness;
  if(mode)witness=await attachReviewWitness(config,entry,manifest,expectedHash);
  else{const materials=await reviewWitnessMaterials(entry.root,manifest.passage,manifest);if(entry.inputHash!==hash(materials.chapter))fail();witness=validateReviewWitness(materials);}
  console.log(JSON.stringify({validated:true,attached:!!mode,manifestHash:witness.manifestHash,passage:manifest.passage,audioSha256:witness.audioSha256,children:witness.observations.map(o=>o.child),maximumReviews:1,providerCalls:0}));
 }catch{console.error('Contested review witness validation or attachment failed; evidence retained.');process.exitCode=1;}
}
