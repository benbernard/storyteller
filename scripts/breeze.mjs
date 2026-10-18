import {parseArgs} from 'node:util';
import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
if(existsSync('.env'))process.loadEnvFile('.env');
process.umask(0o077);
const {values,positionals}=parseArgs({allowPositionals:true,options:{fiction:{type:'string'},cast:{type:'string'},tags:{type:'string'},chapters:{type:'string'},title:{type:'string'},author:{type:'string',default:''},job:{type:'string'},reason:{type:'string'},presentation:{type:'string'},config:{type:'string'},file:{type:'string'},directory:{type:'string'}}});
const root=resolve('.');
const read=async path=>JSON.parse(await readFile(path,'utf8'));
const save=async(path,data)=>writeFile(path,JSON.stringify(data,null,2)+'\n',{mode:0o600,flag:'wx'});
const required=name=>{if(!values[name])throw new Error('--'+name+' is required');return values[name]};
const safe=value=>{if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(value))throw new Error('Use a safe ID');return value};
if(positionals[0]==='import'){
 const fiction=safe(required('fiction')),state=resolve('data/fictions',fiction);
 const {Store}=await import(pathToFileURL(resolve('tools/audiobooks/dist/store.js')).href);
 const {Pipeline}=await import(pathToFileURL(resolve('tools/audiobooks/dist/pipeline.js')).href);
 const store=new Store(state),pipeline=new Pipeline(store),input=await read(resolve(required('file')));
 await store.lock(async()=>{
  if(!await store.read('config.json')){const config=await read('tools/audiobooks/examples/fiction.json');config.fictionId=fiction;await pipeline.configure(config);}
  for(const chapter of (Array.isArray(input)?input:[input]).sort((a,b)=>a.sequence-b.sequence))await pipeline.ingest(chapter);
 });
 console.log('Imported '+fiction+' into '+state+'. No provider calls were made.');
}else if(positionals[0]==='design'){
 const home=resolve(process.env.MAC_TTS_HOME??'data/mac-tts');
 const child=spawn(join(home,'venv/bin/python'),['tools/mac-tts/acting-auditions/generate.py','--model','breeze-design','--output',resolve(required('directory')),'--python',join(home,'venv/bin/python'),'--credential',resolve('data/credentials/mac-client.json')],{stdio:'inherit',env:{...process.env,HF_HOME:join(home,'cache/huggingface')}});
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
 child.on('error',error=>{throw error});child.on('exit',code=>{process.exitCode=code??1});
}else if(positionals[0]==='run'){
 const config=resolve(required('config'));
 const child=spawn(process.execPath,['tools/audiobooks/dist/breeze-book.js',config],{stdio:'inherit',env:{...process.env,HF_HOME:resolve(process.env.MAC_TTS_HOME ?? 'data/mac-tts','cache/huggingface')}});
 for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
 child.on('error',error=>{throw error});child.on('exit',code=>{process.exitCode=code ?? 1});
}else if(positionals[0]==='init'){
 const fiction=safe(required('fiction')),job=safe(required('job')),state=resolve('data/fictions',fiction),directory=resolve('data/breeze',job);
 const reason=required('reason');if(reason.length<20)throw new Error('Give a descriptive --reason (at least 20 characters)');
 const analysisModel=process.env.AUDIOBOOK_ANALYSIS_MODEL;
 if(!analysisModel || analysisModel.startsWith('choose-'))throw new Error('Set AUDIOBOOK_ANALYSIS_MODEL in .env');
 const castPath=resolve(required('cast')),cast=await read(castPath),tags=await read(resolve(required('tags'))),index=await read(join(state,'index.json'));
 if(index.fictionId!==fiction)throw new Error('Imported fiction ID differs from --fiction');
 const chapterIds=required('chapters').split(',').map(safe);
 if(!chapterIds.length || chapterIds.some(id=>!index.chapters.some(c=>c.id===id)))throw new Error('Choose imported chapter IDs');
 await mkdir(resolve('data/breeze'),{recursive:true,mode:0o700});await mkdir(directory,{mode:0o700});
 const voices={};const decisions=[];
 for(const [role,entry] of Object.entries(cast.voices)){
  safe(role);const tag=tags[role];if(!tag || !Array.isArray(tag.tags))throw new Error('Missing tags for '+role);
  const original=join(dirname(castPath),'references',role,'reference.wav'),bytes=await readFile(original);
  if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new Error('Reference checksum mismatch for '+role);
  const folder=join(directory,'references',role);await mkdir(folder,{recursive:true,mode:0o700});const path=join(folder,'reference.wav');await copyFile(original,path);
  const identities=tag.identities ?? (role==='narrator' ? ['narrator'] : ['*']);
  voices[role]={path,identities,description:entry.provenance,voice:{reference_id:entry.reference_id,sha256:entry.sha256,transcript:entry.transcript,provenance:entry.provenance,tags:tag.tags,reserved:tag.reserved ?? false}};
  for(const id of identities)if(!['*','narrator','author-note'].includes(id))decisions.push({id,canonicalId:id,portrayal:entry.provenance});
 }
 if(!voices.narrator || !voices.anonymous || voices.narrator.voice.sha256===voices.anonymous.voice.sha256)throw new Error('Distinct reviewed narrator and anonymous references required');
 voices['author-note'] ??= {...voices.anonymous,identities:['author-note'],description:'Separate author-note reference'};
 const model=(await read('tools/mac-tts/acting-auditions/models.json')).breeze;
 const catalog=join(directory,'catalog.json');await save(catalog,{revision:model.revision,voices});
 const presentation=join(directory,'presentation.json');
 if(values.presentation)await copyFile(resolve(values.presentation),presentation);
 else{
  const {Store}=await import(pathToFileURL(resolve('tools/audiobooks/dist/store.js')).href);
  const {chapterPresentation}=await import(pathToFileURL(resolve('tools/audiobooks/dist/local-presentation.js')).href);
  const entries={};
  for(const id of chapterIds){const item=index.chapters.find(c=>c.id===id),chapter=await read(join(state,'sources',item.current+'.json'));entries[id]=await chapterPresentation(new Store(resolve('data/archive',fiction)),chapter);}
  await save(presentation,entries);
 }
 const modelFile=join(directory,'model.json');await save(modelFile,model);
 const audit=join(state,'casting-review.json');
 if(!existsSync(audit))await save(audit,{bookId:fiction,audioRegenerationAuthorized:true,reason,decisions});
 else{const saved=await read(audit);if(saved.bookId!==fiction || saved.audioRegenerationAuthorized!==true)throw new Error('Existing casting review does not authorize this book; review it before running');}
 const source=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),home=resolve(process.env.MAC_TTS_HOME ?? 'data/mac-tts');
 const queue={fiction,edition:'breeze',directory,state,tooling:root,credential:resolve('data/credentials/mac-client.json'),python:join(home,'venv/bin/python'),asrPython:join(home,'asr-venv/bin/python'),phonemePython:join(home,'phoneme-venv/bin/python'),source,title:required('title'),author:values.author,analysisModel,listenerUrl:process.env.LISTENER_PUBLIC_URL ?? 'http://localhost:8080',listenerUsername:process.env.LISTENER_USERNAME ?? 'listener',listenerPasswordFile:resolve('data/credentials/listener-password'),maxRetakes:3,publishMinor:true,ownerInstruction:reason};
 const config={queue,chapterIds,catalog,presentation,model:modelFile};
 const {bookConfigSchema}=await import(pathToFileURL(resolve('tools/audiobooks/dist/breeze-book.js')).href);
 await save(join(directory,'book.json'),bookConfigSchema.parse(config));
 console.log('Prepared '+join(directory,'book.json')+'. Review the catalog and run with node scripts/breeze.mjs run --config PATH.');
}else throw new Error('Use import --fiction ID --file CHAPTERS_JSON, design --directory PATH, init --fiction ID --cast CAST_JSON --tags TAGS_JSON --chapters ID,ID --title TITLE --job ID --reason REASON, or run --config BOOK_JSON');
