export function batchWindowSize(value=3){
 if(!Number.isInteger(value)||value<1||value>3)throw Error('In-flight batch limit must be an integer from 1 to 3');
 return value;
}
const explicitRejections=new Set([400,401,402,403,404,405,413,415,422,429]);
export function explicitProviderRejection(response){
 const previews=Array.isArray(response?.body?.previewVoices)?response.body.previewVoices:[];
 return explicitRejections.has(response?.status)&&![response?.body,response?.body?.operation,...previews].some(value=>value?.name||value?.voiceId);
}
export function classifyBatchResponse(response){
 const operation=[response?.body?.operation,response?.body].find(value=>typeof value?.name==='string'&&value.name.trim());
 if(operation)return {state:'accepted',operation,hold:!(response.status>=200&&response.status<300)};
 return {state:explicitProviderRejection(response)?'rejected':'uncertain'};
}
export function providerBlockingCodes(job){
 return [...new Set((job.results?.results??[]).map(result=>Number(result.error?.code)).filter(code=>[7,8,16].includes(code)))];
}

/** One ledger writer submits sequentially; provider operations execute concurrently. */
export async function runBatchWindow(groups,{submit,finish,shouldPause=async()=>false,checkpoint=async()=>{}}){
 const accepted=[];let paused=false,failure;
 for(const group of groups){
  try{
   if(await shouldPause()){paused=true;break;}
   const job=await submit(group);accepted.push(job);await checkpoint(job);
  }catch(error){if(error.acceptedJob)accepted.push(error.acceptedJob);failure=error;break;}
 }
 for(const job of accepted){try{await finish(job);}catch(error){failure??=error;}}
 if(failure)throw failure;
 return !paused;
}

/** Uncertainty blocks new payments but never hides already-known operations. */
export async function reconcileBatchJobs(jobs,finish){
 let failure;
 for(const job of jobs){
  if(job.terminalBlockingError||providerBlockingCodes(job).length)failure??=Error('Batch item credit/quota/access error; retained operation requires owner resolution');
  if(job.submissionBlockingError)failure??=Error('Ambiguous batch response requires inspection; operation retained');
  if(job.phase==='rejected'&&classifyBatchResponse(job.rejection??job.submissionResponse).state!=='rejected')failure??=Error('Ambiguous historical batch rejection requires inspection; submission evidence retained');
  if(job.phase==='submitting'){failure??=Error('Ambiguous submission: inspect batch operations before resuming');continue;}
  if(job.phase==='failed'){failure??=Error('Previously failed operation needs inspection');continue;}
  if(['complete','rejected'].includes(job.phase))continue;
  try{if(!job.operation?.name)throw Error('Ambiguous batch operation evidence; inspection required');await finish(job);}catch(error){failure??=error;}
 }
 if(failure)throw failure;
}
