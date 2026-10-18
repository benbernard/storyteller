import fs from 'node:fs/promises';
import {join} from 'node:path';
import {hash,sha} from './core.mjs';
import {repairItems} from './adjudication.mjs';

export async function installPromotion(entry, directory, promotion, save) {
 const target=join(entry.root,'audio',promotion.passage+'.wav');
 const receiptPath=join(entry.root,'receipts',promotion.passage+'.json');
 const audio=await fs.readFile(join(directory,'replacement.wav'));
 if(sha(audio)!==promotion.receipt.sha256)throw Error('Repair promotion audio changed');
 const current=sha(await fs.readFile(target));
 if(![promotion.previousSha256,promotion.receipt.sha256].includes(current))throw Error('Repair target changed');
 // Recovery can finish an interrupted audio/receipt pair without another paid call.
 const temporary=target+'.repair.tmp';await fs.writeFile(temporary,audio);await fs.rename(temporary,target);
 await save(receiptPath,promotion.receipt);
 await save(join(directory,'promotion.json'),{...promotion,state:'complete'});
}

export async function recoverRepairs(entry,read,save) {
 let ids;
 try{ids=await fs.readdir(join(entry.root,'repairs'));}catch(error){if(error.code==='ENOENT')return;throw error;}
 for(const id of ids)for(const attempt of await fs.readdir(join(entry.root,'repairs',id))){
  const directory=join(entry.root,'repairs',id,attempt);
  const promotion=await read(join(directory,'promotion.json'),null);
  if(promotion?.state==='prepared')await installPromotion(entry,directory,promotion,save);
 }
}

export async function repairPassage({entry,item,config,read,save,run,synthesize,voices,status}) {
 const receipt=await read(join(entry.root,'receipts',item.customId+'.json'));
 const attempt=(receipt.repair?.attempt??0)+1;
 if(attempt>config.maxRetakes)return false;
 const directory=join(entry.root,'repairs',item.customId,'attempt-'+attempt);
 const planPath=join(directory,'plan.json');
 let plan=await read(planPath,null);
 if(!plan){
  plan={passage:item.customId,originalSha256:receipt.sha256,originalRequestHash:receipt.requestHash,attempt,items:repairItems(item,attempt)};
  await save(planPath,plan);
 }
 if(plan.originalSha256!==receipt.sha256||plan.originalRequestHash!==receipt.requestHash)throw Error('Repair plan no longer matches original');
 const repairEntry={...entry,root:directory};
 await status({stage:'repairing-passage',passage:item.customId,attempt});
 await synthesize(repairEntry,{items:plan.items},voices);
 const files=[],parts=[];let duration=0;
 for(const part of plan.items){
  const proof=await read(join(directory,'receipts',part.customId+'.json'));
  const file=join(directory,'audio',part.customId+'.wav');
  if(sha(await fs.readFile(file))!==proof.sha256)throw Error('Repair clip checksum mismatch');
  files.push(file);parts.push({id:part.customId,sha256:proof.sha256,job:proof.job});duration+=proof.duration;
 }
 if(files.some(p=>p.includes("'")))throw Error('Unsupported quote in repair path');
 const list=join(directory,'concat.txt');await fs.writeFile(list,files.map(p=>`file '${p}'`).join('\n'));
 const replacement=join(directory,'replacement.wav');
 await run('ffmpeg',['-v','error','-y','-f','concat','-safe','0','-i',list,'-ar','48000','-ac','1','-c:a','pcm_s16le',replacement]);
 const measured=Number((await run('ffprobe',['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',replacement])).trim());
 if(!Number.isFinite(measured)||Math.abs(measured-duration)>.1)throw Error('Repair duration mismatch');
 // Preserve the rejected recording and its evidence before atomic promotion.
 await fs.copyFile(join(entry.root,'audio',item.customId+'.wav'),join(directory,'original.wav'));
 await save(join(directory,'original-receipt.json'),receipt);
 await save(join(directory,'original-review.json'),await read(join(entry.root,'review',item.customId+'.json')));
 const next={...receipt,sha256:sha(await fs.readFile(replacement)),duration:measured,
  repair:{attempt,planHash:hash(plan),parts,previousSha256:receipt.sha256}};
 const promotion={state:'prepared',passage:item.customId,previousSha256:receipt.sha256,receipt:next};
 await save(join(directory,'promotion.json'),promotion);
 await installPromotion(entry,directory,promotion,save);
 return true;
}
