import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {hash,sha,assertBudget} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {buildChapter} from './prepare.mjs';
import {notationPolicy,notationRenderer,chapterNotationManifest} from './notation-recovery.mjs';
import {preflightNotationRecovery,recoverVisualRedactionPassage,canonicalHash} from './rendering-recovery.mjs';
import {renderingContext} from './rendering-review.mjs';
import {pcmASRModels} from './pcm-symbol-evidence.mjs';
import {reviewInstructions} from './adjudication.mjs';

const read=async(path,fallback)=>{try{return JSON.parse(await fs.readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT'&&fallback!==undefined)return fallback;throw error;}};
const save=async(path,value)=>{await fs.mkdir(dirname(path),{recursive:true});await fs.writeFile(path,JSON.stringify(value,null,2)+'\n');};
async function fixture(){
 const root=await fs.mkdtemp(join(tmpdir(),'notation-recovery-')),folder=join(root,'chapters/999');
 const a=['😀 The opening statement preserves all ordinary words in this synthetic record.',
  'The measured average is 9 abcd/sec and the reference statement remains unchanged.',
  'The first measurement is 13.25°C and the second measurement is 17.5°C while all source words remain exact.',
  'The closing sentence retains its successful recording without another submission.'].join('\n');
 const b=['The first recorded limit is <12h and every ordinary word stays intact.',
  'The second recorded limit is <18h and this correct recording should be retained.',
  'The third recorded limit is <24h and the rest of this sentence remains unchanged.'].join('\n');
 const source={text:a+'\n'+b},preparedPlan={chapterId:'rr-fixture',sequence:999,title:'Synthetic fixture',source:sha(source.text),analysis:'analysis-fixture',
  segments:[{uid:'first',role:'narrator',text:a+'\n',spans:[{uid:'first',start:0,end:a.length+1}]},{uid:'second',role:'narrator',text:b,spans:[{uid:'second',start:a.length+1,end:source.text.length}]}],
  directions:[{uid:'first',instruction:'Read clearly and steadily.'},{uid:'second',instruction:'Read clearly and steadily.'}]};
 const config={root,maxRetakes:2,ceilingUSD:50,acronyms:[],pronunciations:{},narratorPolicy:{gender:'female'}},voices={narrator:{voiceId:'saved-female'}};
 const normalized=spawnSync('python3',[resolve('tools/inworld-batch/normalize.py')],{input:JSON.stringify(preparedPlan.segments.map(s=>s.text)),encoding:'utf8'});assert.equal(normalized.status,0);
 const chapter=buildChapter(preparedPlan,JSON.parse(normalized.stdout),config),entry={chapterId:chapter.chapterId,sequence:999,root:folder,inputHash:hash(chapter)};
 const manifest={schemaVersion:1,policy:notationPolicy,chapterId:chapter.chapterId,inputHash:entry.inputHash,sourceObjectHash:fingerprint(source),canonicalTextSha256:sha(source.text),maximumSelectedChildren:3,preparedPlan,
  preparationSettings:{acronyms:[],pronunciations:{},narratorPolicy:config.narratorPolicy},normalizationModules:{},passages:[],evidence:[]},evidence={};
 for(const path of ['tools/inworld-batch/prepare.mjs','tools/inworld-batch/normalize.py','tools/mac-tts/acting-auditions/speech_parts.py'])manifest.normalizationModules[path]=sha(await fs.readFile(resolve(path)));
 const originals=new Map();
 for(const [n,item]of chapter.items.entries()){
  const chunks=item.spokenText.split('\n').filter(Boolean),items=chunks.map((text,i)=>({...item,customId:item.customId+'r2p'+i,spokenText:text,request:{...item.request,text:'[read every word clearly] '+text}}));
  const plan={passage:item.customId,attempt:2,items},parts=[];let parent=Buffer.alloc(0);
  for(const child of items){const bytes=Buffer.from('original-'+child.customId),receipt={voiceId:voices.narrator.voiceId,requestHash:hash({...child.request,voiceId:voices.narrator.voiceId}),sha256:sha(bytes),duration:1,job:'original-'+child.customId};
   await save(join(folder,'repairs',item.customId,'attempt-2/receipts',child.customId+'.json'),receipt);const path=join(folder,'repairs',item.customId,'attempt-2/audio',child.customId+'.wav');await fs.mkdir(dirname(path),{recursive:true});await fs.writeFile(path,bytes);parts.push({item:child,receipt,audioSha256:sha(bytes)});parent=Buffer.concat([parent,bytes]);}
  const receipt={voiceId:voices.narrator.voiceId,requestHash:hash({...item.request,voiceId:voices.narrator.voiceId}),sha256:sha(parent),duration:parts.length,job:'original-parent',repair:{attempt:2,planHash:hash(plan),parts:parts.map(p=>({id:p.item.customId,sha256:p.receipt.sha256,job:p.receipt.job})),previousSha256:'prior-attempt1'}};
  await save(join(folder,'repairs',item.customId,'attempt-2/plan.json'),plan);await save(join(folder,'receipts',item.customId+'.json'),receipt);await save(join(folder,'review',item.customId+'.json'),{sha256:receipt.sha256,expected:item.spokenText,severity:'major'});await fs.mkdir(join(folder,'audio'),{recursive:true});await fs.writeFile(join(folder,'audio',item.customId+'.wav'),parent);
  const start=preparedPlan.segments[n].spans[0].start,ranges=[...item.spokenText.matchAll(/<|°C\b/gu)].map(m=>({kind:m[0]==='<'?'comparison':'celsius',itemStart:m.index,itemEnd:m.index+m[0].length,sourceStart:start+m.index,sourceEnd:start+m.index+m[0].length}));
  const selectedChildren=n===0?[items[1].customId,items[2].customId]:[items[0].customId],passage={passage:item.customId,originalItemHash:hash(item),originalReceiptHash:fingerprint(receipt),originalAudioSha256:receipt.sha256,attempt2PlanHash:hash(plan),selectedChildren,sourceRanges:ranges,diagnostics:[]};
  if(n===0){const at=item.spokenText.indexOf('abcd/sec'),lineStart=item.spokenText.lastIndexOf('\n',at)+1,lineEnd=item.spokenText.indexOf('\n',at),quantity=at-2;passage.sourceRanges.push({kind:'literal-unit',itemStart:at,itemEnd:at+8,sourceStart:at,sourceEnd:at+8});passage.sourceRanges.sort((x,y)=>x.itemStart-y.itemStart);passage.unitField={start:lineStart,end:lineEnd,textHash:sha(source.text.slice(lineStart,lineEnd)),quantityStart:quantity,quantityEnd:quantity+1,quantityHash:sha('9')};}
  const renderer=notationRenderer(item,plan,passage);
  for(const part of parts){const child=part.item,proof=renderer.render(child.spokenText),kinds=proof.mapping.filter(r=>r.kind!=='copy').map(r=>r.kind);if(!kinds.length)continue;const selected=selectedChildren.includes(child.customId),kind=selected?({'comparison':'missing-comparator','celsius':'misread-celsius','literal-unit':'truncated-literal-unit'}[kinds[0]]):'verified-reuse';
   passage.diagnostics.push({child:child.customId,kind,itemHash:hash(child),receiptHash:fingerprint(part.receipt),audioSha256:part.audioSha256});
   let transcript=child.spokenText,phones='ordinaryphones';
   if(kind==='missing-comparator')transcript=transcript.replace('<','');
   if(kind==='verified-reuse'){transcript=transcript.replaceAll('<','less than ');phones='lɛsðən';}
   if(kind==='misread-celsius'){transcript=transcript.replaceAll('°C',' CGC');phones='sidʒisisidʒisi';}
   if(kind==='truncated-literal-unit'){transcript=transcript.replace('abcd/sec','AB per second');phones='eɪbi';}
   for(const mode of ['small','strong','phones']){const value={audioSha256:part.audioSha256,sampleRate:48000,decodedFrames:48000,inputPrompt:null,providerDisabled:true,...(mode==='phones'?{model:'facebook/wav2vec2-lv-60-espeak-cv-ft',revision:'ae45363bf3413b374fecd9dc8bc1df0e24c3b7f4',doPhonemize:false,localModelChecksumsVerified:true,phonemes:phones,frames:[{token:'x'}]}:{model:pcmASRModels[mode],temperature:0,fp16:false,condition_on_previous_text:false,word_timestamps:true,result:{text:transcript}})},bytes=Buffer.from(JSON.stringify(value)),digest=sha(bytes);manifest.evidence.push({child:child.customId,kind:mode,path:`inference/${child.customId}/${mode==='phones'?'phoneme-frames':'asr-'+mode}.json`,sha256:digest});evidence[digest]={bytes,value};}
  }
  manifest.passages.push(passage);originals.set(item.customId,{item,receipt,plan,parts});
 }
 await save(join(folder,'input.json'),chapter);await save(join(folder,'source.json'),source);await save(join(folder,'processing.json'),{status:'needs-review',passages:chapter.items.map(i=>i.customId)});await save(join(root,'jobs.json'),[]);
 const notation={manifest,hash:fingerprint(manifest),evidence};let paid=0,uncertain=false;
 const synthesize=async(e,c,v,options)=>{assert.equal(options.maxSubmissionsPerItem,1);for(const child of c.items){const jobs=await read(join(root,'jobs.json')),prior=jobs.find(j=>j.items[0].customId===child.customId);if(prior?.phase==='submitting')throw Error('Uncertain submission retained');if(prior)continue;assertBudget(jobs,child.request.text.length,config.ceilingUSD);const job={phase:uncertain?'submitting':'complete',items:[child],reservedUSD:child.request.text.length*.00002};jobs.push(job);await save(join(root,'jobs.json'),jobs);paid++;if(uncertain)throw Error('Uncertain submission retained');const bytes=Buffer.from('new-'+child.customId);await fs.mkdir(join(e.root,'audio'),{recursive:true});await fs.writeFile(join(e.root,'audio',child.customId+'.wav'),bytes);await save(join(e.root,'receipts',child.customId+'.json'),{voiceId:v.narrator.voiceId,requestHash:hash({...child.request,voiceId:v.narrator.voiceId}),sha256:sha(bytes),duration:1,job:'new-'+child.customId});}};
 const run=async(command,args)=>{if(command==='ffprobe'){const path=args.at(-1);return String((await read(join(dirname(path),'plan.json'))).parts.length);}const rows=(await fs.readFile(args[args.indexOf('-i')+1],'utf8')).split('\n'),buffers=[];for(const row of rows)buffers.push(await fs.readFile(row.slice(6,-1)));await fs.writeFile(args.at(-1),Buffer.concat(buffers));return '';};
 const args={entry,chapter,config,read,voices,notation},preflight=()=>preflightNotationRecovery(args),pin=()=>chapterNotationManifest(folder,notation,read,save);
 const recover=(target,saveFn=save)=>recoverVisualRedactionPassage({...args,item:target.item,render:target.render,verify:target.verify,policy:notationPolicy,save:saveFn,run,synthesize,status:async()=>{}});
 return {root,folder,entry,chapter,config,notation,originals,preflight,pin,recover,paid:()=>paid,setUncertain:value=>{uncertain=value;}};
}

test('three reviewed notation children share one durable allowance and retain all other source/audio/counters',async()=>{
 const f=await fixture();try{const before=await fs.readFile(join(f.folder,'input.json')),plans=await f.preflight();assert.equal(plans.flatMap(p=>p.plan.parts.filter(c=>!c.reused)).length,3);await f.pin();for(const target of plans)await f.recover(target);assert.equal(f.paid(),3);assert.deepEqual(await fs.readFile(join(f.folder,'input.json')),before);
 for(const target of plans){const receipt=await read(join(f.folder,'receipts',target.item.customId+'.json'));assert.deepEqual(receipt.repair,f.originals.get(target.item.customId).receipt.repair);const context=await renderingContext(f.folder,target.item);assert.equal(context.renderingProof.policy,notationPolicy);assert.equal(context.audioSha256,receipt.sha256);}
 for(const target of await f.preflight())await f.recover(target);assert.equal(f.paid(),3);
 const changed=structuredClone(f.notation.manifest);changed.passages.pop();const priorHash=f.notation.hash;f.notation.manifest=changed;f.notation.hash=fingerprint(changed);await assert.rejects(f.preflight);assert.equal(f.paid(),3);f.notation.hash=priorHash;
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('all-target preflight rejects immutable provenance/selection/context/voice/cap corruption before any submission',async()=>{
 const mutations=[f=>{f.entry.inputHash='bad';},f=>{f.config.maxRetakes=3;},f=>{f.notation.manifest.inputHash='0'.repeat(64);},f=>{f.notation.manifest.sourceObjectHash='0'.repeat(64);},f=>{f.notation.manifest.preparedPlan.title='changed';},f=>{f.notation.manifest.normalizationModules['tools/inworld-batch/normalize.py']='0'.repeat(64);},f=>{f.notation.manifest.passages[0].sourceRanges[0].itemStart++;},f=>{f.notation.manifest.passages[0].unitField.quantityHash='0'.repeat(64);},f=>{f.notation.manifest.passages[0].selectedChildren.push('ordinary-child');},f=>{f.notation.manifest.passages[0].originalReceiptHash='0'.repeat(64);},f=>{f.notation.evidence[Object.keys(f.notation.evidence)[0]].bytes=Buffer.from('tampered');}];
 for(const mutate of mutations){const f=await fixture();try{mutate(f);f.notation.hash=fingerprint(f.notation.manifest);await assert.rejects(f.preflight);assert.equal(f.paid(),0);assert.deepEqual(await read(join(f.root,'jobs.json')),[]);}finally{await fs.rm(f.root,{recursive:true,force:true});}}
 const f=await fixture();try{const child=f.originals.values().next().value.parts[0].item;await fs.writeFile(join(f.folder,'repairs',f.chapter.items[0].customId,'attempt-2/audio',child.customId+'.wav'),'changed retained audio');await assert.rejects(f.preflight);assert.equal(f.paid(),0);}finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('completed later-target audio and saved acoustic corruption block an earlier pending target before new payment',async()=>{
 for(const what of ['audio','evidence','duration','schema','policy','receipt-field']){const f=await fixture();try{const plans=await f.preflight();await f.pin();await f.recover(plans[1]);const count=f.paid();if(what==='audio')await fs.writeFile(join(f.folder,'audio',plans[1].item.customId+'.wav'),'corrupt');else if(what==='evidence'){const digest=f.notation.manifest.evidence[0].sha256;await fs.writeFile(join(f.folder,'rendering-recoveries',notationPolicy,plans[1].item.customId,'evidence',digest+'.json'),'corrupt');}else{const path=join(f.folder,'receipts',plans[1].item.customId+'.json'),value=await read(path);if(what==='duration')delete value.duration;else if(what==='schema')value.renderingRecovery.schemaVersion=9;else if(what==='policy')value.renderingRecovery.rendererVersion='other';else value.unreviewed='changed';await save(path,value);}await assert.rejects(f.preflight);assert.equal(f.paid(),count);}finally{await fs.rm(f.root,{recursive:true,force:true});}}
});

test('source notation resumes the exact prepared audio/receipt promotion without new paid submissions',async()=>{
 const f=await fixture();try{const plans=await f.preflight();await f.pin();let failed=false;const crash=async(path,value)=>{if(!failed&&path===join(f.folder,'receipts',plans[0].item.customId+'.json')&&value.renderingRecovery){failed=true;throw Error('crash after audio');}await save(path,value);};await assert.rejects(()=>f.recover(plans[0],crash),/crash after audio/);const count=f.paid();const resumed=await f.preflight();await f.recover(resumed[0]);assert.equal(f.paid(),count);assert.equal((await read(join(f.folder,'receipts',plans[0].item.customId+'.json'))).repair.attempt,2);}finally{await fs.rm(f.root,{recursive:true,force:true});}
});

test('uncertain submission and the existing shared ceiling prevent duplicate or fourth migration work',async()=>{
 const f=await fixture();try{const plans=await f.preflight();await f.pin();await f.recover(plans[0]);f.setUncertain(true);await assert.rejects(()=>f.recover(plans[1]),/Uncertain/);const before=await fs.readFile(join(f.root,'jobs.json')),count=f.paid();await assert.rejects(()=>f.recover(plans[1]),/Uncertain/);assert.equal(f.paid(),count);assert.deepEqual(await fs.readFile(join(f.root,'jobs.json')),before);}finally{await fs.rm(f.root,{recursive:true,force:true});}
 const g=await fixture();try{const plans=await g.preflight();await g.pin();await save(join(g.root,'jobs.json'),[{phase:'submitting',items:[{customId:'held-elsewhere'}],reservedUSD:50}]);await assert.rejects(()=>g.recover(plans[0]),/budget|ceiling/i);assert.equal(g.paid(),0);}finally{await fs.rm(g.root,{recursive:true,force:true});}
});

test('subscription instructions bind finite source notation without granting a normalization waiver',()=>{
 assert.match(reviewInstructions,/source-numeric-notation-v1/);assert.match(reviewInstructions,/never guesses a unit expansion/);assert.match(reviewInstructions,/including every reused clip/);assert.match(reviewInstructions,/immutable original source string/);
});
