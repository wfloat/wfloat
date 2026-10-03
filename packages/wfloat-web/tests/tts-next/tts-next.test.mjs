import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../../node_modules/esbuild/lib/main.js';
const load = async path => {
  const result = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text + '\n//# sourceURL=' + path).toString('base64'));
};
const { TextToSpeechModel } = await load('../../src/tts-next/model.ts');
const { WebAudioPlayback } = await load('../../src/tts-next/playback.ts');
const { validateWfloatSegment, SherpaTextToSpeechBackend } = await load('../../src/tts-next/backend.ts');
const { installEspeak, ensureHeapViews } = await load('../../src/tts-next/sherpa.ts');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i=0;i<100;i++) { if (fn()) return; await sleep(2); } assert.fail('Condition did not become true'); }
function backend(duration=1000) {
  return { sampleRate: 1000, calls: [], unloads:0,
    validate: validateWfloatSegment,
    async prepare(segment) { let start=0; return segment.text.split('|').map(text => { const textStart=start; start+=text.length+1; return {text,textStart,textEnd:textStart+text.length}; }); },
    async synthesize(unit, segment) { this.calls.push({text:unit.text,...segment}); return {samples:new Float32Array(duration).fill(0.25),sampleRate:1000}; },
    async unload() { this.unloads++; },
  };
}
class Clock {
  pos=0; end=0; closed=false; scheduled=[];
  async start(chunks,pos) { this.pos=pos; this.append(chunks); }
  append(chunks) { this.scheduled.push(...chunks); for (const c of chunks) this.end=c.startMs+c.audio.samples.length; }
  positionMs() { return Math.min(this.pos,this.end); }
  stop() {}
  close() { this.closed=true; }
  advance(ms) { this.pos+=ms; }
}
function fixture(b=backend()) { const clocks=[]; const model=new TextToSpeechModel(b,()=>{const c=new Clock();clocks.push(c);return c;}); return {b,model,clocks}; }

