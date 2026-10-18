import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// The local speech service owns GPU arbitration. Never stop or steal its work.
async function withOwnedReview({call, command, args=[], renewMs=30000, killMs=3000, device='gpu'},state={started:false}) {
 const owner=randomUUID();
 try{await call('/v1/lease',{owner,seconds:120},owner);}
 catch(error){throw Object.assign(error,{code:'GPU_REVIEW_UNAVAILABLE'});}
 let child, timer, killTimer, renewal, failure, closing=false;
 const signal=name=>{if(child?.pid)try{process.kill(-child.pid,name);}catch(error){if(error.code!=='ESRCH')throw error;}};
 const stop=()=>{
  failure??=Error('GPU review interrupted');signal('SIGTERM');
  if(!killTimer){killTimer=setTimeout(()=>signal('SIGKILL'),killMs);killTimer.unref();}
 };
 const groupAlive=()=>{
  if(!child?.pid)return false;
  try{process.kill(-child.pid,0);return true;}catch(error){if(error.code==='ESRCH')return false;throw error;}
 };
 const drainGroup=async()=>{
  if(!groupAlive())return;
  stop();const deadline=Date.now()+killMs+5000;
  while(groupAlive()){
   if(Date.now()>deadline)throw Error('GPU review process group has not exited; lease was not released');
   await new Promise(done=>setTimeout(done,25));
  }
 };
 try {
  const status=await call('/v1/status',undefined,owner);
  if(status.active || status.queued)throw Object.assign(Error('Local GPU has active or queued work'),{code:'GPU_REVIEW_UNAVAILABLE'});
  const env={...process.env,INWORLD_REVIEW_DEVICE:device};
  if(device==='gpu')env.INWORLD_REVIEW_GPU_LEASE='1';else delete env.INWORLD_REVIEW_GPU_LEASE;
  child=spawn(command,args,{stdio:'inherit',detached:true,env});
  state.started=true;
  const finished=new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,sig)=>done({code,sig}));});
  process.on('SIGINT',stop);process.on('SIGTERM',stop);
  timer=setInterval(()=>{
   if(renewal || closing)return;
   renewal=call('/v1/lease',{owner,seconds:120},owner).catch(()=>{
    failure=Error('GPU lease renewal failed; review stopped');stop();
   }).finally(()=>{renewal=undefined;});
  },renewMs);
  const result=await finished;
  if(failure)throw failure;
  if(result.code!==0)throw Error('GPU review failed '+(result.code??result.sig));
 } finally {
  closing=true;clearInterval(timer);
  try{
   if(renewal)await renewal;
   try{await drainGroup();}finally{clearTimeout(killTimer);}
   await call('/v1/lease/release',{owner},owner);
   if(failure)throw failure;
  }finally{
   process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  }
 }
}

export async function withReviewGpu(options){return await withOwnedReview(options);}

/** Fall back only before a GPU child starts, never after partial GPU work. */
export async function withAutomaticReview(options){
 const state={started:false};
 try{return await withOwnedReview(options,state);}
 catch(error){
  if(error.code!=='GPU_REVIEW_UNAVAILABLE'||state.started)throw error;
  return await withOwnedReview({...options,device:'cpu',call:async()=>({})});
 }
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {
  const [credentialPath,...rest]=process.argv.slice(2),automatic=rest[0]==='--auto';
  if(automatic)rest.shift();
  const [separator,command,...args]=rest;
  if(!credentialPath || separator!=='--' || !command)throw Error('Usage: review-gpu.mjs CREDENTIAL_JSON [--auto] -- COMMAND [ARGS]');
  let credential=JSON.parse(await fs.readFile(credentialPath,'utf8'));
  if(Array.isArray(credential))credential={endpoint:'http://127.0.0.1:8788',token:credential[0]?.token};
  const endpoint=new URL(credential.endpoint);
  if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || !['http:','https:'].includes(endpoint.protocol) || !credential.token)throw Error('Expected local speech-service credential');
  const call=async(path,payload,owner)=>{
   const response=await fetch(new URL(path,endpoint),{method:payload===undefined?'GET':'POST',headers:{Authorization:'Bearer '+credential.token,'Content-Type':'application/json','X-Worker-Lease':owner},...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw Error('Local GPU lease request refused HTTP '+response.status);
   return response.json();
  };
  await (automatic?withAutomaticReview:withReviewGpu)({call,command,args});
 } catch(error) {console.error(error.message);process.exitCode=1;}
}
