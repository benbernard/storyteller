import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {join} from 'node:path';
import {hash,sha,validateCoverage} from './core.mjs';
import {installPromotion} from './repair.mjs';
import {notationPolicy,notationPassage,notationRenderer,notationSourceRanges,validateNotationPassage,replayNotationInput,saveNotationMaterials,savedNotationMaterials,chapterNotationManifest} from './notation-recovery.mjs';

export const recoveryPolicy='visual-full-block-redactions-v1';
export const overlayRecoveryPolicy='combining-overlay-v1';
export function renderingPolicy(policy){
 if(policy===recoveryPolicy)return {pattern:()=>/\u2588{2,}/gu,rangeKind:'redaction',suffix:'vr1',kind:'visual-full-block-redaction-recovery'};
 if(policy===overlayRecoveryPolicy)return {pattern:()=>/[\u0334-\u0338]+/gu,rangeKind:'overlay',suffix:'co1',kind:'combining-overlay-recovery'};
 if(policy===notationPolicy)return {rangeKinds:['comparison','celsius','literal-unit'],suffix:'sn1',kind:'source-numeric-notation-recovery'};
 throw Error('Unsupported source-format renderer policy');
}
const sorted=value=>Array.isArray(value)?value.map(sorted):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,sorted(value[key])])):value;
export const canonicalHash=value=>hash(sorted(value));
const words=text=>text.replace(/\s+/gu,' ').trim();
const fail=message=>{throw Error('Rendering recovery: '+message);};
export const isRenderingRange=(range,policy)=>(policy.rangeKinds??[policy.rangeKind]).includes(range.kind);

function sourceRanges(chapter,item,source,renderingProof,notation){
 if(renderingProof.policy===notationPolicy)return notationSourceRanges(chapter,item,source,notationPassage(notation,item),renderingProof);
 const policy=renderingPolicy(renderingProof.policy);
 validateCoverage(chapter.segments,source.text);
 const segment=chapter.segments.find(value=>value.items.includes(item.customId));
 if(!segment||segment.presentation)fail('passage is not canonical body text');
 const spans=segment.spans,raw=spans.map(span=>source.text.slice(span.start,span.end)).join('');
 if(raw!==segment.text)fail('source segment differs from immutable ranges');
 const sourceBlocks=[...raw.matchAll(policy.pattern())];
 const queuedBlocks=segment.items.flatMap(id=>{
  const part=chapter.items.find(value=>value.customId===id);if(!part)fail('missing queued source item');
  return [...part.spokenText.matchAll(policy.pattern())].map(match=>({id,length:match[0].length,index:match.index}));
 });
 if(sourceBlocks.length!==queuedBlocks.length||sourceBlocks.some((match,index)=>match[0].length!==queuedBlocks[index].length))fail('source redaction runs differ from queued text');
 const absolute=offset=>{let cursor=0;for(const span of spans){if(offset<cursor+span.end-span.start)return span.start+offset-cursor;cursor+=span.end-span.start;}fail('source offset is outside immutable ranges');};
 const ranges=[];
 for(const [index,block]of queuedBlocks.entries())if(block.id===item.customId){
  const original=sourceBlocks[index],start=absolute(original.index),end=absolute(original.index+original[0].length-1)+1;
  if(source.text.slice(start,end)!==original[0])fail('source redaction crosses an unsupported boundary');
  ranges.push({itemStart:block.index,itemEnd:block.index+block.length,sourceStart:start,sourceEnd:end});
 }
 const mapped=renderingProof.mapping.filter(range=>range.kind===policy.rangeKind);
 if(!ranges.length||ranges.length!==mapped.length||ranges.some((range,index)=>range.itemStart!==mapped[index].sourceStart||range.itemEnd!==mapped[index].sourceEnd))fail('rendering is not bound to every original redaction run');
 return ranges;
}

