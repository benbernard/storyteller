import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {hash} from './core.mjs';
import {voiceDesignPrompt} from './voice-design.mjs';

const brief='A female narrator’s voice—warm, clear, and calm. Résumé: naïve café owner.\u00a0“Careful…”';
const ascii='A female narrator\'s voice-warm, clear, and calm. Resume: naive cafe owner. "Careful..."';
test('voice descriptions fold typography and accents without changing identity or gender',()=>{
 assert.equal(voiceDesignPrompt(brief),ascii);
 assert.equal(voiceDesignPrompt(ascii),ascii);
 assert.equal(voiceDesignPrompt('A soft female voice.\r\nÆgir, Œnone, Straße, Łódź, Øresund.'),'A soft female voice.\nAEgir, OEnone, Strasse, Lodz, Oresund.');
});
test('voice descriptions normalize whitespace and controls, and reject unusable briefs',()=>{
 assert.equal(voiceDesignPrompt('  A\tclear\u0000female\u007fvoice.\r\n  Calm\u200b.\u202e  '),'A clear female voice.\nCalm.');
 for(const input of ['',null,{},'\n\u0000\t','123 !!!','女声','A female voice 🎵'])assert.throws(()=>voiceDesignPrompt(input),/Voice design brief/);
});

const write=async(path,value)=>fs.writeFile(path,JSON.stringify(value));
for(const mode of ['design','publish','invalid','server-error','timeout-response','server-error-voice','legacy-rejected'])test(`runner ${mode} validates only voice descriptions before provider requests`,async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-voice-prompt-')),bin=join(root,'bin'),folder=join(root,'chapter');
 await fs.mkdir(bin);await fs.mkdir(folder);
 const originalVoices={narrator:{voiceId:'saved-female'}};
 const input={chapterId:'a',items:[{customId:'p0',role:'new-character',spokenText:'“Héllo”—unaltered.',request:{text:'“Héllo”—unaltered.'}}]};
 const entry={chapterId:'a',sequence:1,root:folder,inputHash:hash(input)};
 await write(join(folder,'input.json'),input);await write(join(root,'voices.json'),originalVoices);
 const profile={designPrompt:mode==='invalid'?'123\u0000':brief,previewText:'Hello.'};
 await write(join(root,'voice-profiles.json'),{'new-character':profile});
 await write(join(root,'queue.json'),{root,host:'fixture',archive:'/fixture',fiction:'fixture',chapters:[entry],originalVoices,ceilingUSD:1});
 const designDirectory=join(root,'voice-designs','new-character');
 if(mode==='publish'){
  await fs.mkdir(designDirectory,{recursive:true});await write(join(designDirectory,'design.json'),{phase:'designed',voice:{voiceId:'retained-preview'},profile});
 }
 if(mode==='legacy-rejected'){
  await fs.mkdir(designDirectory,{recursive:true});await write(join(designDirectory,'design.json'),{phase:'rejected',response:{status:503,body:{previewVoices:[{voiceId:'historical-preview'}]}},profile});
 }
 const ssh=`#!/usr/bin/env node\nconst fs=require('fs');let input='';process.stdin.on('data',data=>input+=data);process.stdin.on('end',()=>{if(!input)return;const request=JSON.parse(input);fs.appendFileSync(process.env.CALLS,JSON.stringify(request)+'\\n');const mode=process.env.MODE;console.log(JSON.stringify({status:mode.startsWith('server-error')?500:mode==='timeout-response'?408:400,body:mode==='server-error-voice'?{previewVoices:[{voiceId:'retain-provider-evidence',previewAudio:'retained-preview-evidence'}]}:{code:3,message:'Fixture rejection'}}));});`;
 await fs.writeFile(join(bin,'ssh'),ssh,{mode:0o755});await fs.writeFile(join(bin,'rsync'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 try{
  const launch=()=>spawnSync(process.execPath,[resolve('tools/inworld-batch/runner.mjs'),join(root,'queue.json')],{env:{...process.env,PATH:bin+':'+process.env.PATH,CALLS:join(root,'calls'),MODE:mode},encoding:'utf8',timeout:10000});
  const run=launch();
  assert.equal(run.status,0,run.stderr);
  assert.deepEqual(JSON.parse(await fs.readFile(join(root,'voices.json'),'utf8')),originalVoices);
  assert.deepEqual(JSON.parse(await fs.readFile(join(folder,'input.json'),'utf8')),input);
  if(mode==='invalid'||mode==='legacy-rejected'){
   assert.equal(await fs.access(join(root,'calls')).then(()=>true,()=>false),false);
   if(mode==='invalid')assert.equal(await fs.access(join(designDirectory,'design.json')).then(()=>true,()=>false),false);
   else assert.equal(JSON.parse(await fs.readFile(join(designDirectory,'design.json'),'utf8')).phase,'rejected');
  }else{
   const calls=(await fs.readFile(join(root,'calls'),'utf8')).trim().split('\n').map(JSON.parse);
   assert.equal(calls.length,1);assert.equal(calls[0].body[mode==='publish'?'description':'designPrompt'],ascii);
   assert.equal(calls[0].path,mode==='publish'?'/voices/v1/voices/retained-preview:publish':'/voices/v1/voices:design');
   if(mode==='publish'){
    assert.equal(calls[0].body.displayName,'fixture Inworld - new-character');
    assert.equal(JSON.parse(await fs.readFile(join(designDirectory,'design.json'),'utf8')).voice.voiceId,'retained-preview');
   }
   if(['server-error','timeout-response','server-error-voice'].includes(mode)){
    const receipt=JSON.parse(await fs.readFile(join(designDirectory,'design.json'),'utf8'));assert.equal(receipt.phase,'submitting');
    assert.equal(receipt.response.status,mode==='timeout-response'?408:500);
    if(mode==='server-error-voice')assert.equal(receipt.response.body.previewVoices[0].voiceId,'retain-provider-evidence');
    assert.equal(launch().status,0);assert.equal((await fs.readFile(join(root,'calls'),'utf8')).trim().split('\n').length,1);
    assert.match(JSON.parse(await fs.readFile(join(root,'status.json'),'utf8')).reason,/Uncertain voice design submission/);
   }
  }
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
