// Processing failures are retained without blocking the independent producer.
export class ProcessingLane {
 tail=Promise.resolve();
 errors=[];
 deferred=[];
 enqueue(id,work,onError,{shouldStart=async()=>true,onDeferred=async()=>{}}={}){
  this.tail=this.tail.then(async()=>{
   if(await shouldStart())await work();
   else{await onDeferred();this.deferred.push(id);}
  }).catch(async error=>{
   this.errors.push({chapter:id,reason:String(error.message)});
   await onError(error);
  }).catch(error=>{this.errors.push({chapter:id,reason:'Could not record processing failure: '+error.message});});
 }
 async drain(){await this.tail;return this.errors;}
}
export function steeringText(direction,text){
 const instruction=direction.toLowerCase().replace(/[\p{P}\p{S}]/gu,' ').replace(/\s+/g,' ').trim();
 if(!instruction)throw Error('Empty acting direction');
 const result=`[${instruction}] ${text}`;
 if(result.length>2000)throw Error('Direction and text too long');
 return result;
}
