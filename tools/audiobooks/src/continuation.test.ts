import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ContinuationSync, type SyncState, type SyncProgress, SyncConflict} from './continuation.js';
import {Store} from './store.js';
import type {Book} from './book.js';

async function fixture(run:(sync:ContinuationSync<SyncState>,read:()=>SyncState,events:SyncProgress[])=>Promise<void>) {
 const root=await mkdtemp(join(tmpdir(),'continuation-'));const store=new Store(root);
 let saved:SyncState={positions:{'story:Inworld:chapter1':{story:'story',edition:'Inworld',chapterId:'chapter1',sequence:1,assembly:'a'.repeat(64),seconds:15,eventId:'old',deviceTime:1,receivedAt:'old',reason:'pause',completed:false}}};
 const book={id:'story',defaultEdition:'qwen',editions:{Inworld:{chapters:[{id:'chapter1',sequence:1,assembly:'a'.repeat(64)},{id:'chapter2',sequence:2,assembly:'b'.repeat(64)}]}}} as unknown as Book;
 const events:SyncProgress[]=[];
 const sync=new ContinuationSync(store,async()=>structuredClone(saved),async(_owner,value)=>{saved=structuredClone(value);},async()=>book,async(_owner,p)=>{events.push(p);});
 try{await run(sync,()=>saved,events);}finally{await rm(root,{recursive:true,force:true});}
}
const input={story:'story',chapterId:'chapter2',source:'bookorbit' as const,sourceRevision:2,expectedRevision:0};
test('handoff preserves edition, is idempotent, and undo restores exact audio',()=>fixture(async(sync,read,events)=>{
 const p=await sync.preview('owner',input);assert.equal(p.action,'move');
 await sync.apply('owner',p.id);await sync.apply('owner',p.id);assert.equal(events.length,1);
 assert.equal(read().continuations?.story?.revision,1);assert.equal(events[0]?.edition,'Inworld');assert.equal(events[0]?.seconds,0);
 assert.equal((await sync.preview('owner',{...input,expectedRevision:1})).action,'duplicate');
 await sync.undo('owner',p.id);assert.equal(events[1]?.seconds,15);assert.equal(events[1]?.assembly,'a'.repeat(64));assert.equal(read().continuations?.story?.revision,2);
}));
test('same-chapter marker preserves exact position and acknowledges source revision',()=>fixture(async(sync,read,events)=>{
 const p=await sync.preview('owner',{...input,chapterId:'chapter1'});assert.equal(p.action,'preserve');await sync.apply('owner',p.id);
 assert.equal(events.length,0);assert.equal(read().positions['story:Inworld:chapter1']?.seconds,15);
 assert.equal((await sync.preview('owner',{...input,chapterId:'chapter1'})).action,'duplicate');
}));
test('unavailable chapter is kept pending and never changes playable bookmark',()=>fixture(async(sync,read,events)=>{
 const p=await sync.preview('owner',{...input,chapterId:'missing'});assert.equal(p.action,'unavailable');assert.equal((await sync.apply('owner',p.id)).saved,false);assert.equal(events.length,0);assert.equal(read().syncSources,undefined);
}));
test('preview and undo cannot overwrite intervening playback or another account',()=>fixture(async(sync,read)=>{
 const p=await sync.preview('owner',input);
 await assert.rejects(sync.apply('other',p.id),/not_found/);
 read().positions['story:Inworld:chapter1']!.seconds=16;
 await assert.rejects(sync.apply('owner',p.id),SyncConflict);
 const p2=await sync.preview('owner',input);await sync.apply('owner',p2.id);
 read().positions['story:Inworld:chapter2']!.eventId='played';
 await assert.rejects(sync.undo('owner',p2.id),SyncConflict);
 await assert.rejects(sync.preview('owner',input),SyncConflict);
}));
