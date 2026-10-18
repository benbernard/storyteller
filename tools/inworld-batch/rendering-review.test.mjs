import test from 'node:test';
import assert from 'node:assert/strict';
import {hash,sha} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {renderVisualRedactions,visualRedactionPolicy} from '../audiobooks/dist/spoken-redactions.js';
import {validateRenderingContext,renderingContext} from './rendering-review.mjs';
import {buildRenderingRecoveryPlan} from './rendering-recovery.mjs';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {evidenceRow,needsModelReview} from './adjudication.mjs';

function fixture(){
 const item={customId:'s0001p0',role:'narrator',spokenText:'😀 Before ██ after. Twenty birds remain.',request:{text:'[read] 😀 Before ██ after. Twenty birds remain.'}};
 const source={text:item.spokenText,chapterId:'synthetic'};
 const chapter={chapterId:'synthetic',source:'canonical-source-id',items:[item],segments:[{text:source.text,spans:[{start:0,end:source.text.length}],items:[item.customId]}]};
 const children=['😀 Before ██ after.','Twenty birds remain.'].map((spokenText,index)=>({customId:'child'+index,role:'narrator',spokenText,request:{text:'[read] '+spokenText}}));
 const attempt2Plan={passage:item.customId,attempt:2,items:children},originalAudioSha256=sha('original-audio');
 const parts=children.map(child=>({item:child,audioSha256:sha(child.customId),receipt:{sha256:sha(child.customId),job:'original-job',voiceId:'saved-female',requestHash:hash({...child.request,voiceId:'saved-female'}),duration:1}}));
 const originalReceipt={sha256:originalAudioSha256,voiceId:'saved-female',requestHash:hash({...item.request,voiceId:'saved-female'}),repair:{attempt:2,planHash:hash(attempt2Plan),parts:parts.map(part=>({id:part.item.customId,sha256:part.audioSha256,job:part.receipt.job}))}};
 const plan=buildRenderingRecoveryPlan({entry:{chapterId:chapter.chapterId,inputHash:hash(chapter)},chapter,item,source,receipt:originalReceipt,attempt2Plan,parts,render:renderVisualRedactions,verify:(source,proof)=>proof});
 const receipt={...originalReceipt,sha256:sha('repaired-audio'),renderingRecovery:{schemaVersion:1,
  rendererVersion:visualRedactionPolicy,planPath:`rendering-recoveries/${visualRedactionPolicy}/${item.customId}/plan.json`,
  planHash:fingerprint(plan),inputHash:hash(chapter),sourceHash:chapter.source,originalItemHash:hash(item),
  previousSha256:originalAudioSha256,renderingProof:plan.renderingProof,audioSha256:sha('repaired-audio')}};
 return {chapter,item,receipt,plan,source,originalReceipt,attempt2Plan,originalAudioSha256,parts};
}

test('verified redaction audio compares rendered words while original expected and source remain immutable',()=>{
 const data=fixture(),before=JSON.stringify(data),context=validateRenderingContext(data);
 assert.equal(context.comparisonExpected,'😀 Before redacted after. Twenty birds remain.');
 assert.equal(JSON.stringify(data),before);
 const redaction=context.renderingProof.mapping.find(value=>value.kind==='redaction');
 assert.equal(redaction.sourceStart,10); // Emoji occupies two UTF-16 units.
 const report={sha256:data.receipt.sha256,expected:data.item.spokenText,attempts:[],severity:'pass',comparisonExpected:context.comparisonExpected,renderingContext:context};
 const row=evidenceRow(data.item,report,{audioSha256:report.sha256,phonemes:'independent',inputPrompt:null},[],context);
 assert.equal(row.expected,data.item.spokenText);assert.equal(row.comparisonExpected,context.comparisonExpected);
 assert.equal(needsModelReview(data.item,report,data.receipt),true);
});

test('comparison text cannot waive other words or use a proof from another audio',()=>{
 const data=fixture(),context=validateRenderingContext(data);
 const report={sha256:data.receipt.sha256,expected:data.item.spokenText,attempts:[],comparisonExpected:'redacted',renderingContext:context};
 const phoneme={audioSha256:report.sha256,phonemes:'independent',inputPrompt:null};
 assert.throws(()=>evidenceRow(data.item,report,phoneme,[],context),/Unbound/);
 report.comparisonExpected=context.comparisonExpected;
 assert.throws(()=>evidenceRow(data.item,report,phoneme,[]),/verified recovery/);
 assert.throws(()=>evidenceRow(data.item,report,phoneme,[],{...context,audioSha256:sha('different')}),/Unbound/);
});

