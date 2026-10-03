import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from '../../node_modules/esbuild/lib/main.js';
const bundle=await build({entryPoints:[new URL('../../src/stt-next/session.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});
const {LiveSession}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const turn=()=>new Promise(r=>setImmediate(r));
const audio={samples:new Float32Array(160).fill(.1),sampleRate:16000};
const backend=()=>({kind:'online',async pushStream(samples,finish){return{text:finish?'heard':'draft',isEndpoint:false};},async resetStream(){},async decode(){return{text:'heard'};}});
const quiet=fn=>async t=>{const old=console.error;console.error=()=>{};try{await fn(t);}finally{console.error=old;}};
test('source conflicts do not fail the active route; mic capture stops exactly once',quiet(async()=>{
 let onAudio,stops=0;const errors=[];const capture={async stop(){stops++;}};
 const session=new LiveSession(backend(),{onError:e=>errors.push(e)},()=>{},async callback=>{onAudio=callback;return capture;});
 const start=session.startMicrophone();assert.equal(start,session.startMicrophone());await start;
 await assert.rejects(session.push(audio),/mix sources/);onAudio(audio);const r=await session.finish();
 assert.equal(r.stopReason,'complete');assert.equal(stops,1);assert.deepEqual(errors,[]);
 session.cancel();await session.finish();await session.released;assert.equal(stops,1);
 const external=new LiveSession(backend(),{},()=>{},()=>assert.fail('must not open capture'));
 await external.push(audio);await assert.rejects(external.startMicrophone(),/mix sources/);assert.equal((await external.finish()).text,'heard');
}));
test('late microphone acquisition after cancellation releases tracks and cannot revive session',quiet(async()=>{
 let resolve,signal,stops=0;const errors=[];
 const session=new LiveSession(backend(),{onError:e=>errors.push(e)},()=>{},(_,__,s)=>{signal=s;return new Promise(r=>resolve=r);});
 const start=session.startMicrophone();session.cancel();assert.equal(signal.aborted,true);
 assert.equal((await session.result()).stopReason,'cancelled');await session.released;
 resolve({async stop(){stops++;}});await assert.rejects(start,{name:'AbortError'});await turn();
 assert.equal(stops,1);assert.deepEqual(errors,[]);assert.equal((await session.finish()).stopReason,'cancelled');
}));
for(const synchronous of [false,true])test(`microphone ${synchronous?'synchronous':'asynchronous'} startup failure is terminal and preserves one error`,quiet(async()=>{
 const cause=Error('capture setup failed'),errors=[];const session=new LiveSession(backend(),{onError:e=>errors.push(e)},()=>{},()=>{if(synchronous)throw cause;return Promise.reject(cause);});
 await assert.rejects(session.startMicrophone(),e=>e===cause);await turn();assert.equal(errors.length,1);
 await assert.rejects(session.result(),e=>e===errors[0]&&e.cause===cause&&e.partialResult.text==='');
 await assert.rejects(session.finish(),e=>e===errors[0]);await session.released;
}));
test('failure after start stops capture and returns same error through callback and result',quiet(async()=>{
 let fail,deliver,stops=0;const errors=[];
 const session=new LiveSession(backend(),{onError:e=>errors.push(e)},()=>{},async(a,b)=>{deliver=a;fail=b;return{async stop(){stops++;}};});
 await session.startMicrophone();deliver({samples:new Float32Array(5120).fill(.1),sampleRate:16000});await turn();
 fail(Error('track disconnected'));await turn();await assert.rejects(session.result(),e=>e===errors[0]);
 assert.deepEqual(errors[0].partialResult.provisional,{text:'draft'});assert.equal(stops,1);assert.equal(errors.length,1);await session.released;
}));
test('sustained growing backlog warns once with the configured option name; short lag does not',quiet(async()=>{
 const previous=Object.getOwnPropertyDescriptor(performance,'now');let now=0;
 Object.defineProperty(performance,'now',{value:()=>now,configurable:true});
 const oldWarn=console.warn,warnings=[];console.warn=(...args)=>warnings.push(args.join(' '));
 let release;const native=new Promise(r=>release=r);
 const b=backend();b.pushStream=()=>native;
 const session=new LiveSession(b,{},()=>{});
 try{
  await session.push({samples:new Float32Array(16000*5).fill(.1),sampleRate:16000});
  await session.push(audio);assert.equal(warnings.length,0);
  now=1000;await session.push(audio);assert.equal(warnings.length,0);
  now=6000;await session.push(audio);assert.equal(warnings.length,1);assert.match(warnings[0],/maxBufferedAudioMs/);
  now=12000;await session.push(audio);assert.equal(warnings.length,1);
 }finally{
  session.cancel();release({text:'late',isEndpoint:false});await session.released;
  console.warn=oldWarn;if(previous)Object.defineProperty(performance,'now',previous);else delete performance.now;
 }
}));
