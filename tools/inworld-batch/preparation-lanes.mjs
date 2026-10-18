/** Keep character discovery ordered while independent direction workers overlap. */
export async function prepareConcurrently(chapterIds, work, concurrency=2) {
 if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error('Direction concurrency must be between 1 and 4');
 const active=new Set(),all=[];let failure;
 try{
  for(const id of chapterIds){
   if(failure)throw failure;
   await work.attribute(id);
   while(active.size>=concurrency){await Promise.race(active);if(failure)throw failure;}
   let task;
   task=(async()=>{await work.direct(id);await work.ready();})().catch(error=>{failure??=error;}).finally(()=>active.delete(task));
   active.add(task);all.push(task);
  }
 }catch(error){failure??=error;}
 await Promise.all(all);
 if(failure)throw failure;
 await work.ready();
}
