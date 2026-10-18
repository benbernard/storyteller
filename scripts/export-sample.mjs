// Export only the credited public scene and its new recordings, never a private fiction directory.
import {readFile,writeFile} from 'node:fs/promises';
import {Store,sha,fingerprint} from '../tools/audiobooks/dist/store.js';
import {reading} from '../tools/audiobooks/dist/reading.js';
const destination='samples/maltese-falcon/';
const scene=JSON.parse(await readFile(destination+'scene.json','utf8'));
const files={};
async function save(name,bytes){await writeFile(destination+name,bytes);files[name]={sha256:sha(bytes),bytes:Buffer.byteLength(bytes)};}
for(const provider of ['breeze','qwen','inworld']){
 const root='data/sample/'+provider+'/',store=new Store(root+'state');
 const delivery=await store.read('deliveries/public-sample/manifest.json');
 const assembly=await store.read('assemblies/'+delivery.chapters[0].assembly+'/metadata.json');
 const audio=await readFile(store.path('assemblies/'+assembly.id+'/chapter.mp3'));
 const source=await store.read('sources/'+assembly.source+'.json'),analysis=await store.read('analyses/'+assembly.analysis+'.json');
 if(sha(audio)!==assembly.checksum||source.contentHash!==scene.textSha256)throw new Error('Sample input changed');
 await reading(store,assembly,{id:source.chapterId,title:source.title});
 const review=JSON.parse(await readFile(root+'sample-review.json','utf8'));
 if(review.audioSha256!==assembly.checksum||review.sourceSha256!==sha(await readFile(destination+'excerpt.txt')))throw new Error('Independent review is stale');
 const generation=JSON.parse(await readFile(root+'generation.json','utf8'));
 const originalPlan=await store.read('plans/'+assembly.plan+'.json');
 if(originalPlan.quality?.status==='blocked')throw new Error('Unresolved major or uncertain review issues');
 const plan={policy:{model:originalPlan.policy.model},quality:{status:'preview',note:'Automated transcript evidence; no human listening rating.'},generation};
 const a={...assembly,plan:fingerprint(plan)};a.id=fingerprint({...a,id:undefined,publicSampleVersion:1});
 const assessment=review.assessment;
 const evidence={audioSha256:review.audioSha256,sourceSha256:review.sourceSha256,model:review.model,revision:review.revision,
  transcript:assessment.recognized_text,wordErrorRate:assessment.word_error_rate,
  differences:assessment.alignment.filter(word=>word.operation!=='equal'),limitation:review.limitation};
 await save(provider+'.mp3',audio);
 await save(provider+'.json',JSON.stringify({source,analysis,plan,assembly:a,generation,review:evidence},null,2)+'\n');
}
await writeFile(destination+'manifest.json',JSON.stringify({schemaVersion:1,bookId:'maltese-falcon-sample',title:'The Maltese Falcon — an office consultation',author:'Dashiell Hammett',defaultEdition:'breeze',sourceSha256:scene.textSha256,files},null,2)+'\n');
console.log('Exported the three public sample editions with checksums and transcript evidence.');
