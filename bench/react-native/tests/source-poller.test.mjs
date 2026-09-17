import test from 'node:test';
import assert from 'node:assert/strict';
import {SourcePoller} from '../src/sourcePoller.ts';
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
test('collection continues without display subscribers and stops on explicit lifecycle',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let calls=0;
 const source=new SourcePoller(async()=>++calls,2000),events=[];
 const off=source.subscribe(x=>events.push(x));assert.equal(calls,0);
 source.setActive(true);await flush();assert.equal(calls,1);off();
 t.mock.timers.tick(2000);await flush();assert.equal(calls,2);
 source.setActive(false);t.mock.timers.tick(2000);await flush();assert.equal(calls,2);
 assert.equal(events.at(-1).value,1);
});
test('pause/resume rejects late results and never overlaps native reads',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const requests=[],events=[];
 const source=new SourcePoller(()=>new Promise((resolve,reject)=>requests.push({resolve,reject})),2000);
 source.subscribe(x=>events.push(x));source.setActive(true);
 source.setActive(false);source.setActive(true);assert.equal(requests.length,1);
 requests[0].resolve('stale');await flush();assert(!events.some(e=>e.value==='stale'));
 t.mock.timers.tick(0);assert.equal(requests.length,2);
 requests[1].reject(new Error('denied'));await flush();assert.equal(events.at(-1).error,'denied');
 t.mock.timers.tick(2000);assert.equal(requests.length,3);
 requests[2].resolve('good');await flush();assert.equal(events.at(-1).value,'good');
 source.setActive(false);
});