export function buildRenderingRecoveryPlan({entry,chapter,item,source,receipt,attempt2Plan,parts,render,verify,policy:rendererPolicy=recoveryPolicy,notation}){
 const policy=renderingPolicy(rendererPolicy);
 if(hash(chapter)!==entry.inputHash||chapter.chapterId!==entry.chapterId||!chapter.items.some(value=>hash(value)===hash(item)))fail('immutable queued input is required');
 if(receipt.repair?.attempt!==2||attempt2Plan.attempt!==2||attempt2Plan.passage!==item.customId||hash(attempt2Plan)!==receipt.repair.planHash)fail('verified exhausted attempt-2 provenance is required');
 if(parts.length!==attempt2Plan.items.length||receipt.repair.parts.length!==parts.length)fail('attempt-2 child coverage differs');
 const selection=rendererPolicy===notationPolicy?validateNotationPassage({chapter,item,source,receipt,attempt2Plan,parts,materials:notation,render}).selectedChildren:null;
 const renderingProof=verify(item.spokenText,render(item.spokenText));
 if(renderingProof.policy!==rendererPolicy)fail('unsupported renderer policy');
 const ranges=sourceRanges(chapter,item,source,renderingProof,notation);
 const relative=join('rendering-recoveries',rendererPolicy,item.customId),planned=[];let cursor=0;
 for(const [index,part]of parts.entries()){
  const original=attempt2Plan.items[index],proof=part.receipt,old=receipt.repair.parts[index];
  if(original.role!==item.role||hash(part.item)!==hash(original)||proof.sha256!==part.audioSha256||old.id!==original.customId||old.sha256!==proof.sha256||old.job!==proof.job)fail('attempt-2 child evidence changed or immutable role differs');
  const start=item.spokenText.indexOf(original.spokenText,cursor);
  if(start<cursor||item.spokenText.slice(cursor,start).trim())fail('repair children omit original source text');
  cursor=start+original.spokenText.length;
  const childProof=verify(original.spokenText,render(original.spokenText)),affected=selection?selection.includes(original.customId):childProof.mapping.some(range=>isRenderingRange(range,policy));
  let replacement=null;
  if(affected){
   if(!original.request.text.endsWith(original.spokenText))fail('child request does not retain its exact source suffix');
   const context=original.request.synthesisContext;
   replacement={...original,customId:original.customId+policy.suffix,spokenText:childProof.text,request:{...original.request,text:original.request.text.slice(0,-original.spokenText.length)+childProof.text,...(context&&rendererPolicy!==notationPolicy?{synthesisContext:{...context,previousRequests:(context.previousRequests??[]).map(value=>({...value,text:render(value.text).text}))}}:{})}};
  }
  planned.push({id:replacement?.customId??original.customId,originalId:original.customId,root:affected?join(relative,'generated'):join('repairs',item.customId,'attempt-2'),reused:!affected,originalReceiptHash:canonicalHash(proof),originalAudioSha256:proof.sha256,originalItemHash:hash(original),renderingProof:childProof,replacement});
 }
 if(item.spokenText.slice(cursor).trim()||!planned.some(part=>!part.reused)||words(planned.map(part=>part.renderingProof.text).join(' '))!==words(renderingProof.text))fail('derived child plan changed non-redacted source content');
 return {schemaVersion:1,kind:policy.kind,rendererVersion:rendererPolicy,chapterId:entry.chapterId,passage:item.customId,inputHash:entry.inputHash,sourceHash:chapter.source,sourceObjectHash:canonicalHash(source),canonicalTextSha256:sha(source.text),originalItemHash:hash(item),originalReceiptHash:canonicalHash(receipt),originalAudioSha256:receipt.sha256,attempt2PlanHash:canonicalHash(attempt2Plan),attempt2ParentPlanHash:receipt.repair.planHash,renderingProof,sourceRanges:ranges,parts:planned,...(selection?{notationManifestHash:notation.hash}:{})};
}

