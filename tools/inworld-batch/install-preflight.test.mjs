import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterPhonemePreflight} from './install-preflight.mjs';

for(const mode of ['normal','stage-only'])test(`${mode} installation cannot change active config, LaunchAgent or pending runtime when model preflight fails`,async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-install-preflight-'));
 try{
  const names=['config.json','launch-agent.plist','pending-runtime.json'];
  for(const name of names)await fs.writeFile(join(root,name),'original '+name);
  let activated=false;
  const activate=async()=>{activated=true;for(const name of mode==='normal'?names:names.slice(2))await fs.writeFile(join(root,name),'changed');};
  await assert.rejects(afterPhonemePreflight({phonemePython:'/configured/python'},root,async(program,args)=>{
   assert.equal(program,'/configured/python');assert.deepEqual(args,[join(root,'tools/inworld-batch/phonemes.py'),'--check-model']);throw Error('Exact pinned phoneme snapshot is missing');
  },activate),/--bootstrap-model/);
  assert.equal(activated,false);
  for(const name of names)assert.equal(await fs.readFile(join(root,name),'utf8'),'original '+name);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('verified offline model availability precedes activation, and missing interpreter config cannot activate',async()=>{
 const order=[];
 await afterPhonemePreflight({phonemePython:'/configured/python'},'/runtime',async()=>{order.push('verified');},async()=>{order.push('activated');});
 assert.deepEqual(order,['verified','activated']);
 await assert.rejects(afterPhonemePreflight({},'/runtime',async()=>{throw Error('must not run');},async()=>{throw Error('must not activate');}),/Configure phonemePython/);
});
