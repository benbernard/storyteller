import fs from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as wait} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';

export const chapterProcessingLockVersion='generation-and-qa-v1';

/** Share the chapter lock with provider-disabled recovery and owner review. */
export async function withChapterProcessingLock(root,work,{retryMilliseconds=250,waitForOwner=true,shouldAcquire=async()=>true}={}){
 const path=join(root,'owner-review.lock');
 const temporary=path+'.'+randomUUID()+'.tmp';
 let identity;
 await fs.writeFile(temporary,String(process.pid),{flag:'wx',mode:0o600});
 try{
 for(;;){
  if(!await shouldAcquire())throw Object.assign(Error('Chapter processing paused before lock acquisition'),{code:'CHAPTER_PROCESSING_PAUSED'});
  try{await fs.link(temporary,path);identity=await fs.stat(path);break;}
  catch(error){if(error.code!=='EEXIST')throw error;}
  if(!waitForOwner)throw Error('Chapter processing lock already held');
  let owner;
  try{owner=Number(await fs.readFile(path,'utf8'));}
  catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(!Number.isInteger(owner)||owner<=0)throw Error('Invalid chapter processing lock; inspect before resuming');
  try{process.kill(owner,0);}
  catch(error){if(error.code==='ESRCH')throw Error('Stale chapter processing lock; inspect before resuming');throw error;}
  await wait(retryMilliseconds);
 }
 }finally{await fs.unlink(temporary);}
 try{
  return await work();
 }finally{
  const current=await fs.stat(path);
  if(current.ino!==identity.ino||current.dev!==identity.dev)throw Error('Chapter processing lock changed ownership');
  await fs.unlink(path);
 }
}
