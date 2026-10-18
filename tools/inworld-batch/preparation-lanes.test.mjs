import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareConcurrently} from './preparation-lanes.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
test('discovery stays chronological, direction workers overlap, and ready chapters stream before later attribution',async()=>{
 const events=[],first=deferred(),later=deferred(),started=deferred();let active=0,maximum=0;
 const task=prepareConcurrently(['one','two','three'],{
  attribute:async id=>{events.push('attribute-'+id);if(id==='three'){started.resolve();await later.promise;}},
  direct:async id=>{active++;maximum=Math.max(maximum,active);events.push('direct-'+id);if(id==='one')await first.promise;active--;},
  ready:async()=>{events.push('ready');},
 },2);
 await started.promise;
 assert.deepEqual(events.filter(e=>e.startsWith('attribute')),['attribute-one','attribute-two','attribute-three']);
 assert(events.includes('ready'));assert.equal(maximum,2);
 first.resolve();later.resolve();await task;
 assert.equal(active,0);assert.equal(events.at(-1),'ready');
});
test('a failed direction worker stops new discovery and drains active work without an unhandled rejection',async()=>{
 const first=deferred(),seen=[];
 const task=prepareConcurrently(['one','two','three','four'],{
  attribute:async id=>{seen.push(id);if(id==='three')first.resolve();},
  direct:async id=>{if(id==='one'){await first.promise;throw Error('Source needs review');}},ready:async()=>{},
 },2);
 await assert.rejects(task,/Source needs review/);assert(!seen.includes('four'));
});
test('a direction failure during attribution does not start another direction request',async()=>{
 const release=deferred(),directed=[];
 const task=prepareConcurrently(['one','two','three'],{
  attribute:async id=>{if(id==='three'){release.resolve();await new Promise(done=>setImmediate(done));}},
  direct:async id=>{directed.push(id);if(id==='one'){await release.promise;throw Error('Direction failed during attribution');}},ready:async()=>{},
 },2);
 await assert.rejects(task,/Direction failed during attribution/);assert.deepEqual(directed,['one','two']);
});
