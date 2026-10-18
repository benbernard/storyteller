/** Reviewed, immutable source-notation manifests; no provider calls. */
import fs from 'node:fs/promises';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {hash,sha,validateCoverage} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {sourceNotationPolicy,renderSourceNotation,verifySourceNotation,numericComparatorOffsets,literalCompoundUnit} from '../audiobooks/dist/spoken-notation.js';
import {buildChapter,renderPlanSpoken} from './prepare.mjs';
import {pcmASRModels} from './pcm-symbol-evidence.mjs';

export const notationPolicy=sourceNotationPolicy;
const here=dirname(fileURLToPath(import.meta.url)),fail=()=>{throw Error('Source notation manifest or immutable acoustic evidence changed');};
const safeId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]+$/.test(value);
const digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const modules=['tools/inworld-batch/prepare.mjs','tools/inworld-batch/normalize.py','tools/mac-tts/acting-auditions/speech_parts.py'];
const kinds=['comparison','celsius','literal-unit'];
const selected=manifest=>manifest.passages.flatMap(passage=>passage.selectedChildren??[]);
function structure(manifest){
 if(manifest?.schemaVersion!==1||manifest.policy!==notationPolicy||!safeId(manifest.chapterId)||!digest(manifest.inputHash)
  ||!Array.isArray(manifest.passages)||!manifest.passages.length||manifest.passages.length>3||manifest.maximumSelectedChildren!==3
  ||selected(manifest).length<1||selected(manifest).length>3||new Set(selected(manifest)).size!==selected(manifest).length
  ||manifest.passages.some(p=>!safeId(p.passage)||!Array.isArray(p.selectedChildren)||!p.selectedChildren.length||p.selectedChildren.some(id=>!safeId(id)))
  ||new Set(manifest.passages.map(p=>p.passage)).size!==manifest.passages.length||!Array.isArray(manifest.evidence))fail();
 return manifest;
}
export async function loadNotationMaterials(path,expectedHash){
 const manifest=structure(JSON.parse(await fs.readFile(path,'utf8')));
 if(!digest(expectedHash)||fingerprint(manifest)!==expectedHash)fail();
 const evidence={};
 for(const row of manifest.evidence){
  if(!safeId(row.child)||!['small','strong','phones'].includes(row.kind)||!digest(row.sha256)
   ||row.path!==`inference/${row.child}/${row.kind==='phones'?'phoneme-frames':'asr-'+row.kind}.json`)fail();
  const file=resolve(dirname(path),row.path);if(!file.startsWith(resolve(dirname(path))+sep))fail();
  const bytes=await fs.readFile(file);if(sha(bytes)!==row.sha256||evidence[row.sha256])fail();
  evidence[row.sha256]={bytes,value:JSON.parse(bytes.toString('utf8'))};
 }
 return {manifest,hash:expectedHash,evidence};
}
export async function saveNotationMaterials(directory,materials,read,save){
 const {manifest,evidence}=materials,prior=await read(join(directory,'manifest.json'),null);
 if(prior&&fingerprint(prior)!==materials.hash)fail();
 if(!prior)await save(join(directory,'manifest.json'),manifest);
 await fs.mkdir(join(directory,'evidence'),{recursive:true});
 for(const [digest,raw]of Object.entries(evidence)){
  const path=join(directory,'evidence',digest+'.json');
  try{await fs.writeFile(path,raw.bytes,{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
  if(sha(await fs.readFile(path))!==digest)fail();
 }
}
export async function savedNotationMaterials(directory){
 const manifest=structure(JSON.parse(await fs.readFile(join(directory,'manifest.json'),'utf8'))),evidence={};
 for(const row of manifest.evidence){
  if(!digest(row.sha256)||evidence[row.sha256])fail();
  const bytes=await fs.readFile(join(directory,'evidence',row.sha256+'.json'));if(sha(bytes)!==row.sha256)fail();
  evidence[row.sha256]={bytes,value:JSON.parse(bytes.toString('utf8'))};
 }
 return {manifest,hash:fingerprint(manifest),evidence};
}
export async function chapterNotationManifest(root,materials,read,save){
 const path=join(root,'rendering-recoveries',notationPolicy,'manifest.json'),prior=await read(path,null);
 if(prior&&fingerprint(prior)!==materials.hash)fail();
 if(!prior){if(!save)fail();await save(path,materials.manifest);}
 return true;
}
/** Rebuild original plan -> pinned renderer -> normalization -> casting/chunks. */
export async function replayNotationInput(chapter,materials,settings){
 const manifest=structure(materials.manifest);
 if(fingerprint(manifest)!==materials.hash||manifest.chapterId!==chapter.chapterId||manifest.inputHash!==hash(chapter)
  ||hash(manifest.preparedPlan)!==chapter.provenance?.planHash)fail();
 const expected={acronyms:settings.acronyms??[],pronunciations:settings.pronunciations??{},narratorPolicy:settings.narratorPolicy};
 if(fingerprint(expected)!==fingerprint(manifest.preparationSettings))fail();
 for(const path of modules)if(manifest.normalizationModules?.[path]!==sha(await fs.readFile(join(here,'../..',path))))fail();
 const policy=chapter.provenance?.spokenRendering?.policy,view=policy?await renderPlanSpoken(manifest.preparedPlan,true,policy):{texts:manifest.preparedPlan.segments.map(s=>s.text)};
 const normalized=spawnSync('python3',[join(here,'normalize.py')],{input:JSON.stringify(view.texts),encoding:'utf8',maxBuffer:8e6});
 if(normalized.status!==0)fail();
 const rebuilt=buildChapter(manifest.preparedPlan,JSON.parse(normalized.stdout),expected,view.provenance);
 if(hash(rebuilt)!==hash(chapter))fail();
 return true;
}
export function notationPassage(materials,item){
 structure(materials?.manifest);if(fingerprint(materials.manifest)!==materials.hash)fail();
 const passage=materials.manifest.passages.find(p=>p.passage===item.customId);
 if(!passage||passage.originalItemHash!==hash(item)||!Array.isArray(passage.sourceRanges))fail();
 return passage;
}
/** Parent/child text hashes identify exact reviewed unit offsets, never prose. */
export function notationRenderer(item,attempt2Plan,passage){
 const known=new Map(),units=passage.sourceRanges.filter(range=>range.kind==='literal-unit');
 const add=(text,offsets)=>{const key=sha(text),prior=known.get(key);if(prior&&hash(prior)!==hash(offsets))fail();known.set(key,offsets);};
 add(item.spokenText,units.map(range=>range.itemStart));let cursor=0;
 for(const child of attempt2Plan.items){
  const start=item.spokenText.indexOf(child.spokenText,cursor);if(start<cursor||item.spokenText.slice(cursor,start).trim())fail();
  const end=start+child.spokenText.length,offsets=[];
  for(const unit of units){if(unit.itemStart<end&&unit.itemEnd>start){if(unit.itemStart<start||unit.itemEnd>end)fail();offsets.push(unit.itemStart-start);}}
  add(child.spokenText,offsets);cursor=end;
 }
 if(item.spokenText.slice(cursor).trim())fail();
 const offsets=text=>{const value=known.get(sha(text));if(!value)fail();return value;};
 return {render:text=>renderSourceNotation(text,offsets(text)),verify:(text,value)=>verifySourceNotation(text,offsets(text),value)};
}
export function notationSourceRanges(chapter,item,source,passage,proof){
 validateCoverage(chapter.segments,source.text);
 const segment=chapter.segments.find(s=>s.items.includes(item.customId));if(!segment||segment.presentation)fail();
 const raw=segment.spans.map(span=>source.text.slice(span.start,span.end)).join('');if(raw!==segment.text)fail();
 numericComparatorOffsets(raw); // Check EVERY transformed comparator, including reused children.
 const absolute=offset=>{let n=0;for(const span of segment.spans){if(offset<n+span.end-span.start)return span.start+offset-n;n+=span.end-span.start;}fail();};
 const canonical=[...raw.matchAll(/<|°C\b/gu)],queued=segment.items.flatMap(id=>{
  const part=chapter.items.find(v=>v.customId===id);if(!part)fail();return [...part.spokenText.matchAll(/<|°C\b/gu)].map(m=>({id,index:m.index,text:m[0]}));
 });
 if(canonical.length!==queued.length||canonical.some((match,index)=>match[0]!==queued[index].text))fail();
 const ranges=[];
 for(const [index,match]of canonical.entries()){
  if(match[0]==='°C'&&!/[-−]?\d+(?:\.\d+)?[ \t]*$/u.test(raw.slice(0,match.index)))fail();
  if(queued[index].id!==item.customId)continue;
  ranges.push({kind:match[0]==='<'?'comparison':'celsius',itemStart:queued[index].index,itemEnd:queued[index].index+match[0].length,sourceStart:absolute(match.index),sourceEnd:absolute(match.index+match[0].length-1)+1});
 }
 const units=passage.sourceRanges.filter(r=>r.kind==='literal-unit');if(units.length>1)fail();
 for(const range of units){
  if(![range.sourceStart,range.sourceEnd,range.itemStart,range.itemEnd].every(Number.isSafeInteger)||range.sourceEnd-range.sourceStart!==8||range.itemEnd-range.itemStart!==8)fail();
  const literal=source.text.slice(range.sourceStart,range.sourceEnd);
  literalCompoundUnit(literal);
  if(item.spokenText.slice(range.itemStart,range.itemEnd)!==literal||/[\p{L}\p{N}\p{M}_]$/u.test(source.text.slice(0,range.sourceStart))||/^[\p{L}\p{N}\p{M}_]/u.test(source.text.slice(range.sourceEnd)))fail();
  const field=passage.unitField;
  if(!field||![field.start,field.end,field.quantityStart,field.quantityEnd].every(Number.isSafeInteger)
   ||field.start<0||field.end>source.text.length||field.start>field.quantityStart||field.quantityStart>=field.quantityEnd
   ||field.quantityEnd>range.sourceStart||field.end<range.sourceEnd||field.textHash!==sha(source.text.slice(field.start,field.end))
   ||field.quantityHash!==sha(source.text.slice(field.quantityStart,field.quantityEnd))
   ||!/^[-−]?\d+(?:\.\d+)?$/u.test(source.text.slice(field.quantityStart,field.quantityEnd))
   ||!/^[ \t]*$/u.test(source.text.slice(field.quantityEnd,range.sourceStart))||/[\r\n]/u.test(source.text.slice(field.start,field.end)))fail();
  // Canonical token must belong to this passage's exact source spans.
  if(!segment.spans.some(span=>range.sourceStart>=span.start&&range.sourceEnd<=span.end))fail();
  ranges.push({...range});
 }
 ranges.sort((a,b)=>a.itemStart-b.itemStart);
 if(fingerprint(ranges)!==fingerprint(passage.sourceRanges)||fingerprint(ranges.map(r=>({kind:r.kind,start:r.itemStart,end:r.itemEnd})))!==fingerprint(proof.mapping.filter(r=>r.kind!=='copy').map(r=>({kind:r.kind,start:r.sourceStart,end:r.sourceEnd}))))fail();
 return ranges;
}
export function validateNotationPassage({chapter,item,source,receipt,attempt2Plan,parts,materials,render}){
 const manifest=structure(materials.manifest),passage=notationPassage(materials,item);
 if(manifest.chapterId!==chapter.chapterId||manifest.inputHash!==hash(chapter)||manifest.sourceObjectHash!==fingerprint(source)
  ||manifest.canonicalTextSha256!==sha(source.text)||passage.originalReceiptHash!==fingerprint(receipt)||passage.originalAudioSha256!==receipt.sha256
  ||passage.attempt2PlanHash!==hash(attempt2Plan)||receipt.renderingRecovery||receipt.offlinePCMExcision)fail();
 const required=[];
 for(const part of parts){
  const relevant=render(part.item.spokenText).mapping.filter(range=>range.kind!=='copy');
  const isSelected=passage.selectedChildren.includes(part.item.customId);
  if(isSelected&&!relevant.length)fail();
  if(!relevant.length)continue;
  required.push(part.item.customId);
  const diagnostic=passage.diagnostics?.find(row=>row.child===part.item.customId);
  if(!diagnostic||diagnostic.kind!==(isSelected?({'comparison':'missing-comparator','celsius':'misread-celsius','literal-unit':'truncated-literal-unit'}[relevant[0].kind]):'verified-reuse')
   ||new Set(relevant.map(range=>range.kind)).size!==1||diagnostic.itemHash!==hash(part.item)||diagnostic.receiptHash!==fingerprint(part.receipt)||diagnostic.audioSha256!==part.audioSha256)fail();
  const rows=manifest.evidence.filter(row=>row.child===part.item.customId);if(rows.length!==3||new Set(rows.map(row=>row.kind)).size!==3)fail();
  for(const kind of ['small','strong','phones']){
   const row=rows.find(r=>r.kind===kind),raw=materials.evidence[row?.sha256];
   if(!row||!raw||sha(raw.bytes)!==row.sha256||fingerprint(raw.value)!==fingerprint(JSON.parse(raw.bytes.toString('utf8'))))fail();
   const value=raw.value;if(value.audioSha256!==part.audioSha256||value.inputPrompt!==null||value.providerDisabled!==true||!(value.decodedFrames>0)||value.sampleRate!==48000)fail();
   if(kind==='phones'){
    if(value.model!=='facebook/wav2vec2-lv-60-espeak-cv-ft'||value.revision!=='ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4'||value.doPhonemize!==false||value.localModelChecksumsVerified!==true||typeof value.phonemes!=='string'||!value.phonemes.trim()||!Array.isArray(value.frames)||!value.frames.length)fail();
   }else if(value.model!==pcmASRModels[kind]||value.temperature!==0||value.fp16!==false||value.condition_on_previous_text!==false||value.word_timestamps!==true||typeof value.result?.text!=='string'||!value.result.text.trim())fail();
  }
  if(diagnostic.oldAmbiguity&&(diagnostic.kind!=='misread-celsius'||diagnostic.oldAmbiguity.kind!=='unresolved-old-tail-insertion'||!/^[a-f0-9]{64}$/.test(diagnostic.oldAmbiguity.tokenSha256??'')))fail();
  const raw=kind=>materials.evidence[rows.find(row=>row.kind===kind).sha256].value;
  const proof=spawnSync('python3',[join(here,'notation_evidence.py')],{input:JSON.stringify({source:part.item.spokenText,kind:diagnostic.kind,small:raw('small').result.text,strong:raw('strong').result.text,phonemes:raw('phones').phonemes,unitOffset:relevant.find(range=>range.kind==='literal-unit')?.sourceStart,oldTailTokenSha256:diagnostic.oldAmbiguity?.tokenSha256}),encoding:'utf8',maxBuffer:1e6});
  if(proof.status!==0||JSON.parse(proof.stdout).valid!==true)fail();
 }
 if(passage.selectedChildren.some(id=>!required.includes(id))||passage.diagnostics?.length!==required.length)fail();
 return passage;
}