test('retained readers, result identity, recording silence and original Unicode offsets', async()=>{
  const {model}=fixture();
  const g=model.generateDialogue([{text:'Hi 👋| Next.',pauseAfterMs:250},{text:'Last',pauseAfterMs:100}],{pauseBetweenSegmentsMs:999});
  const read=async()=>{const chunks=[];for await(const c of g.audio) chunks.push(c);return chunks;};
  const [a,b,r]=await Promise.all([read(),read(),g.result()]);
  assert.deepEqual(a,b); assert.equal(a.length,5); assert.equal(r.audio.samples.length,3350);
  assert.deepEqual(r.timeline.map(t=>[t.segmentIndex,t.text,t.textStart,t.textEnd,t.startMs]),[[0,'Hi 👋',0,5,0],[0,' Next.',6,12,1000],[1,'Last',0,4,2250]]);
  assert.equal(await g.result(),r);g.dispose();assert.equal(r.audio.samples[0],0.25);await model.unload();
});
test('snapshots defaults and segment overrides without predecessor inheritance',async()=>{
  const {b,model}=fixture();const segments=[{text:'one',speed:2},{text:'two'}];const options={speed:1.5};
  const g=model.generateDialogue(segments,options);segments[0].text='changed';options.speed=9;
  await g.finished;assert.deepEqual(b.calls.map(c=>[c.text,c.speed]),[['one',2],['two',1.5]]);await model.unload();
});
test('all known invalid input rejected before interrupting existing speech',async()=>{
  const {model}=fixture(); const events=[];const a=model.speak('valid',{onPlayback:e=>events.push(e)});
  assert.throws(()=>model.speakDialogue([{text:'okay'},{text:' '}]),/blank/);
  assert.throws(()=>model.speak('bad',{voiceId:'__proto__'}),/voiceId/);
  assert.throws(()=>model.generate('bad',{speed:0}),/speed/);
  assert.throws(()=>model.generateDialogue([]),/segment/);
  await sleep(5);assert.ok(!events.some(e=>e.state==='paused'));a.cancel();await model.unload();
});
test('foreground preempts at safe boundary; interrupted raw resumes before later work',async()=>{
  const b=backend();let release;const original=b.synthesize.bind(b);b.synthesize=async(u,s)=>{if(u.text==='a')await new Promise(r=>release=r);return original(u,s);};
  const {model}=fixture(b); const first=model.generate('a|b');const later=model.generate('c');await until(()=>release);
  const speech=model.speak('foreground');release();await Promise.all([first.finished,later.finished]);
  assert.deepEqual(b.calls.map(c=>c.text),['a|b','foreground','a|b','c']);speech.cancel();await model.unload();
});
test('speech callbacks occur after handle return; pause/resume arbitrates and cancellation is permanent',async()=>{
  const {model,clocks}=fixture();let a;const events=[];
  a=model.speak('first',{onPlayback:e=>{assert.ok(a);events.push(e);}});await until(()=>events.some(e=>e.state==='playing'));
  clocks[0].advance(123);const b=model.speak('second');await sleep(5);assert.equal(events.at(-1).state,'paused');
  a.resume();await sleep(5);assert.equal(clocks[0].pos,123);a.cancel();a.resume();a.pause();await sleep(5);
  assert.equal(events.filter(e=>e.state==='cancelled').length,1);assert.equal(events.at(-1).highlight,null);b.cancel();await model.unload();
});
test('direct speech bounds synthesis ahead, releases played chunks, and completes trailing silence',async()=>{
  const {model,b,clocks}=fixture();const events=[];
  model.speakDialogue([{text:Array(30).fill('word').join('|'),pauseAfterMs:250}],{onPlayback:e=>events.push(e)});
  await until(()=>b.calls.length===10);await sleep(10);assert.equal(b.calls.length,10);
  for(let i=0;i<40 && events.at(-1)?.state!=='finished';i++){clocks[0].advance(1000);await sleep(22);}
  assert.equal(b.calls.length,30);assert.equal(events.at(-1).state,'finished');assert.ok(events.some(e=>e.state==='playing' && e.highlight===null));await model.unload();
});
test('generation disposal rejects readers and pending assembly but preserves delivered samples',async()=>{
  const b=backend();let release;const original=b.synthesize.bind(b);let n=0;b.synthesize=async(u,s)=>{if(++n===2)await new Promise(r=>release=r);return original(u,s);};
  const {model}=fixture(b);const g=model.generate('one|two');const it=g.audio[Symbol.asyncIterator]();const delivered=await it.next();
  const pending=it.next();const result=g.result();await until(()=>release);g.dispose();g.dispose();
  await assert.rejects(pending,/disposed/);await assert.rejects(result,/disposed/);await assert.rejects(g.finished,/disposed/);
  release();assert.equal(delivered.value.audio.samples[0],0.25);await model.unload();
});
test('dispose after synthesis preserves finished but rejects not-yet-assembled result',async()=>{
  const {model}=fixture();const g=model.generate('one');await g.finished;const result=g.result();g.dispose();await g.finished;await assert.rejects(result,/disposed/);await model.unload();
});
test('attached cancel leaves parent and sibling reusable; unload is idempotent',async()=>{
  const {model,b}=fixture();const g=model.generate('one');const a=g.speak();const other=[];const c=g.speak({onPlayback:e=>other.push(e)});
  a.cancel();await g.finished;assert.equal((await g.result()).audio.samples.length,1000);
  const p=model.unload();assert.equal(p,model.unload());await p;await sleep(2);assert.equal(b.unloads,1);assert.equal(other.at(-1).state,'cancelled');c.resume();assert.throws(()=>g.speak(),/disposed/);
});
test('backend failure rejects parent and fails paused and active playback once',async()=>{
  const {model,b}=fixture();const error=new Error('synthesis failed');b.synthesize=async()=>{throw error;};
  const g=model.generate('one');const a=[],c=[];g.speak({onPlayback:e=>a.push(e)});g.speak({onPlayback:e=>c.push(e)});
  await assert.rejects(g.finished,e=>e===error);await sleep(2);assert.equal(a.at(-1).error,error);assert.equal(c.at(-1).error,error);await model.unload();
});
test('playback failure remains local to attached child',async()=>{
  const b=backend();const model=new TextToSpeechModel(b,()=>{throw new Error('audio unavailable');});const g=model.generate('one');const events=[];g.speak({onPlayback:e=>events.push(e)});
  await g.finished;await sleep(2);assert.equal(events.at(-1).state,'failed');assert.equal((await g.result()).timeline.length,1);await model.unload();
});
test('reentrant terminal callbacks cannot resurrect disposed parent or cancel new ownership',async()=>{
  const {model}=fixture();const g=model.generate('one');let replacement;const events=[];
  const s=g.speak({onPlayback:e=>{if(e.state==='cancelled'){assert.throws(()=>g.speak(),/disposed/);replacement=model.speak('new',{onPlayback:e=>events.push(e)});}}});
  g.dispose();await until(()=>events.some(e=>e.state==='playing'));s.cancel();assert.ok(replacement);replacement.cancel();await model.unload();
});
test('WebAudio schedules adjacent chunks ahead on exact clock boundaries and resumes inside chunk',async()=>{
  const previous=globalThis.AudioContext;const sources=[];let context;
  globalThis.AudioContext=class {currentTime=7;destination={};constructor(){context=this;}async resume(){}async close(){}createBuffer(_,n){return{getChannelData:()=>new Float32Array(n)}}createBufferSource(){const s={connect(){},disconnect(){},stop(){s.stopped=true;},start(...args){s.args=args;}};sources.push(s);return s;}};
  try {
    const p=new WebAudioPlayback();const c=(startMs)=>({audio:{samples:new Float32Array(1000),sampleRate:1000},startMs,timeline:[]});
    await p.start([c(0),c(1000)],0);assert.deepEqual(sources.map(s=>s.args),[[7,0],[8,0]]);
    context.currentTime=7.25;assert.equal(p.positionMs(),250);p.stop();assert.ok(sources.every(s=>s.stopped));
    await p.start([c(0),c(1000)],250);assert.deepEqual(sources.slice(2).map(s=>s.args),[[7.25,0.25],[8,0]]);
    context.currentTime=9;assert.equal(p.positionMs(),2000);p.close();
  } finally {globalThis.AudioContext=previous;}
});
test('worker errors reject only outstanding requests without terminating or poisoning later work',async()=>{
  class Worker extends EventTarget {sent=[];postMessage(m){this.sent.push(m);}terminate(){this.terminated=true;}message(data){this.dispatchEvent(new MessageEvent('message',{data}));}}
  const worker=new Worker();const b=new SherpaTextToSpeechBackend(worker);
  const first=b.prepare({text:'x'});const sibling=b.prepare({text:'sibling'});
  worker.message({id:worker.sent[0].id,error:{name:'Error',message:'bad'}});
  await assert.rejects(first,/bad/);
  worker.message({id:worker.sent[1].id,value:[]});assert.deepEqual(await sibling,[]);
  for(const type of ['error','messageerror']){
    const a=b.prepare({text:'a'});const c=b.prepare({text:'c'});
    const event=new Event(type);event.message='unassociated failure';worker.dispatchEvent(event);
    await assert.rejects(a,type==='error'?/unassociated/:/decode/);
    await assert.rejects(c,type==='error'?/unassociated/:/decode/);
    assert.equal(worker.terminated,undefined);
    // A delayed reply cannot revive old requests; a new request still reaches the worker.
    worker.message({id:worker.sent.at(-1).id,value:[]});
    const next=b.prepare({text:'later'});worker.message({id:worker.sent.at(-1).id,value:[]});
    assert.deepEqual(await next,[]);
  }
  const last=b.prepare({text:'pending on unload'});await b.unload();await assert.rejects(last,/unloaded/);
  await assert.rejects(b.prepare({text:'after unload'}),/unloaded/);assert.equal(worker.terminated,true);
});
test('ZIP rejects truncation instead of reading partial model dependency',()=>{
  const bytes=new Uint8Array(8);new DataView(bytes.buffer).setUint32(0,0x04034b50,true);
  assert.throws(()=>installEspeak({},bytes),/Truncated/);
});
test('missing heap views track WASM memory growth',()=>{
 const wasmMemory=new WebAssembly.Memory({initial:1,maximum:2});const module={wasmMemory};ensureHeapViews(module);
 module.HEAP32[0]=17;const before=module.HEAP32;wasmMemory.grow(1);assert.notEqual(module.HEAP32,before);assert.equal(module.HEAP32[0],17);assert.equal(module.HEAP8.length,131072);
});
test('unobserved raw failures log once; observed failures and disposal do not log',async()=>{
 const previous=console.error;const logs=[];console.error=(...args)=>logs.push(args);
 try{
  const {model,b}=fixture();b.synthesize=async()=>{throw new Error('inference');};model.generate('unobserved');await sleep(5);assert.equal(logs.length,1);
  await assert.rejects(model.generate('observed').result(),/inference/);await sleep(5);assert.equal(logs.length,1);
  model.generate('disposed').dispose();await sleep(5);assert.equal(logs.length,1);await model.unload();
 }finally{console.error=previous;}
});
test('notification throw/rejection is visible without corrupting speech or inference',async()=>{
 const previous=console.error;const logs=[];console.error=(...args)=>logs.push(args);
 try{
  const {model}=fixture();const g=model.generate('valid');let count=0;
  const speech=g.speak({onPlayback:e=>{count++;if(e.state==='buffering')throw Error('ui');return Promise.reject(Error('async ui'));}});
  await g.finished;await sleep(5);assert.ok(count);assert.ok(logs.length);assert.equal((await g.result()).timeline.length,1);speech.cancel();await sleep(5);await model.unload();
 }finally{console.error=previous;}
});
test('one lazy AudioContext per model; paused previews share it until unload',async()=>{
 const previous=globalThis.AudioContext;const contexts=[];
 globalThis.AudioContext=class {currentTime=0;destination={};closed=false;constructor(){contexts.push(this);}async resume(){}async close(){this.closed=true;}createBuffer(_,n){return{getChannelData:()=>new Float32Array(n)}}createBufferSource(){return{connect(){},disconnect(){},stop(){},start(){}}}};
 try{
  const model=new TextToSpeechModel(backend());assert.equal(contexts.length,0);
  const a=model.speak('one');const b=model.speak('two');const c=model.speak('three');assert.equal(contexts.length,1);
  a.cancel();b.cancel();c.cancel();assert.equal(contexts[0].closed,false);
  const other=new TextToSpeechModel(backend());other.speak('independent');assert.equal(contexts.length,2);
  await model.unload();assert.equal(contexts[0].closed,true);assert.equal(contexts[1].closed,false);await other.unload();
 }finally{globalThis.AudioContext=previous;}
});
test('cancel while AudioContext.resume waits cannot schedule stale sources',async()=>{
 const previous=globalThis.AudioContext;let resolveResume;let starts=0;
 globalThis.AudioContext=class {currentTime=0;destination={};resume(){return new Promise(r=>resolveResume=r);}async close(){}createBuffer(_,n){return{getChannelData:()=>new Float32Array(n)}}createBufferSource(){return{connect(){},disconnect(){},stop(){},start(){starts++;}}}};
 try{
  const player=new WebAudioPlayback();const pending=player.start([{audio:{samples:new Float32Array(10),sampleRate:1000},startMs:0,timeline:[]}],0);
  player.stop();resolveResume();await pending;assert.equal(starts,0);player.close();
 }finally{globalThis.AudioContext=previous;}
});
test('foreground completion restores raw inference without automatically resuming paused speech',async()=>{
 const {model,b}=fixture();const oldEvents=[];const old=model.speak('paused',{onPlayback:e=>oldEvents.push(e)});const current=model.speak('foreground');const raw=model.generate('background');
 await raw.finished;await sleep(5);assert.equal(oldEvents.at(-1).state,'paused');assert.deepEqual(b.calls.map(c=>c.text),['foreground','background']);old.cancel();current.cancel();await model.unload();
});
test('unload waits for both AudioContext close and backend cleanup, once',async()=>{
 const previous=globalThis.AudioContext;let closeAudio;let closeBackend;let audioCalls=0;let backendCalls=0;
 globalThis.AudioContext=class {async resume(){}close(){audioCalls++;return new Promise(r=>closeAudio=r);}};
 try{
  const b=backend();b.unload=()=>{backendCalls++;return new Promise(r=>closeBackend=r);};
  const model=new TextToSpeechModel(b);model.speak('pending');
  const cleanup=model.unload();assert.equal(model.unload(),cleanup);let settled=false;void cleanup.then(()=>settled=true);
  await until(()=>closeAudio&&closeBackend);assert.equal(audioCalls,1);assert.equal(backendCalls,1);
  closeBackend();await sleep(2);assert.equal(settled,false);
  closeAudio();await cleanup;assert.equal(settled,true);await model.unload();assert.equal(audioCalls,1);assert.equal(backendCalls,1);
 }finally{globalThis.AudioContext=previous;}
});
test('AudioContext close failure still waits for backend cleanup and rejects unload',async()=>{
 const previous=globalThis.AudioContext;let closeBackend;const failure=Error('context close failed');
 globalThis.AudioContext=class {async resume(){}close(){return Promise.reject(failure);}};
 try{
  const b=backend();b.unload=()=>new Promise(r=>closeBackend=r);
  const model=new TextToSpeechModel(b);model.speak('pending');const cleanup=model.unload();
  let settled=false;void cleanup.then(()=>settled=true,()=>settled=true);
  await until(()=>closeBackend);await sleep(2);assert.equal(settled,false);
  closeBackend();await assert.rejects(cleanup,e=>e===failure);assert.equal(model.unload(),cleanup);
 }finally{globalThis.AudioContext=previous;}
});
test('sparse dialogue is rejected before interrupting or allocating a replacement speech',async()=>{
 const {model,b,clocks}=fixture();const events=[];const active=model.speak('active',{onPlayback:e=>events.push(e)});
 await until(()=>events.some(e=>e.state==='playing'));const calls=b.calls.length;
 const sparse=new Array(2);sparse[1]={text:'later'};
 for(const input of [new Array(1),sparse]){
  assert.throws(()=>model.speakDialogue(input),/dense/);
  assert.throws(()=>model.generateDialogue(input),/dense/);
 }
 await sleep(5);assert.equal(clocks.length,1);assert.equal(b.calls.length,calls);assert.equal(events.at(-1).state,'playing');
 active.cancel();await model.unload();
});
test('unsafe individual and total pause samples reject upfront without interrupting playback',async()=>{
 const {model,b,clocks}=fixture();const events=[];const active=model.speak('active',{onPlayback:e=>events.push(e)});
 await until(()=>events.some(e=>e.state==='playing'));const calls=b.calls.length;
 assert.throws(()=>model.speakDialogue([{text:'bad',pauseAfterMs:Number.MAX_VALUE}]),/representable/);
 assert.throws(()=>model.speakDialogue([{text:'bad'},{text:'later'}],{pauseBetweenSegmentsMs:Number.MAX_VALUE}),/representable/);
 const large=Number.MAX_SAFE_INTEGER*0.6;
 assert.throws(()=>model.speakDialogue([{text:'a',pauseAfterMs:large},{text:'b',pauseAfterMs:large}]),/Total pauses/);
 await sleep(5);assert.equal(clocks.length,1);assert.equal(b.calls.length,calls);assert.equal(events.at(-1).state,'playing');
 // Validate against the backend rate, not milliseconds alone.
 const highRate=backend();highRate.sampleRate=48000;const highModel=new TextToSpeechModel(highRate);
 assert.throws(()=>highModel.generateDialogue([{text:'bad',pauseAfterMs:1e15}]),/representable/);
 await highModel.unload();active.cancel();await model.unload();
});


