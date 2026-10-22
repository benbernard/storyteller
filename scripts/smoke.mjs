import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {mkdir,mkdtemp,cp,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
await mkdir('.agent-scratch',{recursive:true});
const temp=await mkdtemp(resolve('.agent-scratch/smoke-'));
const name='audiobook-smoke-'+process.pid, fixtureVolume=name+'-fixtures', seed=name+'-seed';
const command=(args)=>{const r=spawnSync('docker',args,{encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr || 'Docker command failed');return r.stdout.trim();};
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const origin='http://127.0.0.1:'+port;
try{
 await mkdir(join(temp,'fictions'));await mkdir(join(temp,'archive'));await mkdir(join(temp,'credential'));
 await cp('data/credentials/listener-password',join(temp,'credential/listener-password')); 
 await cp('data/fictions/lantern-pilot',join(temp,'fictions/lantern-pilot'),{recursive:true});
 await cp('data/fictions/maltese-falcon-sample',join(temp,'fictions/maltese-falcon-sample'),{recursive:true});
 // Docker volumes also work when an external Mac worktree is outside Colima's
 // host mounts. Copy only synthetic fixtures; the server mounts them read-only.
 command(['volume','create',fixtureVolume]);
 command(['create','--name',seed,'--network=none','-v',fixtureVolume+':/fixture','--entrypoint','node','storyteller:local','-e','']);
 command(['cp','-a',temp+'/.',seed+':/fixture']);
 command(['rm',seed]);
 const uid=String(process.getuid?.() ?? 1000),gid=String(process.getgid?.() ?? 1000);
 const args=['run','-d','--name',name,'--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user',uid+':'+gid,'-p','127.0.0.1:'+port+':8080','--tmpfs','/listener:uid='+uid+',gid='+gid+',mode=0700','-e','LISTENER_PUBLIC_URL='+origin,'-e','AUDIOBOOK_FICTIONS=/fixture/fictions','-e','ROYAL_ROAD_ARCHIVE=/fixture/archive','-e','LISTENER_PASSWORD_FILE=/fixture/credential/listener-password','-v',fixtureVolume+':/fixture:ro','--entrypoint','node','storyteller:local','dist/listener.js'];
 command(args);
 let ready=false;for(let i=0;i<120;i++){try{if((await fetch(origin+'/healthz')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,250));}assert(ready,'Listener startup');
 assert.equal((await fetch(origin+'/listen/library')).status,401);
 const password=(await readFile('data/credentials/listener-password','utf8')).trim();
 const headers={Authorization:'Basic '+Buffer.from('listener:'+password).toString('base64')};
 const library=await fetch(origin+'/listen/library',{headers});assert.equal(library.status,200);
 const data=await library.json();const book=data.books.find(b=>b.id==='lantern-pilot');assert(book,'Demo book present');
 const page=await fetch(origin+'/listen/',{headers});assert.match(await page.text(),/<title>Listener<\/title>/);
 const icon=await fetch(origin+'/listen/storyteller-mark.png',{headers});assert.equal(icon.headers.get('content-type'),'image/png');assert.equal(Buffer.from(await icon.arrayBuffer()).subarray(0,8).toString('hex'),'89504e470d0a1a0a');
 const real=data.books.find(b=>b.id==='maltese-falcon-sample');assert(real,'Spoken sample present');
 for(const edition of ['breeze','qwen','inworld']){const c=real.editions[edition].chapters[0],prefix='/listen/stories/'+real.id+'/'+edition+'/';const r=await fetch(origin+prefix+'text/'+c.assembly,{headers});assert.equal(r.status,200);assert.match((await r.json()).text,/What does he do for a living/);const a=await fetch(origin+prefix+'audio/'+c.assembly,{headers:{...headers,Range:'bytes=0-15'}});assert.equal(a.status,206);assert.equal((await a.arrayBuffer()).byteLength,16);}
 const chapter=book.editions.v3.chapters[0];
 const prefix='/listen/stories/lantern-pilot/v3/';
 const text=await fetch(origin+prefix+'text/'+chapter.assembly,{headers});assert.equal(text.status,200);assert((await text.json()).passages.length>0);
 const audio=origin+prefix+'audio/'+chapter.assembly;
 const partial=await fetch(audio,{headers:{...headers,Range:'bytes=0-15'}});assert.equal(partial.status,206);assert.equal((await partial.arrayBuffer()).byteLength,16);
 assert.equal((await fetch(audio,{headers:{...headers,Range:'bytes=999999999-'}})).status,416);
 assert.equal((await fetch(origin+'/api/listener/library',{headers})).status,401);
 assert.equal((await fetch(origin+'/listen/pair/approve',{method:'POST',headers:{...headers,Origin:'https://other.example.org','Content-Type':'application/json'},body:'{}'})).status,403);
 console.log('PASS: Docker login, private routes, demo library, source text, byte ranges, and Origin checks');
}finally{for(const id of [name,seed]){try{command(['rm','-f',id]);}catch{}}try{command(['volume','rm',fixtureVolume]);}catch{}await rm(temp,{recursive:true,force:true});}
