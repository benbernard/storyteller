/** Render the curated public-domain scene; no chapter analysis or private source data. */
import {parseArgs} from 'node:util';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {Store,sha,fingerprint} from '../tools/audiobooks/dist/store.js';
import {Pipeline} from '../tools/audiobooks/dist/pipeline.js';
import {importedAnalysis} from '../tools/audiobooks/dist/analysis.js';
import {Inworld} from '../tools/audiobooks/dist/audio.js';
import {configSchema} from '../tools/audiobooks/dist/schema.js';
if(existsSync('.env'))process.loadEnvFile('.env');
process.umask(0o077);
process.env.HF_HOME??=resolve(process.env.MAC_TTS_HOME??'data/mac-tts','cache/huggingface');
const {values}=parseArgs({options:{provider:{type:'string'},python:{type:'string'},credential:{type:'string'},rate:{type:'string'},voices:{type:'string'}}});
const provider=values.provider;if(!['qwen','breeze','inworld'].includes(provider))throw new Error('Use --provider qwen|breeze|inworld; see samples/maltese-falcon/README.md');
const scene=JSON.parse(await readFile('samples/maltese-falcon/scene.json','utf8'));
const text=scene.spans.map(s=>s.text).join('');if(sha(text)!==scene.textSha256)throw new Error('Sample source checksum changed');
const python=values.python??resolve(process.env.MAC_TTS_HOME??'data/mac-tts','venv/bin/python');
const root=resolve('data/sample',provider),state=new Store(join(root,'state'));
await mkdir(root,{recursive:true,mode:0o700});
const save=async(path,value)=>writeFile(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const command=async(program,args,env={})=>new Promise((done,fail)=>{
 const child=spawn(program,args,{stdio:'inherit',env:{...process.env,...env}});
 const stop=()=>child.kill('SIGTERM');process.once('SIGTERM',stop);process.once('SIGINT',stop);
 child.once('error',fail);child.once('close',code=>{process.off('SIGTERM',stop);process.off('SIGINT',stop);code===0?done():fail(new Error('Sample stage failed: '+program));});
});
await state.lock(async()=>{
const chapter={schemaVersion:1,fictionId:'maltese-falcon-sample',chapterId:'office-consultation',sequence:1,url:scene.source.url,title:'An office consultation',text,contentHash:sha(text),retrievedAt:'2026-10-17T00:00:00Z'};
const raw={characters:[],aliasUpdates:[],summary:'Sam Spade and Miles Archer agree to help Miss Wonderly.',spans:scene.spans.map(s=>({text:s.text,kind:s.speaker==='narrator'?'prose':'dialogue',speaker:s.speaker,certainty:'attributed',confidence:1,reason:'Manually curated against the credited public-domain excerpt.'}))};
// Attach paragraph separators to the preceding turn: the paid API cannot speak whitespace alone.
if(provider==='inworld')raw.spans=raw.spans.reduce((spans,span)=>{if(!/[\p{L}\p{N}]/u.test(span.text)&&spans.length)spans.at(-1).text+=span.text;else spans.push({...span});return spans;},[]);
const analysis=importedAnalysis(raw,chapter,{schemaVersion:1,members:['spade','archer','wonderly'].map(id=>({id,name:id,aliases:[],first:{chapter:1,offset:0},evidence:id,portrayal:scene.instructions[id],importance:'supporting',voices:[]}))});
const sourceKey=await state.object('sources',chapter),analysisKey=await state.object('analyses',analysis);
await state.write('index.json',{schemaVersion:1,fictionId:chapter.fictionId,chapters:[{id:chapter.chapterId,sequence:1,current:sourceKey,revisions:[sourceKey]}]});
await state.write('heads/'+chapter.chapterId+'.json',{source:sourceKey,analysis:analysisKey});
let model,voiceEvidence;
const batch='public-sample';
if(provider==='inworld'){
 if(process.env.INWORLD_KEY_STDIN==='1')process.env.INWORLD_API_KEY=await new Promise((done,fail)=>{let key='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{key+=x;if(key.length>4096)fail(new Error('Credential exceeds limit'));});process.stdin.on('end',()=>done(key.trim()));});
 if(!process.env.INWORLD_API_KEY)throw new Error('Configure INWORLD_API_KEY privately before rendering');
 const rate=Number(values.rate);if(!Number.isFinite(rate)||rate<=0)throw new Error('Supply --rate with your verified USD price per thousand characters');
 if(!values.voices)throw new Error('Supply --voices with a reviewed narrator/spade/archer/wonderly voice-ID map');
 const voices=await read(resolve(values.voices));for(const role of ['narrator','spade','archer','wonderly'])if(typeof voices[role]!=='string')throw new Error('Missing Inworld voice for '+role);
 const config=await read('tools/audiobooks/examples/fiction-inworld.json');
 config.fictionId=chapter.fictionId;config.protagonistId='spade';config.narrator.voiceId=voices.narrator;config.anonymous.voiceId=voices.wonderly;
 config.policy.normalization='off';config.policy.maxCharacters=1800;config.policy.grouping='turn';config.budget={maxCharacters:5000,maxEstimatedUsd:0.50,usdPerThousandCharacters:rate,maxAttemptsPerSegment:1};
 await state.write('cast.json',{schemaVersion:1,members:['spade','archer','wonderly'].map(id=>({id,name:id,aliases:[],first:{chapter:1,offset:0},evidence:analysis.spans.find(s=>s.speaker===id).text,portrayal:scene.instructions[id],importance:'supporting',voices:[{voiceId:voices[id],settings:config.narrator.settings,version:fingerprint({voiceId:voices[id]}),from:{chapter:1,offset:0},reason:'Explicit cast for this public-domain preview.',provenance:'Inworld stock voice selected for this sample.'}]}))});
 const pipeline=new Pipeline(state);await pipeline.configure(configSchema.parse(config));await pipeline.importAnalysis(chapter.chapterId,raw);
 await pipeline.run(batch,new Inworld(),'pilot',[chapter.chapterId]);
 model=config.policy.model;voiceEvidence={type:'Inworld stock voices',voices};
}else{
 const credential=await read(resolve(values.credential??'data/credentials/mac-client.json')),owner=randomUUID();
 const api=async(path,payload,bytes)=>{
  const response=await fetch(credential.endpoint+path,{method:payload!==undefined||bytes?'POST':'GET',headers:{Authorization:'Bearer '+credential.token,'X-Worker-Lease':owner,'Content-Type':bytes?'audio/wav':'application/json'},body:bytes??(payload===undefined?undefined:JSON.stringify(payload)),redirect:'error',signal:AbortSignal.timeout(180000)});
  if(!response.ok){await response.body?.cancel();throw new Error('Mac API HTTP '+response.status+' at '+path);}
  return response.json();
 };
 await api('/v1/lease',{owner,seconds:120});let renewalFailed=false;
 const timer=setInterval(()=>{void api('/v1/lease',{owner,seconds:120}).catch(()=>{renewalFailed=true;});},30000);
 try{
  const status=await api('/v1/status');if(status.active||status.queued)throw new Error('Other production work is active');await api('/v1/stop',{});
  const designed=await read('data/sample/voices/cast.json'),voices=structuredClone(designed.voices);voices.wonderly=voices.anonymous;delete voices.anonymous;
  const specs=await api('/v1/models'),qwen=(Array.isArray(specs)?specs:specs.models).find(x=>x.id==='qwen-base');
  const breeze=(await read('tools/mac-tts/acting-auditions/models.json')).breeze;
  model=provider==='qwen'?'qwen-base':'breeze-tts-2';
  if(provider==='qwen'){
   const uploadedPath=join(root,'uploaded-references.json'),uploaded=existsSync(uploadedPath)?await read(uploadedPath):{};
   for(const [role,voice]of Object.entries(voices)){
    const reference=await readFile(join('data/sample/voices/references',role==='wonderly'?'anonymous':role,'reference.wav'));
    if(sha(reference)!==voice.sha256)throw new Error('Reference changed');
    if(!uploaded[role]||uploaded[role].sha256!==voice.sha256){uploaded[role]={sha256:voice.sha256,id:(await api('/v1/references',undefined,reference)).id};await save(uploadedPath,uploaded);}
    voice.reference_id=uploaded[role].id;
   }
  }
  const cast={model,revision:provider==='qwen'?qwen.revision:breeze.revision,voices};await save(join(root,'cast.json'),cast);
  if(!existsSync(join(root,'plan.json'))){
   await command(python,['tools/mac-tts/local_book.py','prepare','--state',state.root,'--directory',root,'--cast',join(root,'cast.json'),'--chapters',chapter.chapterId]);
   const plan=await read(join(root,'plan.json'));plan.chapters[0].segments=plan.chapters[0].segments.filter(s=>s.presentation!=='title');await save(join(root,'plan.json'),plan);
  }
  const plan=await read(join(root,'plan.json'));if(plan.chapters[0].source!==sourceKey||plan.chapters[0].segments.map(s=>s.text).join('')!==text)throw new Error('Plan/source mismatch');
  if(fingerprint(plan.cast)!==fingerprint(cast))throw new Error('Saved plan has a different cast; use a new data/sample directory');
  if(provider==='breeze'){
   await save(join(root,'source.json'),chapter);await save(join(root,'casting-review.json'),{bookId:chapter.fictionId,decisions:'Manually curated public-domain dialogue.',syntheticReferences:true});
   await save(join(root,'model.json'),breeze);await save(join(root,'phase.json'),{phase:'breeze-full'});await save(join(root,'inference.json'),{engine:'cached-depth-v1',bits:8,groupSize:64,compiled:true});
   await save(join(root,'directions.json'),{planSha256:sha(await readFile(join(root,'plan.json'))),castingReviewSha256:sha(await readFile(join(root,'casting-review.json'))),directions:plan.chapters[0].segments.map(s=>({uid:s.uid,instruction:scene.instructions[s.role],rationale:'Curated delivery based on the credited scene and explicit speaker attribution.'}))});
   await mkdir(join(root,'references'),{recursive:true});for(const [role,voice]of Object.entries(voices))await copyFile(join('data/sample/voices/references',role==='wonderly'?'anonymous':role,'reference.wav'),join(root,'references',voice.reference_id+'.wav'));
   await command(python,['tools/mac-tts/acting-auditions/render_chapter.py',root],{AUDITION_LEASE_OWNER:owner});
   if(renewalFailed)throw new Error('Lease renewal failed; review before continuing');
   // Independent review is performed before publication; assembly requires bound review files.
   console.log('Rendered Breeze passages. Run the review/assembly stage before exporting.');
  }else{
   await command(python,['tools/mac-tts/local_book.py','render','--state',state.root,'--directory',root,'--credential',resolve(values.credential??'data/credentials/mac-client.json')],{MAC_TTS_LEASE:owner});
   if(renewalFailed)throw new Error('Lease renewal failed; review before continuing');
   await command(python,['tools/mac-tts/local_book.py','assemble','--state',state.root,'--directory',root,'--batch',batch]);
  }
  voiceEvidence={type:'Synthetic Breeze-designed references shared by the local models',designRevision:breeze.revision,voices:Object.fromEntries(Object.entries(voices).map(([role,v])=>[role,{sha256:v.sha256,transcript:v.transcript,provenance:v.provenance}]))};
 }finally{clearInterval(timer);await api('/v1/lease/release',{owner});}
}
await save(join(root,'generation.json'),{provider,model,sourceSha256:sha(text),voices:voiceEvidence,generatedAt:new Date().toISOString()});
if(provider!=='breeze')console.log('Rendered '+provider+'. Export after transcript review.');

});
