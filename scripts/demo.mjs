// Infrastructure demo: silence with an original scene. No provider calls or speech quality claims.
import {readFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const container = !!process.env.AUDIOBOOK_DEMO_STATE;
const engine = container ? '/app/dist/' : resolve('tools/audiobooks/dist')+'/';
const load = name => import(pathToFileURL(engine+name).href);
const {Store,sha,atomic}=await load('store.js');
const {Pipeline}=await load('pipeline.js');
const {publishBook}=await load('book.js');
const examples = container ? '/examples/' : 'tools/audiobooks/examples/';
const config=JSON.parse(await readFile(examples+'fiction.json','utf8'));
const chapter=JSON.parse(await readFile(examples+'chapter.json','utf8'));
const analysis=JSON.parse(await readFile(examples+'analysis.json','utf8'));
const state=new Store(process.env.AUDIOBOOK_DEMO_STATE ?? resolve('data/fictions/lantern-pilot'));
function wave(seconds=1){const size=44100*2*seconds,b=Buffer.alloc(44+size);b.write('RIFF');b.writeUInt32LE(36+size,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(44100,24);b.writeUInt32LE(88200,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(size,40);return b;}
await state.lock(async()=>{
 const sample=wave();const key='a'.repeat(64);
 await atomic(state.path('assets/'+key+'/audio.mp3'),sample);
 await state.write('assets/'+key+'/metadata.json',{fingerprint:key,checksum:sha(sample)});
 config.pool=['demo-one','demo-two','demo-three'].map(voiceId=>({...config.anonymous,voiceId,tags:['adult'],rating:4,reserveForMajor:false,sampleAsset:key,ratedBy:'synthetic demo',notes:'Silence, not a voice audition.'}));
 config.policy.selectedAfterListening=true;config.policy.listeningEvidence='Synthetic demo only, no speech.';
 config.budget={maxCharacters:100000,maxEstimatedUsd:1,usdPerThousandCharacters:0.001,maxAttemptsPerSegment:1};
 const p=new Pipeline(state);await p.configure(config);await p.ingest(chapter);if(!await state.read('heads/'+chapter.chapterId+'.json')) await p.importAnalysis(chapter.chapterId,analysis);
 await p.run('demo',{render:async()=>({audio:wave(2),requestId:null,billedCredits:null})});
 await publishBook(p,'demo','v3','The Lantern (silent demo)','Original demonstration scene');
});
console.log('Silent demo published. Open /listen/. No keys were read and no providers were called.');