test('policy proof rejects edits outside FULL BLOCK runs and incorrect UTF16 mapping even with new fingerprint',()=>{
 for(const change of ['ordinary-word','offset','single-block']){
  const data=fixture();
  if(change==='ordinary-word')data.receipt.renderingRecovery.renderingProof.text='😀 Before redacted after. Nineteen birds remain.';
  else if(change==='offset')data.receipt.renderingRecovery.renderingProof.mapping[1].sourceStart--;
  else data.item.spokenText=data.item.spokenText.replace('██','█');
  const proof=data.receipt.renderingRecovery.renderingProof;
  proof.spokenHash=sha(proof.text);const {fingerprint:prior,...content}=proof;proof.fingerprint=fingerprint(content);
  data.plan.renderingProof=proof;data.receipt.renderingRecovery.planHash=fingerprint(data.plan);
  if(change==='single-block'){data.plan.originalItemHash=hash(data.item);data.receipt.renderingRecovery.originalItemHash=hash(data.item);data.plan.inputHash=hash(data.chapter);data.receipt.renderingRecovery.inputHash=hash(data.chapter);data.receipt.renderingRecovery.planHash=fingerprint(data.plan);}
  assert.throws(()=>validateRenderingContext(data));
 }
});

test('retained source, receipt, plan and audio fingerprints are all required',()=>{
 const edits=[d=>d.source.text+=' extra',d=>d.originalReceipt.sha256=sha('altered'),d=>d.originalAudioSha256=sha('altered'),
  d=>d.attempt2Plan.items=[],d=>d.plan.canonicalTextSha256=sha('altered'),d=>d.receipt.sha256=sha('altered'),
  d=>d.receipt.renderingRecovery.planPath='../outside.json',d=>d.receipt.repair.attempt=3,d=>delete d.receipt.renderingRecovery];
 for(const edit of edits){const data=fixture();edit(data);assert.throws(()=>validateRenderingContext(data));}
});

async function diskFixture(){
 const data=fixture(),root=await fs.mkdtemp(join(tmpdir(),'rendering-proof-'));
 const write=async(path,value)=>{const target=join(root,path);await fs.mkdir(dirname(target),{recursive:true});await fs.writeFile(target,typeof value==='string'?value:JSON.stringify(value));};
 await write('input.json',data.chapter);await write('source.json',data.source);
 const base=`rendering-recoveries/${visualRedactionPolicy}/${data.item.customId}`;
 await write(base+'/plan.json',data.plan);await write(base+'/original-receipt.json',data.originalReceipt);
 await write(base+'/attempt2-plan.json',data.attempt2Plan);await write(base+'/original.wav','original-audio');
 await write(`repairs/${data.item.customId}/attempt-2/plan.json`,data.attempt2Plan);
 const final=[];
 for(const [index,part]of data.plan.parts.entries()){
  const original=data.parts[index],originalRoot=`repairs/${data.item.customId}/attempt-2`;
  await write(originalRoot+'/receipts/'+original.item.customId+'.json',original.receipt);
  await write(originalRoot+'/audio/'+original.item.customId+'.wav',original.item.customId);
  const bytes='new-'+part.id;
  const proof=part.reused?original.receipt:{sha256:sha(bytes),voiceId:'saved-female',requestHash:hash({...part.replacement.request,voiceId:'saved-female'}),job:'recovery-job',duration:1};
  if(!part.reused){await write(part.root+'/audio/'+part.id+'.wav',bytes);await write(part.root+'/receipts/'+part.id+'.json',proof);}
  final.push({id:part.id,root:part.root,sha256:proof.sha256,job:proof.job,reused:part.reused});
 }
 data.receipt.renderingRecovery.parts=final;
 await write('audio/'+data.item.customId+'.wav','repaired-audio');await write('receipts/'+data.item.customId+'.json',data.receipt);
 return {data,root,write,base};
}

test('filesystem proof validates child requests, immutable source and final audio, with tampering held',async()=>{
 const mutations=[null,'child-request','current-audio','retained-audio','source-ranges','copy-plan'];
 for(const mutation of mutations){
  const {data,root,write,base}=await diskFixture();
  try{
   if(mutation==='child-request'){
    const part=data.plan.parts.find(value=>!value.reused),path=part.root+'/receipts/'+part.id+'.json';
    const proof=JSON.parse(await fs.readFile(join(root,path),'utf8'));proof.requestHash=sha('other-words');await write(path,proof);
   }else if(mutation==='current-audio')await write('audio/'+data.item.customId+'.wav','different');
   else if(mutation==='retained-audio')await write(base+'/original.wav','different');
   else if(mutation==='copy-plan')await write(base+'/attempt2-plan.json',{...data.attempt2Plan,attempt:1});
   else if(mutation==='source-ranges'){
    data.plan.sourceRanges[0].sourceStart--;data.receipt.renderingRecovery.planHash=fingerprint(data.plan);
    await write(base+'/plan.json',data.plan);await write('receipts/'+data.item.customId+'.json',data.receipt);
   }
   if(mutation)await assert.rejects(renderingContext(root,data.item));
   else{const context=await renderingContext(root,data.item);assert.equal(context.comparisonExpected,'😀 Before redacted after. Twenty birds remain.');}
  }finally{await fs.rm(root,{recursive:true,force:true});}
 }
});
