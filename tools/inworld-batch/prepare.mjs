/** Convert validated attribution and directions into provider batches without speech calls. */
import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {hash,validateCoverage} from './core.mjs';
import {steeringText} from './pipeline.mjs';
const here=dirname(fileURLToPath(import.meta.url));
export function buildChapter(plan, spoken, config) {
 if(spoken.length!==plan.segments.length)throw Error('Normalization omitted segments');
 const byUid=new Map(plan.directions.map(d=>[d.uid,d]));
 if(byUid.size!==plan.segments.length)throw Error('Directions do not cover the plan');
 const segments=[],items=[];
 for(const [i,s]of plan.segments.entries()){
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(s.role)||Object.hasOwn(Object.prototype,s.role))throw Error('Unsafe speaker');
  const d=byUid.get(s.uid);if(!d?.instruction)throw Error('Missing direction');
  let remaining=spoken[i];
  for(const name of config.acronyms??[])remaining=remaining.replace(new RegExp('\\b'+name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'\\b','g'),name.split('').join(' '));
  for(const [from,to]of Object.entries(config.pronunciations??{}))remaining=remaining.replaceAll(from,to);
  const chunks=[];
  while(remaining.length>1450){let at=remaining.lastIndexOf(' ',1450);if(at<700)at=1450;
   if(/[\uD800-\uDBFF]/.test(remaining[at-1]))at--;chunks.push(remaining.slice(0,at));remaining=remaining.slice(at).trimStart();}
  if(remaining)chunks.push(remaining);
  const indices=[];
  for(const [part,text]of chunks.entries()){
   if(!/[\p{L}\p{N}]/u.test(text.replace(/<[^>]*>/g,'')))continue;
   const customId=`s${String(i).padStart(4,'0')}p${part}`,content=steeringText(d.instruction,text);
   const previous=items.slice(-5).map(v=>({text:v.spokenText}));while(previous.reduce((n,x)=>n+x.text.length,0)>1800)previous.shift();
   const deliveryMode=/profile|statistic|attribute|table/i.test(d.instruction)?'STABLE':['narrator','author-note'].includes(s.role)?'BALANCED':'CREATIVE';
   items.push({customId,role:s.role,spokenText:text,request:{text:content,modelId:'inworld-tts-2',audioConfig:{audioEncoding:'WAV',sampleRateHertz:48000,speakingRate:1},language:'en-US',deliveryMode,applyTextNormalization:'ON',...(previous.length?{synthesisContext:{previousRequests:previous}}:{})}});
   indices.push(customId);
  }
  segments.push({...s,items:indices,direction:d.instruction});
 }
 return {chapterId:plan.chapterId,sequence:plan.sequence,title:plan.title,source:plan.source,analysis:plan.analysis,segments,items,provenance:{planHash:hash(plan),narratorPolicy:config.narratorPolicy}};
}
export async function materializeChapter(planRoot, config) {
 const read=async path=>JSON.parse(await fs.readFile(join(planRoot,path),'utf8'));
 const plan=await read('plan.json'),source=await read('source.json');
 validateCoverage(plan.segments,source.text);
 const normalization=spawnSync('python3',[join(here,'normalize.py')],{input:JSON.stringify(plan.segments.map(s=>s.text)),encoding:'utf8',maxBuffer:8e6});
 if(normalization.status!==0)throw Error('Normalization failed: '+normalization.stderr);
 const chapter=buildChapter(plan,JSON.parse(normalization.stdout),config),root=join(config.root,'chapters',String(chapter.sequence));
 await fs.mkdir(root,{recursive:true,mode:0o700});
 const save=async(name,value)=>{const path=join(root,name),contents=JSON.stringify(value,null,2)+'\n';
  try{const old=JSON.parse(await fs.readFile(path,'utf8'));if(hash(old)!==hash(value))throw Error('Prepared chapter changed: '+name);}
  catch(error){if(error.code!=='ENOENT')throw error;await fs.writeFile(path,contents,{flag:'wx',mode:0o600});}};
 await save('input.json',chapter);await save('source.json',source);await save('analysis.json',await read('analysis.json'));
 return {chapter,entry:{chapterId:chapter.chapterId,sequence:chapter.sequence,title:chapter.title,root,inputHash:hash(chapter)},profiles:plan.profiles};
}
