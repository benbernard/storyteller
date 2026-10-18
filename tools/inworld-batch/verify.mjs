// Runs as the listener service user. Exercise content routes on an isolated loopback
// server using the deployed code and live read-only fictions, without weakening auth.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createListener} from '/app/dist/listener.js';
import {Store} from '/app/dist/store.js';
const temporary=await mkdtemp(join(process.env.LISTENER_STATE??tmpdir(),'storyteller-publication-check-'));
const server=createListener(process.env.AUDIOBOOK_FICTIONS??'/fictions',new Store(temporary),()=> 'publication-check@localhost','http://127.0.0.1',process.env.ROYAL_ROAD_ARCHIVE??'/archive',false);
try {
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 const base=`http://127.0.0.1:${server.address().port}/listen`;
 const response=await fetch(base+'/library');assert.equal(response.status,200);
 const library=await response.json(),book=library.books.find(b=>b.id===input.fiction);
 const chapter=book.editions[input.edition].chapters.find(c=>c.assembly===input.assembly);assert.ok(chapter);
 const url=base+`/stories/${input.fiction}/${input.edition}`;
 const text=await fetch(url+'/text/'+input.assembly);assert.equal(text.status,200);const content=await text.json();assert.ok(content.passages.length);
 const range=await fetch(url+'/audio/'+input.assembly,{headers:{Range:'bytes=0-1023'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,1024);
 const audio=await fetch(url+'/audio/'+input.assembly);assert.equal(audio.status,200);assert.equal(createHash('sha256').update(Buffer.from(await audio.arrayBuffer())).digest('hex'),chapter.checksum);
 console.log(JSON.stringify({assembly:input.assembly,chapterId:chapter.id,duration:chapter.duration,audioVerified:true,textVerified:true,rangeVerified:true,verificationMode:'isolated-loopback-deployed-code',verifiedAt:new Date().toISOString()}));
}finally{await new Promise(done=>server.close(done));await rm(temporary,{recursive:true,force:true});}