async function once(path,value,read,save){const prior=await read(path,null);if(prior&&canonicalHash(prior)!==canonicalHash(value))fail('saved recovery evidence changed');if(!prior)await save(path,value);}
async function originalAudio(path,target,digest){
 try{await fs.copyFile(path,target,constants.COPYFILE_EXCL);}catch(error){if(error.code!=='EEXIST')throw error;}
 if(sha(await fs.readFile(target))!==digest)fail('saved original audio changed');
}
async function inspectParts(entry,attempt2Plan,voices,read){
 const directory=join(entry.root,'repairs',attempt2Plan.passage,'attempt-2'),parts=[];
 for(const item of attempt2Plan.items){
  const receipt=await read(join(directory,'receipts',item.customId+'.json'));
  if(!voices[item.role]?.voiceId||receipt.voiceId!==voices[item.role].voiceId)fail('attempt-2 child saved voice changed');
  if(receipt.requestHash!==hash({...item.request,voiceId:voices[item.role]?.voiceId}))fail('attempt-2 child voice or request changed');
  parts.push({item,receipt,audioSha256:sha(await fs.readFile(join(directory,'audio',item.customId+'.wav')))});
 }
 return parts;
}
async function finalParts(entry,plan,voices,read){
 const parts=[],files=[];let duration=0;
 for(const part of plan.parts){
  const directory=join(entry.root,part.root),receipt=await read(join(directory,'receipts',part.id+'.json'));
  const file=join(directory,'audio',part.id+'.wav');
  if(sha(await fs.readFile(file))!==receipt.sha256||!(receipt.duration>0))fail('final child receipt differs from audio');
  if(part.reused&&(receipt.sha256!==part.originalAudioSha256||canonicalHash(receipt)!==part.originalReceiptHash))fail('reused child evidence changed');
  if(!part.reused&&receipt.requestHash!==hash({...part.replacement.request,voiceId:voices[part.replacement.role]?.voiceId}))fail('replacement child request or voice changed');
  files.push(file);parts.push({id:part.id,root:part.root,sha256:receipt.sha256,job:receipt.job,reused:part.reused});duration+=receipt.duration;
 }
 return {parts,files,duration};
}