test('WebAudio clock includes allocation stalls before first and underrun scheduling',async()=>{
 const previous=globalThis.AudioContext;let context;const starts=[];
 globalThis.AudioContext=class {
  currentTime=5;destination={};stall=0;
  constructor(){context=this;}async resume(){}async close(){}
  createBuffer(_,n){this.currentTime+=this.stall;return{getChannelData:()=>new Float32Array(n)};}
  createBufferSource(){return{connect(){},disconnect(){},stop(){},start(when,offset){starts.push({when,offset});}};}
 };
 const chunk=startMs=>({audio:{samples:new Float32Array(100),sampleRate:1000},startMs,timeline:[]});
 try{
  const player=new WebAudioPlayback();context.stall=0.2;
  await player.start([chunk(0)],0);
  assert.equal(player.positionMs(),0,'allocation time must not consume unscheduled audio');
  context.currentTime+=0.05;assert.ok(Math.abs(player.positionMs()-50)<1e-6);
  context.currentTime+=0.2;player.append([chunk(100)]);
  assert.ok(Math.abs(player.positionMs()-100)<1e-6,'underrun allocation must not skip new audio');
  player.stop();await player.start([chunk(100)],150);
  assert.ok(Math.abs(player.positionMs()-150)<1e-6,'resuming inside a chunk must also exclude allocation time');
  assert.equal(starts.at(-1).offset,0.05);player.close();
 }finally{globalThis.AudioContext=previous;}
});

