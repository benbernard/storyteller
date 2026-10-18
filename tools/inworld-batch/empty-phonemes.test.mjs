import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';
import {hash,sha} from './core.mjs';
import {adjudicationEvidence,evidenceRow} from './adjudication.mjs';
const save=async(path,value)=>{await fs.mkdir(dirname(path),{recursive:true});await fs.writeFile(path,JSON.stringify(value));};
const read=async path=>JSON.parse(await fs.readFile(path,'utf8'));
const item={customId:'p0',role:'narrator',spokenText:'Hmm.',request:{text:'[read clearly] Hmm.'}},report={expected:item.spokenText,sha256:'current-audio',severity:'major',attempts:[{model:'small',transcript:'Uh.'},{model:'strong',transcript:'Uh.'}]},phoneme={audioSha256:report.sha256,inputPrompt:null,phonemes:''};
test('empty matching unprompted phonemes retain exact evidence as uncertainty, never as valid subscription proof',()=>{
 const original=structuredClone(report),result=adjudicationEvidence(item,report,phoneme,{});
 assert.equal(result.row,null);assert.equal(result.report.severity,'uncertain');assert.equal(result.report.fidelityUncertainty.kind,'empty-unprompted-phonemes');assert.equal(result.report.fidelityUncertainty.evidenceHash,hash(result.unavailableEvidence));assert.equal(result.report.fidelityUncertainty.phonemeHash,hash(phoneme));assert.deepEqual(result.unavailableEvidence.report,original);assert.deepEqual(result.unavailableEvidence.phoneme,phoneme);assert.deepEqual(report,original);
 assert.throws(()=>evidenceRow(item,report,phoneme,{}),/Empty unprompted/);
 assert.equal(adjudicationEvidence(item,report,{...phoneme,phonemes:'həm'},{}).row.phonemes,'həm');
 const misleading=adjudicationEvidence(item,{...report,modelReview:{severity:'pass'},ownerReview:{action:'accept'}},phoneme,{});assert.equal(misleading.report.severity,'uncertain');assert.equal(misleading.report.modelReview,undefined);assert.equal(misleading.report.ownerReview,undefined);
});
test('empty evidence never masks stale audio, prompted or malformed phonemes, changed text or unbound renderings',()=>{
 for(const p of [{...phoneme,audioSha256:'old-audio'},{...phoneme,inputPrompt:'source prompt'},{...phoneme,inputPrompt:undefined},{...phoneme,phonemes:undefined},{...phoneme,phonemes:null}])assert.throws(()=>adjudicationEvidence(item,report,p,{}),/Stale or prompted/);
 assert.throws(()=>adjudicationEvidence(item,{...report,expected:'Changed source'},phoneme,{}),/Stale or prompted/);
 assert.throws(()=>adjudicationEvidence(item,{...report,comparisonExpected:'arbitrary replacement'},phoneme,{}),/requires verified/);
 assert.throws(()=>adjudicationEvidence(item,report,phoneme,{}, {audioSha256:report.sha256}),/Unbound/);
});
async function fixture(startAttempt){
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-empty-phonemes-')),folder=join(root,'chapter'),bin=join(root,'bin');await fs.mkdir(bin);
 const chapter={chapterId:'synthetic',source:'source',items:[item]},entry={chapterId:chapter.chapterId,sequence:1,root:folder,inputHash:hash(chapter)},audio=Buffer.alloc(64,startAttempt),voices={narrator:{voiceId:'saved-female'}},receipt={sha256:sha(audio),duration:1,requestHash:hash({...item.request,voiceId:'saved-female'}),voiceId:'saved-female',job:'original',...(startAttempt?{repair:{attempt:startAttempt}}:{})};
 await save(join(folder,'input.json'),chapter);await save(join(folder,'receipts/p0.json'),receipt);await fs.mkdir(join(folder,'audio'),{recursive:true});await fs.writeFile(join(folder,'audio/p0.wav'),audio);await save(join(root,'voices.json'),voices);await save(join(root,'voice-profiles.json'),{});
 const python=join(bin,'python-review');await fs.writeFile(python,`#!/usr/bin/env node
const fs=require('fs'),path=require('path'),root=process.argv[3],read=p=>JSON.parse(fs.readFileSync(p,'utf8')),chapter=read(path.join(root,'input.json'));
for(const item of chapter.items){const receipt=read(path.join(root,'receipts',item.customId+'.json')),phone=process.argv[2].endsWith('phonemes.py'),dir=path.join(root,phone?'phoneme-review':'review');fs.mkdirSync(dir,{recursive:true});const value=phone?{audioSha256:receipt.sha256,inputPrompt:null,phonemes:''}:{expected:item.spokenText,sha256:receipt.sha256,severity:'major',attempts:[{model:'small',transcript:'Uh.'},{model:'strong',transcript:'Uh.'}]};fs.writeFileSync(path.join(dir,item.customId+'.json'),JSON.stringify(value));}
`,{mode:0o755});
 await fs.writeFile(join(bin,'ssh'),`#!/usr/bin/env node
const fs=require('fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{if(!input)return;const request=JSON.parse(input);fs.appendFileSync(process.env.PROVIDER_CALLS,JSON.stringify(request)+'\\n');console.log(JSON.stringify({status:200,body:{name:'operations/'+request.body.items[0].customId,done:true,response:{resultsUri:'https://fixture/results/'+request.body.items[0].customId}}}));});
`,{mode:0o755});
 await fs.writeFile(join(bin,'rsync'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 await fs.writeFile(join(bin,'ffprobe'),`#!/usr/bin/env node
console.log(process.argv.includes('json')?JSON.stringify({format:{duration:'1'},streams:[{channels:1,sample_rate:'48000'}]}):'1');
`,{mode:0o755});
 await fs.writeFile(join(bin,'ffmpeg'),`#!/usr/bin/env node
const fs=require('fs'),args=process.argv.slice(2),list=fs.readFileSync(args[args.indexOf('-i')+1],'utf8'),source=list.match(/file '([^']+)'/)[1];fs.writeFileSync(args.at(-1),fs.readFileSync(source));
`,{mode:0o755});
 const preload=join(root,'fetch.mjs');await fs.writeFile(preload,`globalThis.fetch=async url=>{const id=String(url).split('/').at(-1);return new Response(String(url).includes('/results/')?JSON.stringify({results:[{customId:id,audioUri:'https://fixture/audio/'+id}]}):new Uint8Array(64).fill(id.includes('r2')?2:1));};`);
 const analysis=join(root,'analysis.mjs');await fs.writeFile(analysis,`export async function runCodexAnalysis(){throw Error('Empty phoneme evidence must never reach subscription analysis');}`);
 const config={root,host:'fixture',archive:'/fixture',selectedChapterIds:[chapter.chapterId],preparationComplete:true,chapters:[entry],originalVoices:voices,automaticRepair:true,maxRetakes:2,ceilingUSD:50,python,phonemePython:python,analysisModule:analysis};await save(join(root,'queue.json'),config);
 const invoke=()=>spawnSync(process.execPath,['--import',preload,resolve('tools/inworld-batch/runner.mjs'),join(root,'queue.json')],{encoding:'utf8',timeout:15000,env:{...process.env,PATH:bin+':'+process.env.PATH,PROVIDER_CALLS:join(root,'provider-calls')}});
 return {root,folder,entry,invoke};
}
for(const startAttempt of [0,1])test(`empty phonemes resume ordinary attempts from ${startAttempt}, retain evidence, and hold durably at the existing cap`,async()=>{
 const f=await fixture(startAttempt);try{
  const result=f.invoke();assert.equal(result.status,0,result.stderr);const state=await read(join(f.root,'status.json'));assert.equal(state.status,'complete-with-review-backlog',JSON.stringify(state));assert.deepEqual(state.processingErrors,[]);
  const processing=await read(join(f.folder,'processing.json'));assert.equal(processing.status,'needs-review');assert.deepEqual(processing.passages,['p0']);assert.deepEqual((await read(join(f.folder,'quality.json'))).major,['p0']);assert.equal((await read(join(f.folder,'receipts/p0.json'))).repair.attempt,2);
  const effective=(await read(join(f.folder,'effective-reviews.json'))).p0;assert.equal(effective.severity,'uncertain');assert.equal(effective.fidelityUncertainty.kind,'empty-unprompted-phonemes');assert.equal(effective.modelReview,undefined);
  const snapshots=await fs.readdir(join(f.folder,'unavailable-review-evidence'));assert.equal(snapshots.length,3-startAttempt);for(const name of snapshots){const value=await read(join(f.folder,'unavailable-review-evidence',name));assert.equal(name,hash(value)+'.json');assert.equal(value.phoneme.phonemes,'');assert.equal(value.phoneme.inputPrompt,null);assert.equal(value.phoneme.audioSha256,value.report.sha256);}
  const ledger=await read(join(f.root,'jobs.json'));assert.equal(ledger.length,2-startAttempt);assert.ok(ledger.every(j=>j.phase==='complete'&&j.outputRoot.startsWith(join(f.folder,'repairs'))));assert.deepEqual(ledger.map(j=>j.items[0].customId),startAttempt?['p0r2p0']:['p0r1p0','p0r2p0']);assert.equal((await fs.readFile(join(f.root,'provider-calls'),'utf8')).trim().split('\n').length,2-startAttempt);
  const bytes=await fs.readFile(join(f.root,'jobs.json')),restart=f.invoke();assert.equal(restart.status,0,restart.stderr);assert.equal((await read(join(f.folder,'processing.json'))).status,'needs-review');assert.deepEqual(await fs.readFile(join(f.root,'jobs.json')),bytes);assert.equal((await fs.readFile(join(f.root,'provider-calls'),'utf8')).trim().split('\n').length,2-startAttempt);
  await assert.rejects(fs.access(join(f.folder,'published.json')));await assert.rejects(fs.access(join(f.folder,'assembly.json')));
 }finally{await fs.rm(f.root,{recursive:true,force:true});}
});
