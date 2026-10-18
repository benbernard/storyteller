/** Explicit, one-child recovery of a proven historical decimal formatter bug. */
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {hash,sha} from './core.mjs';
import {fingerprint} from '../audiobooks/dist/store.js';
import {installPromotion} from './repair.mjs';
import {baseRenderingContext,renderingContext} from './rendering-review.mjs';
import {validateDecimalDiagnosis} from './decimal-diagnosis.mjs';
import {validateDecimalContext} from './decimal-review.mjs';
import {decodePCM16} from './pcm-excision-core.mjs';
import {decimalPolicy,validateDecimalManifest,buildDecimalRecoveryPlan,decimalReceipt,correctedDecimalFormatterSha,historicalDecimalFormatterSha} from './decimal-plan.mjs';
const here=dirname(fileURLToPath(import.meta.url)),fail=message=>{throw Error('Decimal recovery: '+message);};
const directory=(entry,item)=>join(entry.root,'rendering-recoveries',decimalPolicy,item.customId);
async function exists(path){try{await fs.access(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
export async function loadDecimalManifest(path,reviewedHash){
 const manifest=validateDecimalManifest(JSON.parse(await fs.readFile(path,'utf8')));
 if(!/^[a-f0-9]{64}$/.test(reviewedHash??'')||fingerprint(manifest)!==reviewedHash)fail('reviewed manifest changed');return manifest;
}
async function childrenFor(entry,basePlan,attempt2Plan,read){
 const children=[];for(const [index,part]of basePlan.parts.entries()){
  const item=part.replacement??attempt2Plan.items[index],receipt=await read(join(entry.root,part.root,'receipts',part.id+'.json'));
  const audio=await fs.readFile(join(entry.root,part.root,'audio',part.id+'.wav'));children.push({item,root:part.root,receipt,audioSha256:sha(audio),audio});
 }return children;
}
async function finalChildren(entry,plan,voices,read){
 const parts=[],files=[],rows=[];let duration=0;
 for(const part of plan.parts){
  const receipt=await read(join(entry.root,part.root,'receipts',part.id+'.json')),item=part.replacement??part.baseItem,file=join(entry.root,part.root,'audio',part.id+'.wav');
  if(!Number.isFinite(receipt.duration)||receipt.duration<=0||sha(await fs.readFile(file))!==receipt.sha256||receipt.voiceId!==voices[item.role]?.voiceId||receipt.requestHash!==hash({...item.request,voiceId:voices[item.role]?.voiceId})
   ||part.reused&&(receipt.sha256!==part.baseAudioSha256||fingerprint(receipt)!==part.baseReceiptHash))fail('retained or replacement child changed');
  files.push(file);rows.push({id:part.id,root:part.root,receipt,audio:await fs.readFile(file)});duration+=receipt.duration;parts.push({id:part.id,root:part.root,sha256:receipt.sha256,job:receipt.job,reused:part.reused});
 }return {parts,files,duration,rows};
}
async function exactSaved(path,expected,read,save){const prior=await read(path,null);if(prior&&fingerprint(prior)!==fingerprint(expected))fail('retained evidence changed');if(!prior)await save(path,expected);}
async function verifyFormatters(manifest){
 // Verify the pinned corrected formatter agrees with the finite pure policy;
 // no source or queued input is rewritten, and only the selected field is run.
 if(sha(await fs.readFile(join(here,'normalization/speech_parts_v1.py')))!==historicalDecimalFormatterSha||sha(await fs.readFile(join(here,'../mac-tts/acting-auditions/speech_parts.py')))!==correctedDecimalFormatterSha)fail('corrected formatter differs from reviewed version');
 const historical=spawnSync('python3',['-c',"import json,sys; sys.path.insert(0,sys.argv[1]); from speech_parts_v1 import speakable_text; source=json.load(sys.stdin); print(json.dumps(speakable_text('Weight: '+source+' (+0%).').split(' ,')[0].removeprefix('Weight: ')))",join(here,'normalization')],{input:JSON.stringify(manifest.normalization.source),encoding:'utf8'});
 if(historical.status!==0||JSON.parse(historical.stdout)!==manifest.normalization.legacy)fail('historical formatter does not reproduce the exact malformed field');
 const normalized=spawnSync('python3',[join(here,'normalize.py')],{input:JSON.stringify([manifest.normalization.source]),encoding:'utf8'});
 if(normalized.status!==0||JSON.stringify(JSON.parse(normalized.stdout))!==JSON.stringify([manifest.normalization.text]))fail('corrected formatter does not reproduce the proposed decimal');
}
export async function preflightDecimalRecovery({entry,chapter,config,voices,read,manifest}){
 validateDecimalManifest(manifest);await verifyFormatters(manifest);
 if(hash(chapter)!==entry.inputHash||manifest.chapterId!==entry.chapterId||config.maxRetakes!==2)fail('immutable chapter and original cap required');
 const state=await read(join(entry.root,'processing.json'),{}),item=chapter.items.find(i=>i.customId===manifest.passage);
 if(!item||state.status!=='needs-review'||!state.passages?.includes(item.customId)||await exists(join(entry.root,'assembly.json'))||await exists(join(entry.root,'published.json')))fail('selected passage must be held and unpublished');
 const dir=directory(entry,item),pin=await read(join(entry.root,'rendering-recoveries',decimalPolicy,'manifest.json'),null),savedManifest=await read(join(dir,'manifest.json'),null);
 for(const prior of [pin,savedManifest])if(prior&&fingerprint(prior)!==fingerprint(manifest))fail('chapter allowance belongs to another manifest');
 const current=await read(join(entry.root,'receipts',item.customId+'.json')),savedBase=await read(join(dir,'base-receipt.json'),null),baseReceipt=savedBase??current;
 if(current.decimalRecovery&&!savedBase||baseReceipt.decimalRecovery||fingerprint(baseReceipt)!==manifest.baseReceiptHash||baseReceipt.sha256!==manifest.baseAudioSha256)fail('original notation base changed');
 const basePath=await exists(join(dir,'base.wav'))?join(dir,'base.wav'):join(entry.root,'audio',item.customId+'.wav');
 if(sha(await fs.readFile(basePath))!==baseReceipt.sha256)fail('notation base audio changed');
 // The full historical source replay, notation manifest and every base child
 // are verified before this helper can reserve or submit even one new item.
 const baseContext=await baseRenderingContext(entry.root,item,baseReceipt,basePath);
 const basePlan=await read(join(entry.root,'rendering-recoveries','source-numeric-notation-v1',item.customId,'plan.json')),attempt2Plan=await read(join(entry.root,'repairs',item.customId,'attempt-2','plan.json')),source=await read(join(entry.root,'source.json'));
 const children=await childrenFor(entry,basePlan,attempt2Plan,read);
 if(!Buffer.concat(children.map(c=>decodePCM16(c.audio).pcm)).equals(decodePCM16(await fs.readFile(basePath)).pcm))fail('base parent PCM differs from the complete current child concatenation');
 const plan=buildDecimalRecoveryPlan({chapter,item,source,baseReceipt,baseContext,basePlan,attempt2Plan,children,manifest});
 const report=await read(join(dir,'original-review.json'),null)??await read(join(entry.root,'review',item.customId+'.json')),decision=await read(join(dir,'original-decision.json'),null)??(await read(join(entry.root,'llm-decisions.json')))[item.customId];
 validateDecimalDiagnosis({manifest,report,decision,item,baseReceipt,audio:children.find(c=>c.item.customId===manifest.originalChild)?.audio});
 for(const [file,value]of [['plan.json',plan],['base-context.json',baseContext],['base-plan.json',basePlan],['attempt2-plan.json',attempt2Plan]]){
  const prior=await read(join(dir,file),null);if(prior&&fingerprint(prior)!==fingerprint(value))fail('saved plan or base proof changed');
 }
 if(baseReceipt.voiceId!==voices[item.role]?.voiceId||baseReceipt.requestHash!==hash({...item.request,voiceId:voices[item.role]?.voiceId}))fail('saved parent voice changed');
 const actualSha=sha(await fs.readFile(join(entry.root,'audio',item.customId+'.wav'))),promotion=await read(join(dir,'promotion.json'),null);
 if(current.decimalRecovery){if(!pin||!savedManifest||!promotion||!['prepared','complete'].includes(promotion.state)||fingerprint(promotion.receipt)!==fingerprint(current)||promotion.previousSha256!==baseReceipt.sha256||promotion.passage!==item.customId)fail('completed chapter manifest or promotion missing');await renderingContext(entry.root,item);}
 else if(promotion){
  if(promotion.state!=='prepared'||promotion.passage!==item.customId||promotion.previousSha256!==baseReceipt.sha256||![baseReceipt.sha256,promotion.receipt?.sha256].includes(actualSha)||sha(await fs.readFile(join(dir,'replacement.wav')))!==promotion.receipt?.sha256)fail('prepared promotion changed');
  const final=await finalChildren(entry,plan,voices,read),expected=decimalReceipt(baseReceipt,plan,{audioSha256:promotion.receipt.sha256,duration:promotion.receipt.duration,parts:final.parts});
  if(fingerprint(expected)!==fingerprint(promotion.receipt)||Math.abs(final.duration-expected.duration)>.1)fail('prepared receipt or children changed');
  validateDecimalContext({chapter,item,source,receipt:promotion.receipt,plan,baseReceipt,baseContext,basePlan,attempt2Plan,children,manifest,report,decision,baseAudio:await fs.readFile(basePath),finalChildren:final.rows,currentAudio:await fs.readFile(join(dir,'replacement.wav'))});
 }else if(fingerprint(current)!==fingerprint(baseReceipt)||actualSha!==baseReceipt.sha256)fail('unpromoted parent changed');
 return {item,plan,baseReceipt,baseContext,basePlan,attempt2Plan,current,promotion,children,source,report,decision};
}
export async function recoverDecimalPassage(args){
 const {entry,chapter,config,voices,read,save,run,synthesize,status,manifest}=args;
 const checked=await preflightDecimalRecovery(args),{item,plan,baseReceipt,baseContext,basePlan,attempt2Plan,current,promotion,children,source,report,decision}=checked,dir=directory(entry,item);
 if(current.decimalRecovery){if(promotion.state==='prepared')await save(join(dir,'promotion.json'),{...promotion,state:'complete'});return false;}
 await fs.mkdir(dir,{recursive:true});
 await exactSaved(join(entry.root,'rendering-recoveries',decimalPolicy,'manifest.json'),manifest,read,save);
 for(const [file,value]of [['manifest.json',manifest],['plan.json',plan],['base-receipt.json',baseReceipt],['base-context.json',baseContext],['base-plan.json',basePlan],['attempt2-plan.json',attempt2Plan],['original-review.json',report],['original-decision.json',decision]])await exactSaved(join(dir,file),value,read,save);
 try{await fs.copyFile(join(entry.root,'audio',item.customId+'.wav'),join(dir,'base.wav'),constants.COPYFILE_EXCL);}catch(e){if(e.code!=='EEXIST')throw e;}
 if(sha(await fs.readFile(join(dir,'base.wav')))!==baseReceipt.sha256)fail('retained base audio changed');
 if(promotion){await installPromotion(entry,dir,promotion,save);return true;}
 await status({stage:'recovering-legacy-decimal',passage:item.customId,reused:12,replaced:1});
 await synthesize({...entry,root:join(dir,'generated')},{items:plan.parts.filter(p=>!p.reused).map(p=>p.replacement)},voices,{maxSubmissionsPerItem:1});
 const final=await finalChildren(entry,plan,voices,read);if(final.files.some(p=>p.includes("'")))fail('unsupported media path');
 const list=join(dir,'concat.txt'),replacement=join(dir,'replacement.wav');await fs.writeFile(list,final.files.map(p=>`file '${p}'`).join('\n'));
 await run('ffmpeg',['-v','error','-y','-f','concat','-safe','0','-i',list,'-ar','48000','-ac','1','-c:a','pcm_s16le',replacement]);
 const duration=Number((await run('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',replacement])).trim());if(!Number.isFinite(duration)||Math.abs(duration-final.duration)>.1)fail('replacement duration differs from all child evidence');
 const next=decimalReceipt(baseReceipt,plan,{audioSha256:sha(await fs.readFile(replacement)),duration,parts:final.parts}),pending={state:'prepared',passage:item.customId,previousSha256:baseReceipt.sha256,receipt:next};
 validateDecimalContext({chapter,item,source,receipt:next,plan,baseReceipt,baseContext,basePlan,attempt2Plan,children,manifest,report,decision,baseAudio:await fs.readFile(join(dir,'base.wav')),finalChildren:final.rows,currentAudio:await fs.readFile(replacement)});
 await save(join(dir,'promotion.json'),pending);await installPromotion(entry,dir,pending,save);return true;
}