test('late rejection of a superseded start cannot fail resumed speech',async()=>{
 const clock=new Clock();let rejectStart;let starts=0;
 clock.start=(chunks,pos)=>{clock.pos=pos;clock.append(chunks);return ++starts===1?new Promise((_,reject)=>rejectStart=reject):Promise.resolve();};
 const model=new TextToSpeechModel(backend(),()=>clock);const events=[];
 try{
  const g=model.generate('one');await g.finished;const s=g.speak({onPlayback:e=>events.push(e)});
  s.pause();s.resume();await until(()=>events.some(e=>e.state==='playing'));
  rejectStart(Error('obsolete resume failed'));await sleep(5);
  assert.ok(!events.some(e=>e.state==='failed'));clock.advance(1000);
  await until(()=>events.at(-1)?.state==='finished');assert.equal(events.filter(e=>e.state==='finished').length,1);
 }finally{await model.unload();}
});
test('cancel during prepare discards stale completion and releases background work',async()=>{
 const b=backend();const prepare=b.prepare.bind(b);let release;
 b.prepare=async segment=>{if(segment.text==='cancelled')await new Promise(r=>release=r);return prepare(segment);};
 const {model}=fixture(b);const events=[];
 try{
  const s=model.speak('cancelled',{onPlayback:e=>events.push(e)});await until(()=>release);
  const g=model.generate('healthy');s.cancel();release();await g.finished;await sleep(5);
  assert.deepEqual(b.calls.map(c=>c.text),['healthy']);assert.equal(events.at(-1).state,'cancelled');
  assert.equal(events.filter(e=>['cancelled','failed','finished'].includes(e.state)).length,1);
 }finally{await model.unload();}
});
test('a paused callback may resume the interrupted speech and preserve single active playback',async()=>{
 const {model,clocks}=fixture();const firstEvents=[],secondEvents=[];let first;
 try{
  first=model.speak('first',{onPlayback:e=>{firstEvents.push(e);if(e.state==='paused')first.resume();}});
  await until(()=>firstEvents.some(e=>e.state==='playing'));clocks[0].advance(300);
  const second=model.speak('second',{onPlayback:e=>secondEvents.push(e)});
  await until(()=>secondEvents.some(e=>e.state==='paused'));
  assert.equal(clocks[0].pos,300);assert.equal(firstEvents.at(-1).state,'playing');
  first.cancel();second.cancel();
 }finally{await model.unload();}
});
test('playback append failure leaves retained parent and future replay healthy',async()=>{
 const b=backend();const synthesize=b.synthesize.bind(b);let release;
 b.synthesize=async(u,s)=>{if(u.text==='two')await new Promise(r=>release=r);return synthesize(u,s);};
 const clocks=[];const failure=Error('audio append failed');
 const model=new TextToSpeechModel(b,()=>{const c=new Clock();clocks.push(c);return c;});const events=[];
 try{
  const g=model.generate('one|two');g.speak({onPlayback:e=>events.push(e)});
  await until(()=>release&&events.some(e=>e.state==='playing'));
  clocks[0].append=()=>{throw failure;};release();await g.finished;await until(()=>events.at(-1)?.state==='failed');
  assert.equal(events.at(-1).error,failure);assert.equal((await g.result()).audio.samples.length,2000);
  const replay=[];g.speak({onPlayback:e=>replay.push(e)});await until(()=>replay.some(e=>e.state==='playing'));
  clocks[1].advance(2000);await until(()=>replay.at(-1)?.state==='finished');
 }finally{await model.unload();}
});

