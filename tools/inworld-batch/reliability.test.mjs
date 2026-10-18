import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {hash,sha} from './core.mjs';
import {PaidLane,belongsToEntry,evidenceRow,modelReview,needsModelReview,repairItems,validateReview} from './adjudication.mjs';
import {repairPassage,recoverRepairs} from './repair.mjs';

test('LLM decisions must cover exactly the current unprompted recording evidence',()=>{
 const item={customId:'s0000p0',role:'narrator',spokenText:'Ohhh'},report={expected:'Ohhh',sha256:'audio',severity:'major',attempts:[{transcript:'Oh'}]};
 const phoneme={audioSha256:'audio',inputPrompt:null,phonemes:'oʊ'};
 const row=evidenceRow(item,report,phoneme,{});
 const value={decisions:[{passage:item.customId,severity:'minor',reason:'The independent phonemes support the intended interjection.'}]};
 assert.equal(validateReview(value,[row])[0].severity,'minor');
 assert.throws(()=>validateReview({decisions:[]},[row]));
 assert.throws(()=>validateReview({decisions:[{...value.decisions[0],passage:'another'}]},[row]));
 assert.throws(()=>evidenceRow(item,report,{...phoneme,audioSha256:'different'},{}));
 assert.throws(()=>evidenceRow(item,report,{...phoneme,inputPrompt:'Ohhh'},{}));
 const saved={...value.decisions[0],evidenceHash:hash(row)};
 assert.equal(modelReview(report,saved,row).severity,'minor');
 assert.equal(modelReview(report,saved,{...row,phonemes:'different'}).severity,'major');
});

test('generation and repairs serialize paid work and stop the entire lane after an uncertain call',async()=>{
 const paid=new PaidLane(),events=[];
 let release;const wait=new Promise(resolve=>{release=resolve;});
 const first=paid.run(async()=>{events.push('generation starts');await wait;events.push('generation ends');});
 const second=paid.run(async()=>{events.push('repair starts');throw Error('ambiguous submission');});
 const rejected=assert.rejects(second,/ambiguous/);
 const third=paid.run(async()=>{events.push('unexpected paid retry');});
 const rejectedThird=assert.rejects(third,/ambiguous/);
 await Promise.resolve();assert.deepEqual(events,['generation starts']);release();
 await Promise.all([first,rejected,rejectedThird]);
 assert.deepEqual(events,['generation starts','generation ends','repair starts']);
});

test('small statistic and negation changes still reach the LLM even with high overall recall',()=>{
 const report={severity:'minor',attempts:[{changes:[{expected:'three',heard:'four'}]}]};
 assert.equal(needsModelReview({role:'narrator',spokenText:'A lengthy narrative passage.'},report,{}),true);
 assert.equal(needsModelReview({role:'author-note',spokenText:'Thea’s Profile: Presence: unknown.'},{...report,attempts:[]},{}),true);
 assert.equal(needsModelReview({role:'narrator',spokenText:'He did not leave.'},{severity:'minor',attempts:[{changes:[{expected:'not',heard:''}]}]},{}),true);
 assert.equal(needsModelReview({role:'narrator',spokenText:'Thea said.'},{severity:'minor'}, {repair:{attempt:1}}),true);
 assert.equal(needsModelReview({role:'narrator',spokenText:'Evelyne said.'},{severity:'minor',attempts:[{changes:[{expected:'evelyne',heard:'evelyn'}]}]},{}),false);
 assert.equal(needsModelReview({role:'narrator',spokenText:'three'},{...report,ownerReview:{}},{}),false);
});

test('repair chunks preserve every source token and later attempts reduce chunk length',()=>{
 const item={customId:'s0001p0',role:'author-note',spokenText:('Strength: three point one eight, plus zero percent.\nPresence: to be determined.\n').repeat(8),request:{text:'[read profile rows] text',modelId:'inworld-tts-2',voiceId:'saved-author'}};
 const first=repairItems(item,1),second=repairItems(item,2);
 assert.ok(second.length>first.length);
 for(const pieces of [first,second]){
  assert.equal(pieces.map(p=>p.spokenText).join(' ').replace(/\s+/g,' '),item.spokenText.trim().replace(/\s+/g,' '));
  assert.ok(pieces.every(p=>p.role===item.role&&p.request.voiceId==='saved-author'&&p.request.deliveryMode==='STABLE'));
 }
 const original={chapterId:'rr-1',root:'/original'},repair={...original,root:'/original/repair'};
 const config={chapters:[original]};
 assert.equal(belongsToEntry({chapter:'rr-1'},repair,config),false);
 assert.equal(belongsToEntry({chapter:'rr-1',outputRoot:repair.root},repair,config),true);
});

