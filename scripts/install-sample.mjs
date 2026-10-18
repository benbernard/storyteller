// Install bundled speech without credentials, model downloads, analysis, or provider calls.
import {readFile,mkdir,rename,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{state:{type:'string'},samples:{type:'string'}}});
const container=!!process.env.AUDIOBOOK_SAMPLE_STATE;
const engine=container?'/app/dist/':resolve('tools/audiobooks/dist')+'/';
const {Store,sha,atomic,fingerprint}=await import(pathToFileURL(engine+'store.js').href);
const {reading}=await import(pathToFileURL(engine+'reading.js').href);
const directory=resolve(values.samples??(container?'/samples/maltese-falcon/':'samples/maltese-falcon/'))+'/';
const manifestBytes=await readFile(directory+'manifest.json'),manifest=JSON.parse(manifestBytes);
if(manifest.schemaVersion!==1||manifest.bookId!=='maltese-falcon-sample')throw new Error('Unsupported sample manifest');
const files=new Map();
for(const name of ['breeze.mp3','breeze.json','qwen.mp3','qwen.json','inworld.mp3','inworld.json']){
 const bytes=await readFile(directory+name),expected=manifest.files[name];
 if(!expected||bytes.length!==expected.bytes||sha(bytes)!==expected.sha256)throw new Error('Sample checksum mismatch: '+name);
 files.set(name,bytes);
}
const destination=resolve(values.state??process.env.AUDIOBOOK_SAMPLE_STATE??'data/fictions/maltese-falcon-sample');
const expected=new Map();
function json(path,value){expected.set(path,Buffer.from(JSON.stringify(value,null,2)+'\n'));}
const book={schemaVersion:1,id:manifest.bookId,title:manifest.title,author:manifest.author,defaultEdition:manifest.defaultEdition,editions:{}};
for(const provider of ['breeze','qwen','inworld']){
 const item=JSON.parse(files.get(provider+'.json').toString()),{source,analysis,plan,assembly:a}=item;
 if(sha(source.text)!==manifest.sourceSha256||fingerprint(source)!==a.source||fingerprint(analysis)!==a.analysis||fingerprint(plan)!==a.plan||sha(files.get(provider+'.mp3'))!==a.checksum)throw new Error('Invalid sample metadata');
 json('sources/'+a.source+'.json',source);json('analyses/'+a.analysis+'.json',analysis);json('plans/'+a.plan+'.json',plan);
 json('assemblies/'+a.id+'/metadata.json',a);expected.set('assemblies/'+a.id+'/chapter.mp3',files.get(provider+'.mp3'));
 book.editions[provider]={batch:'bundled-public-sample',publishedAt:'2026-10-18T00:00:00Z',chapters:[{id:a.chapterId,sequence:1,title:source.title,assembly:a.id,source:a.source,duration:a.duration,checksum:a.checksum}]};
}
json('book.json',book);json('sample-install.json',{manifestSha256:sha(manifestBytes)});
async function verify(root){
 for(const [path,bytes]of expected)if(sha(await readFile(join(root,path)))!==sha(bytes))throw new Error('Existing sample differs: '+path);
 const store=new Store(root);for(const edition of Object.values(book.editions)){const c=edition.chapters[0];await reading(store,await store.read('assemblies/'+c.assembly+'/metadata.json'),c);}
}
if(existsSync(destination)){await verify(destination);console.log('Verified the installed sample; no files changed.');}
else{
 const staging=destination+'.staging-'+randomUUID();
 try{await mkdir(staging,{recursive:true,mode:0o700});for(const [path,bytes]of expected)await atomic(join(staging,path),bytes);await verify(staging);await rename(staging,destination);}
 finally{await rm(staging,{recursive:true,force:true});}
 console.log('Installed The Maltese Falcon sample: Breeze, Qwen, and Inworld. Open /listen/ and choose an edition.');
}
