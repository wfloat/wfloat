import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../../../../wfloat-web/package.json', import.meta.url));
const { build } = require('esbuild');
const bundle = await build({entryPoints:[new URL('../backend.ts',import.meta.url).pathname,new URL('../families.ts',import.meta.url).pathname],bundle:true,write:false,outdir:'unused',platform:'node',format:'esm',plugins:[{name:'native-stub',setup(b){
  b.onResolve({filter:/llm-native\/instance$/},()=>({path:'native',namespace:'fixture'}));
  b.onResolve({filter:/platform\/bridge$/},()=>({path:'bridge',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path==='native'?'export class NativeInstance {}':'export const request=()=>{throw Error("Unexpected platform call")};'}));
}}]});
const modules=await Promise.all(bundle.outputFiles.map(f=>import('data:text/javascript;base64,'+Buffer.from(f.text).toString('base64'))));
const f=modules.find(m=>m.standardConfig),{NativeStandardTextToSpeechBackend}=modules.find(m=>m.NativeStandardTextToSpeechBackend);
const metadata=spec=>({audio:{sample_rate:22050},num_speakers:spec.speakers,espeak:{voice:spec.voice},phoneme_type:'espeak',speaker_id_map:{last:spec.speakers-1},inference:{noise_scale:.667,noise_w:.8,length_scale:1}});
test('every approved Piper config uses its own frontend and bounded speaker aliases',()=>{
  for(const [id,spec] of Object.entries(f.STANDARD_TTS_MODELS).filter(([,s])=>s.family==='piper')){
    const m=metadata(spec),c=f.standardConfig(id,m);
    assert.equal(c.espeakVoice,spec.voice);assert.equal(f.standardVoice(c,'last'),spec.speakers-1);
    for(const v of [-1,spec.speakers,0.5,'constructor','__proto__','wise_elder_man'])assert.throws(()=>f.standardVoice(c,v));
    assert.throws(()=>f.standardConfig(id,{...m,num_speakers:20}));
    assert.throws(()=>f.standardConfig(id,{...m,espeak:{voice:'wrong'}}));
    assert.throws(()=>f.standardConfig(id,{...m,speaker_id_map:{bad:-1}}));
  }
});
test('Kokoro pinned 54-speaker aliases match the rollout snapshot; Japanese deferred',async()=>{
  const voices={"af_alloy": 0, "af_aoede": 1, "af_bella": 2, "af_heart": 3, "af_jessica": 4, "af_kore": 5, "af_nicole": 6, "af_nova": 7, "af_river": 8, "af_sarah": 9, "af_sky": 10, "am_adam": 11, "am_echo": 12, "am_eric": 13, "am_fenrir": 14, "am_liam": 15, "am_michael": 16, "am_onyx": 17, "am_puck": 18, "am_santa": 19, "bf_alice": 20, "bf_emma": 21, "bf_isabella": 22, "bf_lily": 23, "bm_daniel": 24, "bm_fable": 25, "bm_george": 26, "bm_lewis": 27, "ef_dora": 28, "em_alex": 29, "ff_siwis": 30, "hf_alpha": 31, "hf_beta": 32, "hm_omega": 33, "hm_psi": 34, "if_sara": 35, "im_nicola": 36, "jf_alpha": 37, "jf_gongitsune": 38, "jf_nezumi": 39, "jf_tebukuro": 40, "jm_kumo": 41, "pf_dora": 42, "pm_alex": 43, "pm_santa": 44, "zf_xiaobei": 45, "zf_xiaoni": 46, "zf_xiaoxiao": 47, "zf_xiaoyi": 48, "zm_yunjian": 49, "zm_yunxi": 50, "zm_yunxia": 51, "zm_yunyang": 52, "em_santa": 53};
  const c=f.standardConfig('hexgrad/Kokoro-82M');assert.deepEqual(c.voiceAliases,voices);
  for(const [name,id] of Object.entries(voices)) {
    if(name[0]==='j')assert.throws(()=>f.standardVoice(c,name),/Japanese/);
    else {assert.equal(f.standardVoice(c,name),id);assert.equal(f.kokoroLanguage(id),({a:'en-us',b:'en',e:'es',f:'fr',h:'hi',i:'it',p:'pt',z:'cmn'})[name[0]]);}
  }
});
test('Kitten raw text, eight named/export voices, codepoint bound and no extra trimming/priors',async()=>{
  for(const id of ['KittenML/kitten-tts-nano-0.8','KittenML/kitten-tts-mini-0.8']){
    const c=f.standardConfig(id),calls=[];
    const instance={call:async(op,j)=>{calls.push([op,j]);return {samples:[.5,.25],sampleRate:24000}},unload:async()=>{}};
    const b=new NativeStandardTextToSpeechBackend(instance,c);
    const text="  Dr. Smith paid $12.50; don't split https://example.com. 🌍 ".repeat(10);
    for(let sid=0;sid<8;sid++){
      assert.equal(f.standardVoice(c,f.KITTEN_VOICES[sid]),sid);
      assert.equal(f.standardVoice(c,f.KITTEN_EXPORT_VOICES[sid]),sid);
      const segment={text,voiceId:f.KITTEN_VOICES[sid],speed:1.25};
      const units=await b.prepare(segment);assert.deepEqual(units,[{text,textStart:0,textEnd:text.length}]);
      const audio=await b.synthesize(units[0],segment);
      assert.deepEqual(calls.at(-1),['synthesize',{text,voiceId:sid,speed:1.25}]);
      assert.equal(audio.samples.length,2);
    }
    for(const v of [-1,8,.5,'constructor','alba'])assert.throws(()=>f.standardVoice(c,v));
    assert.equal(f.prepareStandard(c,{text:'🌍'.repeat(65536)})[0].text.length,131072);
    assert.throws(()=>f.prepareStandard(c,{text:'a'.repeat(65537)}),/65536/);
    assert.deepEqual(f.prepareStandard(c,{text:'  '}),[]);
    instance.call=async()=>({samples:[],sampleRate:24000});
    await assert.rejects(b.synthesize({text:'x',textStart:0,textEnd:1},{text:'x'}),/empty/);
  }
});
test('standard text retains original UTF-16 spans and rejects invalid controls',()=>{
  const c=f.standardConfig('hexgrad/Kokoro-82M');
  for(const text of ['👋'.repeat(301),' '.repeat(250)+'你好 123'+' '.repeat(450),'Grüß dich! 3,14 €']){
    const units=f.prepareStandard(c,{text});assert.equal(units[0].textStart,0);assert.equal(units.at(-1).textEnd,text.length);
    for(const u of units){assert.ok(u.text.length<=200);assert.ok(!/^[\uDC00-\uDFFF]/.test(u.text));assert.ok(!/[\uD800-\uDBFF]$/.test(u.text));}
  }
  for(const segment of [{text:'a\0b'},{text:'hello',speed:0},{text:'hello',speed:1e100},{text:'hello',speed:1e-100},{text:'hello',referenceAudio:{}}])assert.throws(()=>f.validateStandardSegment(c,segment));
});
test('native adapter forwards plain text, speaker and speed; rejects NaN PCM',async()=>{
  const c=f.standardConfig('hexgrad/Kokoro-82M'),calls=[];let bad=false,closed=false;
  const instance={call:async(op,j)=>{calls.push([op,j]);return {samples:[bad?NaN:.5],sampleRate:24000};},unload:async()=>{closed=true;}};
  const backend=new NativeStandardTextToSpeechBackend(instance,c),segment={text:'Été 123',voiceId:'em_santa',speed:1.25};
  const [unit]=await backend.prepare(segment);assert.equal(calls.length,0);await backend.synthesize(unit,segment);
  assert.deepEqual(calls[0],['synthesize',{text:'Été 123',voiceId:53,speed:1.25}]);
  bad=true;await assert.rejects(backend.synthesize(unit,segment),/Invalid native synthesized audio/);
  await backend.unload();assert.ok(closed);
});

