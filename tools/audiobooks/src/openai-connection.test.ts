import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { openAIConnection } from './openai-connection.js';
import { runCodexAnalysis } from './codex-analysis.js';
test('gateway requires its credential, source and canonical user, with no API-key fallback',()=>{
 const base={AI_GATEWAY_ORIGIN:'https://gateway.example.test',AI_GATEWAY_CLIENT_ID:'audiobook-worker',AI_GATEWAY_USER_ID:'owner@example.test',AI_GATEWAY_TOKEN:'synthetic-service-credential',OPENAI_API_KEY:'never-forward'};
 const connection=openAIConnection('api',base);assert.equal(connection.base,'https://gateway.example.test/ai/openai/api/v1');assert.equal(connection.headers.Authorization,'Bearer synthetic-service-credential');assert.equal(connection.headers['X-AI-User-ID'],'owner@example.test');
 assert.throws(()=>openAIConnection('api',{...base,AI_GATEWAY_TOKEN:undefined}));assert.throws(()=>openAIConnection('subscription',{...base,AI_GATEWAY_USER_ID:'forged'}));assert.throws(()=>openAIConnection('subscription',{...base,AI_GATEWAY_ORIGIN:'http://untrusted.example.test'}));
 assert.equal(openAIConnection('api',{OPENAI_API_KEY:'standalone'}).base,'https://api.openai.com/v1');
});
test('gateway subscription preserves selected model, high reasoning, schema and provider usage',async()=>{
 const keys=['AI_GATEWAY_ORIGIN','AI_GATEWAY_CLIENT_ID','AI_GATEWAY_USER_ID','AI_GATEWAY_TOKEN'];const previous=Object.fromEntries(keys.map(key=>[key,process.env[key]]));let calls=0,fail=false;
 const server=createServer((req,res)=>{let text='';req.on('data',chunk=>{text+=String(chunk);});req.on('end',()=>{calls++;assert.equal(req.url,'/ai/openai/subscription/v1/responses');assert.equal(req.headers['x-ai-client-id'],'audiobook-worker');assert.equal(req.headers['x-ai-user-id'],'owner@example.test');const body=JSON.parse(text);assert.equal(body.model,'gpt-6.1-sol');assert.equal(body.reasoning.effort,'high');assert.equal(body.store,false);assert.equal(body.tools,undefined);res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({type:fail?'response.failed':'response.completed',response:{status:'completed',output:[{type:'message',content:[{type:'output_text',text:'{"ok":true}'}]}],usage:{input_tokens:120,output_tokens:30}}})+'\n\n');});});
 server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address!=='string');
 Object.assign(process.env,{AI_GATEWAY_ORIGIN:`http://127.0.0.1:${address.port}`,AI_GATEWAY_CLIENT_ID:'audiobook-worker',AI_GATEWAY_USER_ID:'owner@example.test',AI_GATEWAY_TOKEN:'synthetic-service-credential'});
 try {const input={model:'gpt-6.1-sol',instructions:'Synthetic chapter',input:'Synthetic source',schema:{type:'object'}};const result=await runCodexAnalysis(input);assert.deepEqual(result.value,{ok:true});assert.equal(result.usage.input_tokens,120);assert.equal(result.authentication,'chatgpt');fail=true;await assert.rejects(runCodexAnalysis(input),/no API fallback/);assert.equal(calls,2);}
 finally {for(const key of keys){if(previous[key]===undefined)delete process.env[key];else process.env[key]=previous[key];}server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