test('interrupted repair promotion resumes its exact saved audio without another provider call',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-repair-test-'));
 const read=async(path,fallback)=>{try{return JSON.parse(await fs.readFile(path,'utf8'));}catch(error){if(error.code==='ENOENT'&&fallback!==undefined)return fallback;throw error;}};
 const save=async(path,value)=>{await fs.mkdir(join(path,'..'),{recursive:true});await fs.writeFile(path,JSON.stringify(value));};
 const item={customId:'s0001p0',role:'author-note',spokenText:'Presence: to be determined.',request:{text:'[read clearly] Presence: to be determined.'}};
 const original=Buffer.from('original rejected waveform'),receipt={sha256:sha(original),duration:1,requestHash:'original-request',voiceId:'female'};
 for(const dir of ['audio','receipts','review'])await fs.mkdir(join(root,dir));
 await fs.writeFile(join(root,'audio',item.customId+'.wav'),original);await save(join(root,'receipts',item.customId+'.json'),receipt);await save(join(root,'review',item.customId+'.json'),{severity:'major'});
 let calls=0,crash=true;
 const synthesize=async(entry,chapter)=>{calls++;for(const part of chapter.items){await fs.mkdir(join(entry.root,'audio'),{recursive:true});await fs.writeFile(join(entry.root,'audio',part.customId+'.wav'),'new waveform');await save(join(entry.root,'receipts',part.customId+'.json'),{sha256:sha('new waveform'),duration:1,job:'saved-operation'});}};
 const run=async(command,args)=>{if(command==='ffmpeg'){await fs.writeFile(args.at(-1),'new waveform');return '';}return '1';};
 const crashingSave=async(path,value)=>{if(path===join(root,'receipts',item.customId+'.json')&&crash){crash=false;throw Error('simulated power loss');}await save(path,value);};
 try{
  const entry={root,chapterId:'rr-1'};
  await assert.rejects(repairPassage({entry,item,config:{maxRetakes:2},read,save:crashingSave,run,synthesize,voices:{},status:async()=>{}}),/power loss/);
  assert.equal((await read(join(root,'receipts',item.customId+'.json'))).sha256,receipt.sha256);
  await recoverRepairs(entry,read,save);
  const next=await read(join(root,'receipts',item.customId+'.json'));
  assert.equal(next.sha256,sha(await fs.readFile(join(root,'audio',item.customId+'.wav'))));
  assert.equal(next.requestHash,receipt.requestHash);assert.equal(next.repair.attempt,1);assert.equal(calls,1);
  assert.deepEqual(await fs.readFile(join(root,'repairs',item.customId,'attempt-1','original.wav')),original);
  await recoverRepairs(entry,read,save);assert.equal(calls,1);
  await save(join(root,'receipts',item.customId+'.json'),{...next,repair:{attempt:2}});
  assert.equal(await repairPassage({entry,item,config:{maxRetakes:2},read,save,run,synthesize,voices:{},status:async()=>{}}),false);
  assert.equal(calls,1);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('restart publishes the saved immutable assembly without rerendering or requiring another LLM call',async()=>{
 const root=await fs.mkdtemp(join(tmpdir(),'inworld-publication-test-')),dir=join(root,'261'),bin=join(root,'bin');
 const chapter={chapterId:'rr-261',source:'source',items:[]},entry={chapterId:'rr-261',sequence:261,root:dir,inputHash:hash(chapter)};
 const write=async(path,value)=>{await fs.mkdir(join(path,'..'),{recursive:true});await fs.writeFile(path,JSON.stringify(value));};
 await write(join(dir,'input.json'),chapter);await write(join(dir,'assembly.json'),{assembly:{id:'saved-assembly',plan:'saved-plan',source:'source'},batch:'saved-batch'});
 await write(join(dir,'publication/plans/saved-plan.json'),{inputHash:entry.inputHash});
 await write(join(root,'voices.json'),{});await write(join(root,'voice-profiles.json'),{});
 await write(join(root,'queue.json'),{root,host:'test',archive:'/test',chapters:[entry],originalVoices:{},automaticRepair:true});
 await fs.mkdir(bin);
 await fs.writeFile(join(bin,'rsync'),'#!/bin/sh\nexit 0\n',{mode:0o755});
 await fs.writeFile(join(bin,'ssh'),`#!/usr/bin/env node
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{
if(input.startsWith('{'))throw Error('Unexpected provider request');
if(process.argv.join(' ').includes('audiobook-listener'))console.log(JSON.stringify({assembly:'saved-assembly',audioVerified:true,textVerified:true,rangeVerified:true}));
else if(input)console.log('{}');
});`,{mode:0o755});
 try{
  const run=spawnSync(process.execPath,[resolve('tools/inworld-batch/runner.mjs'),join(root,'queue.json')],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH},timeout:10000});
  assert.equal(run.status,0,run.stderr);
  assert.equal(JSON.parse(await fs.readFile(join(root,'status.json'),'utf8')).status,'complete',run.stdout);
  assert.equal(JSON.parse(await fs.readFile(join(dir,'published.json'),'utf8')).assembly,'saved-assembly');
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
