import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,cp,rm,stat} from 'node:fs/promises';
import {resolve,join} from 'node:path';
await mkdir('.agent-scratch',{recursive:true});
const temp=await mkdtemp(resolve('.agent-scratch/sample-test-'));
const install=(state,samples='samples/maltese-falcon')=>spawnSync(process.execPath,['scripts/install-sample.mjs','--state',state,'--samples',samples],{encoding:'utf8'});
try{
 const state=join(temp,'state');let result=install(state);assert.equal(result.status,0,result.stderr);
 const book=JSON.parse(await readFile(join(state,'book.json'),'utf8'));assert.deepEqual(Object.keys(book.editions),['breeze','qwen','inworld']);
 const before=(await stat(join(state,'book.json'))).mtimeMs;result=install(state);assert.equal(result.status,0,result.stderr);assert.equal((await stat(join(state,'book.json'))).mtimeMs,before);
 for(const edition of Object.values(book.editions)){
  const c=edition.chapters[0],audio=join(state,'assemblies',c.assembly,'chapter.mp3');
  const decoded=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','json',audio],{encoding:'utf8'});assert.equal(decoded.status,0,decoded.stderr);assert(Math.abs(Number(JSON.parse(decoded.stdout).format.duration)-c.duration)<0.15);
 }
 const damaged=join(temp,'damaged');await cp('samples/maltese-falcon',damaged,{recursive:true});await writeFile(join(damaged,'qwen.mp3'),'broken');
 result=install(join(temp,'rejected'),damaged);assert.notEqual(result.status,0);assert.match(result.stderr,/checksum mismatch/);await assert.rejects(stat(join(temp,'rejected')),{code:'ENOENT'});
 await writeFile(join(state,'book.json'),'changed');result=install(state);assert.notEqual(result.status,0);assert.match(result.stderr,/Existing sample differs/);assert.equal(await readFile(join(state,'book.json'),'utf8'),'changed');
 console.log('PASS: three decoded editions, complete timelines, repeat install, damaged bundle rejection, and existing-data preservation');
}finally{await rm(temp,{recursive:true,force:true});}