test('out-of-order AudioContext resumes cannot revive old audio or drop newly appended chunks',async()=>{
 const previous=globalThis.AudioContext;const resumes=[],starts=[];
 globalThis.AudioContext=class {
  currentTime=3;destination={};resume(){return new Promise(resolve=>resumes.push(resolve));}async close(){}
  createBuffer(_,n){return{getChannelData:()=>new Float32Array(n)};}
  createBufferSource(){return{connect(){},disconnect(){},stop(){},start(...args){starts.push(args);}};}
 };
 const chunk=startMs=>({audio:{samples:new Float32Array(100),sampleRate:1000},startMs,timeline:[]});
 const player=new WebAudioPlayback();
 try{
  resumes[0]();const old=player.start([chunk(0)],0);player.stop();
  const fresh=player.start([chunk(100)],150);player.append([chunk(200)]);
  resumes[2]();await fresh;
  assert.equal(starts.length,2);assert.equal(starts[0][1],0.05);assert.equal(starts[1][1],0);
  resumes[1]();await old;assert.equal(starts.length,2);
  assert.equal(player.positionMs(),150);
 }finally{player.close();globalThis.AudioContext=previous;}
});
test('unload wins over an in-flight synthesis failure without a second terminal event',async()=>{
 const b=backend();let reject; b.synthesize=()=>new Promise((_,no)=>reject=no);
 const {model}=fixture(b);const events=[];const g=model.generate('pending');
 g.speak({onPlayback:e=>events.push(e)});const result=g.result();await until(()=>reject);
 await model.unload();reject(Error('late inference error'));await assert.rejects(result,/disposed/);await sleep(5);
 assert.deepEqual(events.filter(e=>['cancelled','failed','finished'].includes(e.state)).map(e=>e.state),['cancelled']);
});