const loaderBundle=await build({entryPoints:[new URL('../load.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'load-fixtures',setup(b){
  b.onResolve({filter:/(assets\/index|llm-native\/instance|platform\/bridge|\.\/model)$/},a=>({path:a.path,namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path.endsWith('assets/index')?
    `export async function loadAssets(id,task){const f=globalThis.__rnTtsLoad;f.assets++;return {family:f.family,paths:{model_onnx:'/model'},signal:f.signal,assertCurrent(){f.checked++},release(){f.released++}}}`:
    path.endsWith('instance')?`export class NativeInstance {async call(op,j){const f=globalThis.__rnTtsLoad;f.calls.push([op,j]);return f.loaded;}async unload(){globalThis.__rnTtsLoad.unloaded++;}}`:
    path.endsWith('./model')?`export class TextToSpeechModel {constructor(backend){this.backend=backend;}unload(){return this.backend.unload();}}`:
    `export const request=()=>{throw Error('Unexpected platform call')};export function checkAbort(s){if(s?.aborted)throw s.reason;}export const notify=(fn,e)=>fn?.(e);`}));
}}]});
const loader=await import('data:text/javascript;base64,'+Buffer.from(loaderBundle.outputFiles[0].text).toString('base64'));
function fixture(spec){return globalThis.__rnTtsLoad={assets:0,calls:[],checked:0,released:0,unloaded:0,family:spec.family,signal:new AbortController().signal,loaded:{sampleRate:spec.family==='piper'?22050:24000,numSpeakers:spec.speakers,metadata:spec.family==='piper'?metadata(spec):undefined}};}
test('loader dispatches approved models and validates runtime metadata and lease fences',async()=>{
  for(const [id,spec] of Object.entries(f.STANDARD_TTS_MODELS)){
    const state=fixture(spec),model=await loader.loadTextToSpeech(id);
    assert.equal(state.assets,1);assert.equal(state.checked,1);assert.ok(state.released);
    assert.equal(state.calls[0][1].modelId,id);assert.equal(state.calls[0][1].family,spec.family);
    await model.unload();assert.equal(state.unloaded,1);
    const stale=fixture(spec);stale.loaded.numSpeakers=20;
    await assert.rejects(loader.loadTextToSpeech(id),/metadata/);assert.equal(stale.unloaded,1);assert.ok(stale.released);
  }
});

test('only pinned LibriTTS may omit phoneme_type; explicit invalid values always fail',()=>{
  for(const [id,spec] of Object.entries(f.STANDARD_TTS_MODELS).filter(([,s])=>s.family==='piper')){
    const m=metadata(spec);delete m.phoneme_type;
    if(id==='rhasspy/piper-en_US-libritts-high')assert.equal(f.standardConfig(id,m).numSpeakers,904);
    else assert.throws(()=>f.standardConfig(id,m),/metadata/);
    for(const value of [null,'text',''])assert.throws(()=>f.standardConfig(id,{...m,phoneme_type:value}),/metadata/);
  }
});

test('FP32 Kokoro selection rejects stale 53-speaker runtime metadata on cached load',async()=>{
  const spec=f.standardModel('hexgrad/Kokoro-82M');assert.equal(spec.quant,'fp32');
  const state=fixture(spec);state.loaded.numSpeakers=53;
  await assert.rejects(loader.loadTextToSpeech('hexgrad/Kokoro-82M'),/metadata/);
  assert.equal(state.unloaded,1);assert.ok(state.released);
});