/** All selected passages fail closed before the first new provider request. */
export async function preflightNotationRecovery({entry,chapter,config,read,voices,notation}){
 if(config.maxRetakes!==2||notation.manifest.chapterId!==entry.chapterId)fail('notation requires the original cap and selected chapter');
 await replayNotationInput(chapter,notation,config);
 const pinned=await read(join(entry.root,'rendering-recoveries',notationPolicy,'manifest.json'),null);
 if(pinned&&canonicalHash(pinned)!==notation.hash)fail('chapter notation allowance is already pinned to another manifest');
 const state=await read(join(entry.root,'processing.json'),{}),source=await read(join(entry.root,'source.json'));
 if(state.status!=='needs-review'||await read(join(entry.root,'assembly.json'),null)||await read(join(entry.root,'published.json'),null))fail('notation chapter must be held and unpublished');
 const result=[];
 for(const passage of notation.manifest.passages){
  const item=chapter.items.find(v=>v.customId===passage.passage);
  if(!item||!state.passages?.includes(item.customId))fail('notation target must already be held');
  const directory=join(entry.root,'rendering-recoveries',notationPolicy,item.customId);
  const current=await read(join(entry.root,'receipts',item.customId+'.json'));
  const receipt=await read(join(directory,'original-receipt.json'),current);
  if(current.renderingRecovery&&current.renderingRecovery.rendererVersion!==notationPolicy)fail('another migration cannot be stacked');
  if(!current.renderingRecovery&&canonicalHash(current)!==canonicalHash(receipt))fail('pending parent receipt changed');
  if(!voices[item.role]?.voiceId||receipt.voiceId!==voices[item.role].voiceId||receipt.requestHash!==hash({...item.request,voiceId:voices[item.role].voiceId}))fail('notation parent voice or request changed');
  const attempt2Plan=await read(join(entry.root,'repairs',item.customId,'attempt-2','plan.json'));
  const renderer=notationRenderer(item,attempt2Plan,passage),parts=await inspectParts(entry,attempt2Plan,voices,read);
  const plan=buildRenderingRecoveryPlan({entry,chapter,item,source,receipt,attempt2Plan,parts,...renderer,policy:notationPolicy,notation});
  const retainedManifest=await read(join(directory,'manifest.json'),null),retainedPlan=await read(join(directory,'plan.json'),null);
  if(retainedManifest){const saved=await savedNotationMaterials(directory);if(!pinned||saved.hash!==notation.hash)fail('retained notation acoustic evidence changed');}
  if(retainedPlan&&canonicalHash(retainedPlan)!==canonicalHash(plan))fail('retained notation plan changed');
  const actualSha=sha(await fs.readFile(join(entry.root,'audio',item.customId+'.wav'))),promotion=await read(join(directory,'promotion.json'),null);
  const verifyFinal=async next=>{
   const prior=await read(join(directory,'plan.json'));
   const saved=await savedNotationMaterials(directory),recovery=next.renderingRecovery;
   if(!pinned||saved.hash!==notation.hash||canonicalHash(prior)!==canonicalHash(plan)||!recovery||recovery.schemaVersion!==1||recovery.rendererVersion!==notationPolicy
    ||!Number.isFinite(next.duration)||next.duration<=0||canonicalHash(next)!==canonicalHash({...receipt,sha256:next.sha256,duration:next.duration,renderingRecovery:recovery})||recovery.planHash!==canonicalHash(plan)
    ||recovery.audioSha256!==next.sha256||next.voiceId!==receipt.voiceId||next.requestHash!==receipt.requestHash
    ||sha(await fs.readFile(join(directory,'original.wav')))!==receipt.sha256||recovery.previousSha256!==receipt.sha256
    ||canonicalHash(await read(join(directory,'attempt2-plan.json')))!==canonicalHash(attempt2Plan)
    ||recovery.planPath!==join('rendering-recoveries',notationPolicy,item.customId,'plan.json')
    ||recovery.inputHash!==entry.inputHash||recovery.sourceHash!==chapter.source||recovery.originalItemHash!==hash(item)
    ||canonicalHash(recovery.renderingProof)!==canonicalHash(plan.renderingProof)
    ||canonicalHash(next.repair)!==canonicalHash(receipt.repair))fail('completed notation manifest or retained/current audio changed');
   const final=await finalParts(entry,plan,voices,read);
   if(canonicalHash(final.parts)!==canonicalHash(recovery.parts)||Math.abs(final.duration-next.duration)>.1)fail('completed notation child evidence changed');
  };
  if(current.renderingRecovery){
   if(actualSha!==current.sha256)fail('completed parent audio changed');await verifyFinal(current);
  }else if(promotion){
   if(promotion.state!=='prepared'||promotion.passage!==item.customId||promotion.previousSha256!==receipt.sha256
    ||![receipt.sha256,promotion.receipt?.sha256].includes(actualSha)
    ||sha(await fs.readFile(join(directory,'replacement.wav')))!==promotion.receipt?.sha256)fail('prepared notation promotion changed');
   await verifyFinal(promotion.receipt);
  }else if(actualSha!==receipt.sha256)fail('pending parent audio differs from receipt');
  result.push({item,...renderer,plan});
 }
 return result;
}