test('a native source start failure disconnects the unstarted node and preserves failure cleanup',async()=>{
 const previous=globalThis.AudioContext;const failure=Error('native start failed');const nodes=[];
 globalThis.AudioContext=class {
  currentTime=0;destination={};async resume(){}async close(){}
  createBuffer(_,n){return{getChannelData:()=>new Float32Array(n)};}
  createBufferSource(){const node={started:false,disconnected:false,connect(){},disconnect(){this.disconnected=true;},
   start(){if(nodes.length===2)throw failure;this.started=true;},stop(){if(!this.started)throw Error('Cannot stop an unstarted source');}};nodes.push(node);return node;}
 };
 const player=new WebAudioPlayback();
 const chunk=startMs=>({audio:{samples:new Float32Array(100),sampleRate:1000},startMs,timeline:[]});
 try{
  await assert.rejects(player.start([chunk(0),chunk(100)],0),e=>e===failure);
  assert.doesNotThrow(()=>player.stop());
  assert.ok(nodes.every(node=>node.disconnected));
 }finally{try{player.close();}finally{globalThis.AudioContext=previous;}}
});

test('a never-settling notification promise does not block synthesis, completion, or callback unload',async()=>{
 const {model,clocks}=fixture();const events=[];let cleanup;
 const g=model.generate('one|two');
 g.speak({onPlayback:e=>{events.push(e.state);if(e.state==='finished')cleanup=model.unload();return new Promise(()=>{});}});
 await g.finished;await until(()=>events.includes('playing'));
 clocks[0].advance(2000);await until(()=>cleanup);await cleanup;
 assert.equal(events.at(-1),'finished');assert.equal(events.filter(e=>e==='finished').length,1);
});
