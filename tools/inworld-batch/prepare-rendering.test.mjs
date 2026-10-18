import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {renderPlanSpoken,materializeChapter,buildChapter} from './prepare.mjs';
import {hash} from './core.mjs';

test('legacy plans retain exact spoken input and reject unknown opt-in policies',async()=>{
 const segments=[{uid:'one',text:'An unchanged ████ name.'}];
 assert.deepEqual(await renderPlanSpoken({segments}),{texts:segments.map(s=>s.text)});
 await assert.rejects(renderPlanSpoken({segments,spokenRendering:{policy:'other'}}),/Unknown/);
 await assert.rejects(renderPlanSpoken({segments,spokenRendering:{policy:'visual-full-block-redactions-v1',replacement:'invented'}}),/Unknown/);
});

test('existing legacy inputs stay byte-equivalent while new inputs from old plans select the pinned policy',async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),'inworld-legacy-rendering-')),plans=join(directory,'plans');await fs.mkdir(plans);
 const text='The ████ identity stays hidden.',plan={chapterId:'legacy',sequence:1,title:'Legacy',source:'source',analysis:'analysis',segments:[{uid:'body',role:'narrator',text,spans:[{start:0,end:text.length}]}],directions:[{uid:'body',instruction:'Read clearly.'}],profiles:{}};
 const config={root:directory,narratorPolicy:{gender:'female'}},legacy=buildChapter(plan,[text],config),folder=join(directory,'chapters/1');
 for(const [name,value]of Object.entries({'plan.json':plan,'source.json':{text},'analysis.json':{}}))await fs.writeFile(join(plans,name),JSON.stringify(value));
 await fs.mkdir(folder,{recursive:true});const contents=JSON.stringify(legacy,null,2)+'\n';await fs.writeFile(join(folder,'input.json'),contents);
 try{
  const saved=await materializeChapter(plans,config);
  assert.equal(saved.entry.inputHash,hash(legacy));assert.equal(await fs.readFile(join(folder,'input.json'),'utf8'),contents);
  await fs.rm(folder,{recursive:true});const fresh=await materializeChapter(plans,config);
  assert.equal(fresh.chapter.items[0].spokenText,'The redacted identity stays hidden.');assert.equal(fresh.chapter.provenance.planHash,hash(plan));
  assert.equal(fresh.chapter.provenance.spokenRendering.policy,'visual-redactions-and-overlays-v1');
  assert.deepEqual(JSON.parse(await fs.readFile(join(plans,'plan.json'),'utf8')),plan);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('new rendering changes only provider speech while canonical source and repeat materialization remain stable',async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),'inworld-rendering-')),plans=join(directory,'plans');await fs.mkdir(plans);
 const text='😀 The ████ name stayed hidden.',segment={uid:'body',role:'narrator',text,spans:[{start:0,end:text.length}]};
 const plan={chapterId:'one',sequence:1,title:'One',source:'source-hash',analysis:'analysis-hash',segments:[segment],directions:[{uid:'body',instruction:'Read clearly.'}],profiles:{},spokenRendering:{policy:'visual-full-block-redactions-v1'}};
 for(const [name,value]of Object.entries({'plan.json':plan,'source.json':{text},'analysis.json':{source:'source-hash'}}))await fs.writeFile(join(plans,name),JSON.stringify(value));
 const config={root:directory,narratorPolicy:{gender:'female'}};
 try{
  const first=await materializeChapter(plans,config),second=await materializeChapter(plans,config);
  assert.deepEqual(first,second);assert.deepEqual(first.chapter.segments[0],{...segment,items:['s0000p0'],direction:'Read clearly.'});
  assert.equal(first.chapter.items[0].spokenText,'😀 The redacted name stayed hidden.');
  assert.equal(first.chapter.provenance.planHash,hash(plan));
  assert.equal(first.chapter.provenance.spokenRendering.segments[0].rendering.sourceHash.length,64);
  assert.equal(JSON.parse(await fs.readFile(join(first.entry.root,'source.json'),'utf8')).text,text);
  const priorHash=first.entry.inputHash;
  await fs.writeFile(join(plans,'plan.json'),JSON.stringify({...plan,spokenRendering:undefined}));
  await assert.rejects(materializeChapter(plans,config),/Prepared chapter changed/);
  assert.equal(hash(JSON.parse(await fs.readFile(join(first.entry.root,'input.json'),'utf8'))),priorHash);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});


test('legacy pinned redaction inputs reproduce exact hashes while new combined input removes only styling',async()=>{
 const directory=await fs.mkdtemp(join(tmpdir(),'inworld-combined-rendering-')),plans=join(directory,'plans');await fs.mkdir(plans);
 const text='S\u0334e\u0337aled ████ E+.',plan={chapterId:'combined',sequence:1,title:'Combined',source:'source',analysis:'analysis',segments:[{uid:'body',role:'narrator',text,spans:[{start:0,end:text.length}]}],directions:[{uid:'body',instruction:'Read clearly.'}],profiles:{},spokenRendering:{policy:'visual-full-block-redactions-v1'}};
 const config={root:directory,narratorPolicy:{gender:'female'}},rendered=await renderPlanSpoken(plan,false),legacy=buildChapter(plan,rendered.texts,config,rendered.provenance),folder=join(directory,'chapters/1');
 for(const [name,value]of Object.entries({'plan.json':plan,'source.json':{text},'analysis.json':{}}))await fs.writeFile(join(plans,name),JSON.stringify(value));
 await fs.mkdir(folder,{recursive:true});const before=JSON.stringify(legacy,null,2)+'\n';await fs.writeFile(join(folder,'input.json'),before);
 try{
  const old=await materializeChapter(plans,config);assert.equal(old.entry.inputHash,hash(legacy));assert.equal(await fs.readFile(join(folder,'input.json'),'utf8'),before);
  assert.equal(old.chapter.provenance.spokenRendering.policy,'visual-full-block-redactions-v1');assert.ok(old.chapter.items[0].spokenText.includes('\u0334'));
  await fs.rm(folder,{recursive:true});const fresh=await materializeChapter(plans,config),again=await materializeChapter(plans,config);
  assert.equal(fresh.chapter.items[0].spokenText,'Sealed redacted E+.');assert.equal(fresh.chapter.provenance.spokenRendering.policy,'visual-redactions-and-overlays-v1');
  assert.equal(fresh.chapter.provenance.spokenRendering.segments[0].rendering.stages.length,2);assert.equal(fresh.entry.inputHash,again.entry.inputHash);
  assert.deepEqual(fresh.chapter.segments[0].spans,plan.segments[0].spans);assert.equal(fresh.chapter.segments[0].text,text);
 }finally{await fs.rm(directory,{recursive:true,force:true});}
});
