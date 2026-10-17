import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {basicIdentity} from './listener-identity.js';
import {createListener} from './listener.js';
import {Store} from './store.js';

test('standalone login rejects spoofing; pairing issues a revocable device token and checks Origin',async()=>{
 const root=await mkdtemp(join(tmpdir(),'standalone-'));
 await mkdir(join(root,'fictions'));
 const password=randomBytes(32).toString('base64url');
 const origin='http://listener.example.test';
 let identity=basicIdentity(origin,'listener',password);
 const server=createListener(join(root,'fictions'),new Store(join(root,'state')),request=>identity(request),origin,join(root,'archive'),true);
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert(address && typeof address==='object');
 const base='http://127.0.0.1:'+address.port;
 identity=basicIdentity(base,'listener',password);
 const headers={Host:new URL(base).host,Authorization:'Basic '+Buffer.from('listener:'+password).toString('base64')};
 const post=(path:string,data:unknown,extra:Record<string,string>={})=>fetch(base+path,{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:origin,...extra},body:JSON.stringify(data)});
 try{
  const denied=await fetch(base+'/listen/library',{headers:{Host:headers.Host,'x-forwarded-user':'listener','x-authentik-uid':'owner'}});
  assert.equal(denied.status,401);assert.match(denied.headers.get('www-authenticate')! ,/^Basic /);
  assert.equal((await fetch(base+'/listen/library',{headers})).status,200);
  assert.equal(identity({headers:{host:'attacker.example.test',authorization:headers.Authorization},socket:{remoteAddress:'127.0.0.1'}}),null);
  assert.equal((await fetch(base+'/api/listener/library',{headers})).status,401);
  const secret=randomBytes(32).toString('base64url');
  const pair=await (await post('/api/listener/pair/start',{secret})).json() as {code:string};
  assert.equal((await post('/listen/pair/approve',{code:pair.code},{Origin:'https://attacker.example.test'})).status,403);
  assert.equal((await post('/listen/pair/approve',{code:pair.code})).status,200);
  const {token}=await (await post('/api/listener/pair/poll',{code:pair.code,secret})).json() as {token:string};
  const native={Host:headers.Host,Authorization:'Bearer '+token};
  assert.equal((await fetch(base+'/api/listener/library',{headers:native})).status,200);
  assert.equal((await fetch(base+'/api/listener/devices/revoke',{method:'POST',headers:native})).status,200);
  assert.equal((await fetch(base+'/api/listener/library',{headers:native})).status,401);
 }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true});}
});
