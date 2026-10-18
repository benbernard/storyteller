// Processing failures are retained without blocking the independent producer.
export class ProcessingLane {
 tail=Promise.resolve();
 errors=[];
 enqueue(id,work,onError){
  this.tail=this.tail.then(work).catch(async error=>{
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
