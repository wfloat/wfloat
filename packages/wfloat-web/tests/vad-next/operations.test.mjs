import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../../node_modules/esbuild/lib/main.js';
const root = new URL('../../', import.meta.url).pathname;
const b = await build({stdin:{contents:`export * from './src/vad-next/model.ts'; export * from './src/vad-next/segmenter.ts';`,resolveDir:root},bundle:true,write:false,platform:'node',format:'esm'});
const {VoiceActivityDetectionModel:Model,Segmenter,configuration} = await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const turn=()=>new Promise(r=>setImmediate(r));
const pcm=(n=512,value=.5)=>({samples:new Float32Array(n).fill(value),sampleRate:16000});
const defaults={minSpeechDurationMs:32,minSilenceDurationMs:32,speechPaddingMs:0};
function backend(scores=[]) { return {sampleRate:16000,frameSize:512,resets:0,frames:[],async reset(){this.resets++;},async score(a){this.frames.push(a);return scores.shift()??0;},setFailureHandler(fn){this.fail=fn;},async unload(){this.unloaded=true;}}; }
test('confirmed speech, silence, probabilities, clips and clipped final frame',async()=>{
 const be=backend([0,.9,.9,0,.9]),m=new Model(be),prob=[];
 const r=await m.detect(pcm(512*4+100),{...defaults,minSpeechDurationMs:0,returnAudio:true,onProbability:e=>prob.push(e)}).result();
 assert.deepEqual(r.segments.map(({id,startMs,endMs})=>({id,startMs,endMs})),[{id:'0',startMs:32,endMs:96},{id:'1',startMs:128,endMs:134.25}]);
 assert.equal(r.segments[0].audio.samples.length,1024);assert.equal(r.segments[1].audio.samples.length,100);assert.equal(prob.length,5);assert.equal(prob[4].endMs,134.25);assert.equal(be.frames[4].length,512);
 await m.unload();
});
test('live delivers clips but result is timing only; push chunk sizes do not change boundaries',async()=>{
 const be=backend([0,.9,.9,0]),m=new Model(be),ends=[],starts=[];
 const s=await m.createSession({...defaults,returnAudio:true,onSpeechStart:e=>starts.push(e),onSpeechEnd:e=>ends.push(e)});
 for(const n of [13,700,1,1000,334]) await s.push(pcm(n));
 const r=await s.finish();assert.equal(r.segments.length,1);assert.equal('audio' in r.segments[0],false);assert.equal(ends[0].audio.samples.length,1024);assert.equal(starts[0].id,'0');
 await m.unload();assert.equal(ends[0].audio.samples[0],.5);
});
test('forward padding never duplicates audio and timestamp matches clip',async()=>{
 const s=new Segmenter(configuration({...defaults,speechPaddingMs:64,returnAudio:true}),true);
 for(const p of [0,.9,0,.9,0])s.feed(pcm().samples,p);s.finish();
 const r=s.snapshot().segments; assert.equal(r.length,2);assert.ok(r[1].startMs>=r[0].endMs);
 for(const a of r)assert.equal(a.audio.samples.length,(a.endMs-a.startMs)*16);
});
test('too-short speech ignored; cancellation never closes unfinished speech',async()=>{
 const m=new Model(backend([.9,.9]));const s=await m.createSession({...defaults,minSpeechDurationMs:96});await s.push(pcm(1024));assert.deepEqual((await s.finish()).segments,[]);
 const s2=await m.createSession(defaults);await s2.push(pcm());await turn();s2.cancel();assert.equal((await s2.result()).stopReason,'cancelled');assert.deepEqual((await s2.result()).segments,[]);await m.unload();
});
test('FIFO reset order; live ownership rejects competing work',async()=>{
 const be=backend([.9,.9]),m=new Model(be);const a=m.detect(pcm(),defaults),b=m.detect(pcm(),defaults);await Promise.all([a.result(),b.result()]);assert.equal(be.resets,2);
 const s=await m.createSession();assert.throws(()=>m.detect(pcm()),/live session/);await assert.rejects(m.createSession(),/live session/);s.cancel();await m.unload();
});
test('cancel releases result immediately but unload waits for native call',async()=>{
 const be=backend();let release;be.score=()=>new Promise(r=>release=r);const m=new Model(be),s=await m.createSession(defaults);await s.push(pcm());await turn();s.cancel();assert.equal((await s.result()).stopReason,'cancelled');const u=m.unload();await turn();assert.equal(be.unloaded,undefined);release(.9);await u;assert.equal(be.unloaded,true);
});
test('backend failure rejects with preserved completed ranges and one onError',async()=>{
 const be=backend([.9,0]),m=new Model(be),errors=[];const s=await m.createSession({...defaults,onError:e=>errors.push(e)});await s.push(pcm(1024));await turn();const old=console.error;console.error=()=>{};try {be.fail(Error('worker broke'));let error;await assert.rejects(s.result(),e=>{error=e;return e.partialResult.segments.length===1;});await turn();assert.equal(errors.length,1);assert.equal(errors[0],error);}finally{console.error=old;}await m.unload();
});
test('invalid options reject before scheduling; empty silence returns no ranges',async()=>{
 const be=backend(),m=new Model(be);for(const opt of [{speechThreshold:2},{minSpeechDurationMs:-1},{silenceThreshold:.8},{returnAudio:'yes'}])assert.throws(()=>m.detect(pcm(),opt));assert.equal(be.resets,0);assert.deepEqual((await m.detect(pcm()).result()).segments,[]);await m.unload();
});
