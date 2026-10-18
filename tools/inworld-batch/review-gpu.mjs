import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// The local speech service owns GPU arbitration. Never stop or steal its work.
export async function withReviewGpu({call, command, args=[], renewMs=30000, killMs=3000}) {
 const owner=randomUUID();
 await call('/v1/lease',{owner,seconds:120},owner);
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
  if(status.active || status.queued)throw Error('Local GPU has active or queued work');
  child=spawn(command,args,{stdio:'inherit',detached:true,env:{...process.env,INWORLD_REVIEW_DEVICE:'gpu',INWORLD_REVIEW_GPU_LEASE:'1'}});
  const finished=new Promise((done,reject)=>{child.once('error',reject);child.once('exit',(code,sig)=>done({code,sig}));});
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
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
  closing=true;clearInterval(timer);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
  if(renewal)await renewal;
  try{await drainGroup();}finally{clearTimeout(killTimer);}
  await call('/v1/lease/release',{owner},owner);
 }
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 try {
  const [, ,credentialPath,separator,command,...args]=process.argv;
  if(!credentialPath || separator!=='--' || !command)throw Error('Usage: review-gpu.mjs CREDENTIAL_JSON -- COMMAND [ARGS]');
  let credential=JSON.parse(await fs.readFile(credentialPath,'utf8'));
  if(Array.isArray(credential))credential={endpoint:'http://127.0.0.1:8788',token:credential[0]?.token};
  const endpoint=new URL(credential.endpoint);
  if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password || !['http:','https:'].includes(endpoint.protocol) || !credential.token)throw Error('Expected local speech-service credential');
  const call=async(path,payload,owner)=>{
   const response=await fetch(new URL(path,endpoint),{method:payload===undefined?'GET':'POST',headers:{Authorization:'Bearer '+credential.token,'Content-Type':'application/json','X-Worker-Lease':owner},...(payload===undefined?{}:{body:JSON.stringify(payload)}),signal:AbortSignal.timeout(15000)});
   if(!response.ok)throw Error('Local GPU lease request refused HTTP '+response.status);
   return response.json();
  };
  await withReviewGpu({call,command,args});
 } catch(error) {console.error(error.message);process.exitCode=1;}
}
