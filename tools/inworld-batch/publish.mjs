import assert from 'node:assert/strict';
import {Store,fingerprint} from '/app/dist/store.js';
import {Pipeline} from '/app/dist/pipeline.js';
import {publishBook} from '/app/dist/book.js';
import {reading} from '/app/dist/reading.js';
const store=new Store('/fictions/'+input.fiction);
await store.lock(async()=>{
 const before=await store.read('book.json');
 const assembly=await store.read(`assemblies/${input.assembly}/metadata.json`);
 const existing=before.editions[input.edition]?.chapters.find(c=>c.id===assembly.chapterId);
 if(existing&&existing.assembly!==input.assembly)throw Error('A different recording is already published; review before replacing');
 const previousOthers={...before.editions};delete previousOthers[input.edition];
 const text=await reading(store,assembly,{id:assembly.chapterId,title:'publication check'});
 if(!existing)await publishBook(new Pipeline(store),input.batch,input.edition,before.title,before.author,true);
 const after=await store.read('book.json');const others={...after.editions};delete others[input.edition];
 assert.equal(fingerprint(others),fingerprint(previousOthers));assert.equal(after.defaultEdition,before.defaultEdition);
 console.log(JSON.stringify({assembly:input.assembly,passages:text.passages.length,edition:input.edition}));
});