/** Explicitly invoked once, under the existing worker lock and paid lane. */
export async function recoverVisualRedactionPassage({entry,chapter,item,config,read,save,run,synthesize,voices,status,render,verify,policy:rendererPolicy=recoveryPolicy,notation}){
 renderingPolicy(rendererPolicy);
 const processing=await read(join(entry.root,'processing.json'),{});
 if(processing.status!=='needs-review'||!processing.passages?.includes(item.customId))fail('passage must already be held for fidelity review');
 if(await read(join(entry.root,'assembly.json'),null)||await read(join(entry.root,'published.json'),null))fail('assembled or published audio is immutable');
 if(config.maxRetakes!==2)fail('migration requires the original two-retake bound');
 const relative=join('rendering-recoveries',rendererPolicy,item.customId),directory=join(entry.root,relative),planPath=join(directory,'plan.json');
 if(rendererPolicy===notationPolicy)await chapterNotationManifest(entry.root,notation,read);
 await fs.mkdir(directory,{recursive:true});
 if(rendererPolicy===notationPolicy){await replayNotationInput(chapter,notation,config);await saveNotationMaterials(directory,notation,read,save);}
 const current=await read(join(entry.root,'receipts',item.customId+'.json'));
 if(current.renderingRecovery){
  const saved=await read(planPath);if(current.renderingRecovery.planHash!==canonicalHash(saved)||current.renderingRecovery.audioSha256!==current.sha256||sha(await fs.readFile(join(entry.root,'audio',item.customId+'.wav')))!==current.sha256)fail('completed recovery evidence changed');
  return false; // One migration allowance; an unsuccessful new review cannot buy another.
 }
 const receipt=await read(join(directory,'original-receipt.json'),current),source=await read(join(entry.root,'source.json'));
 const attempt2Plan=await read(join(entry.root,'repairs',item.customId,'attempt-2','plan.json'));
 const parts=await inspectParts(entry,attempt2Plan,voices,read),plan=buildRenderingRecoveryPlan({entry,chapter,item,source,receipt,attempt2Plan,parts,render,verify,policy:rendererPolicy,notation});
 if(current.requestHash!==receipt.requestHash||canonicalHash(current)!==canonicalHash(receipt))fail('parent receipt changed since migration began');
 if(!voices[item.role]?.voiceId||receipt.voiceId!==voices[item.role].voiceId||receipt.requestHash!==hash({...item.request,voiceId:voices[item.role].voiceId}))fail('parent voice or request changed');
 await once(planPath,plan,read,save);await once(join(directory,'original-receipt.json'),receipt,read,save);await once(join(directory,'attempt2-plan.json'),attempt2Plan,read,save);
 await once(join(directory,'original-review.json'),await read(join(entry.root,'review',item.customId+'.json')),read,save);
 const pending=await read(join(directory,'promotion.json'),null);
 if(pending&&pending.state!=='prepared')fail('unexpected promotion state before completed receipt');
 if(pending?.state==='prepared'){
  if(pending.receipt.renderingRecovery?.planHash!==canonicalHash(plan)||pending.previousSha256!==receipt.sha256)fail('prepared promotion differs from approved rendering plan');
  const verified=await finalParts(entry,plan,voices,read);if(canonicalHash(verified.parts)!==canonicalHash(pending.receipt.renderingRecovery.parts))fail('prepared child evidence changed');
  await installPromotion(entry,directory,pending,save);return true;
 }
 if(sha(await fs.readFile(join(entry.root,'audio',item.customId+'.wav')))!==receipt.sha256)fail('parent audio changed before recovery');
 await originalAudio(join(entry.root,'audio',item.customId+'.wav'),join(directory,'original.wav'),receipt.sha256);
 await status({stage:rendererPolicy===notationPolicy?'recovering-source-notation':rendererPolicy===recoveryPolicy?'recovering-visual-redaction':'recovering-combining-overlays',passage:item.customId,reused:plan.parts.filter(part=>part.reused).length,replaced:plan.parts.filter(part=>!part.reused).length});
 await synthesize({...entry,root:join(directory,'generated')},{items:plan.parts.filter(part=>!part.reused).map(part=>part.replacement)},voices,{maxSubmissionsPerItem:1});
 const final=await finalParts(entry,plan,voices,read);
 if(final.files.some(path=>path.includes("'")))fail('unsupported quote in media path');
 const list=join(directory,'concat.txt');await fs.writeFile(list,final.files.map(path=>`file '${path}'`).join('\n'));
 const replacement=join(directory,'replacement.wav');await run('ffmpeg',['-v','error','-y','-f','concat','-safe','0','-i',list,'-ar','48000','-ac','1','-c:a','pcm_s16le',replacement]);
 const duration=Number((await run('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',replacement])).trim());
 if(!Number.isFinite(duration)||Math.abs(duration-final.duration)>.1)fail('replacement duration differs from verified child clips');
 const digest=sha(await fs.readFile(replacement));
 const next={...receipt,sha256:digest,duration,renderingRecovery:{schemaVersion:1,rendererVersion:rendererPolicy,planPath:join(relative,'plan.json'),planHash:canonicalHash(plan),inputHash:entry.inputHash,sourceHash:chapter.source,originalItemHash:hash(item),previousSha256:receipt.sha256,renderingProof:plan.renderingProof,parts:final.parts,audioSha256:digest}};
 const promotion={state:'prepared',passage:item.customId,previousSha256:receipt.sha256,receipt:next};await save(join(directory,'promotion.json'),promotion);
 await installPromotion(entry,directory,promotion,save);return true;
}
