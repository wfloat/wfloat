import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../../node_modules/esbuild/lib/main.js';
const load = async path => {
  const result = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
};
const f = await load('../../src/tts-next/families.ts');
const { KokoroSession } = await load('../../src/tts-next/kokoro.ts');
const { initializeSherpa, prepareSherpa, synthesizeSherpa } = await load('../../src/tts-next/sherpa.ts');
const { SherpaTextToSpeechBackend } = await load('../../src/tts-next/backend.ts');
const { TextToSpeechModel } = await load('../../src/tts-next/model.ts');
const { OfflineTts } = await load('../../src/wasm/sherpa-onnx-tts.ts');
const bytes = x => new TextEncoder().encode(JSON.stringify(x));
const piper = (id = 'rhasspy/piper-en_US-lessac-medium', extra = {}) => f.standardConfig(id, bytes({
  audio: { sample_rate: 22050 }, num_speakers: id.includes('libritts') ? 904 : 1, espeak: { voice: 'en-us' },
  phoneme_type: 'espeak', speaker_id_map: id.includes('libritts') ? { p3922: 0, p9100: 903 } : {},
  inference: { noise_scale: .667, noise_w: .8, length_scale: 1 }, ...extra,
}));
const kokoro = () => f.standardConfig('hexgrad/Kokoro-82M');

test('Piper voice aliases come from its config, with model-specific ranges and no Wfloat aliases', () => {
  const c = piper('rhasspy/piper-en_US-libritts-high');
  assert.equal(f.standardVoice(c, 'p3922'), 0);
  assert.equal(f.standardVoice(c, 903), 903);
  for (const voice of [904, -1, 1.5, '3922', '__proto__', 'constructor']) assert.throws(() => f.standardVoice(c, voice), /voiceId/);
  assert.throws(() => f.standardVoice(piper(), 1), /voiceId/);
  assert.throws(() => piper(undefined, { num_speakers: 20 }), /metadata/);
  assert.throws(() => piper(undefined, { inference: {noise_scale:1,noise_w:0.8,length_scale:0} }), /length_scale/);
});
test('Piper preserves the pinned non-English frontend voices', () => {
  for (const [id, voice] of [['en_GB-alba-medium','en-gb-x-rp'], ['de_DE-thorsten-medium','de'], ['fr_FR-siwis-medium','fr']]) {
    assert.equal(piper('rhasspy/piper-'+id,{ espeak:{voice} }).espeakVoice, voice);
  }
});
test('Kokoro exact voice table includes new voice 53 and fails Japanese rather than mispronouncing Han', () => {
  assert.equal(f.KOKORO_VOICES.length,54);
  for (const [voice, id, language] of [['af_heart',3,'en-us'],['bf_emma',21,'en'],['ff_siwis',30,'fr'],['hf_alpha',31,'hi'],['if_sara',35,'it'],['pf_dora',42,'pt'],['zf_xiaobei',45,'cmn'],['em_santa',53,'es']]) {
    assert.equal(f.standardVoice(kokoro(),voice),id);assert.equal(f.kokoroLanguage(id),language);
  }
  for (let i=37;i<=41;i++) assert.throws(()=>f.standardVoice(kokoro(),i),/Japanese frontend/);
  assert.throws(()=>f.standardVoice(kokoro(),54),/voiceId/);
});
test('Kitten 0.8 voices and raw-text preparation use the shared frontend', () => {
  for (const id of ['KittenML/kitten-tts-nano-0.8','KittenML/kitten-tts-mini-0.8']) {
    const config=f.standardConfig(id);
    assert.equal(config.family,'kitten');assert.equal(config.numSpeakers,8);
    for(const [i,voice] of f.KITTEN_VOICES.entries()) assert.equal(f.standardVoice(config,voice),i);
    for(const [i,voice] of f.KITTEN_EXPORT_VOICES.entries()) assert.equal(f.standardVoice(config,voice),i);
    for(const voice of [8,-1,1.5,'0','__proto__']) assert.throws(()=>f.standardVoice(config,voice),/voiceId/);
    const text="Dr. Smith can't pay $1,200.50. 👋 "+'Text. '.repeat(100);
    assert.deepEqual(f.prepareStandard(config,{text}),[{text,textStart:0,textEnd:text.length}]);
    assert.throws(()=>f.prepareStandard(config,{text:'a'.repeat(65537)}),/65536/);
  }
});
test('nonexpressive prepare retains text, Unicode offsets and bounded inputs without invoking Wfloat cleaner', () => {
  const c=piper();
  for(const text of ['Le prix est 3,14 €. Grüß dich! 👋 '+ 'Texte. '.repeat(60),'👋'.repeat(301),' '.repeat(250)+'你好 123'+' '.repeat(450)]) {
    const units=prepareSherpa({}, {}, {text}, c);
    assert.equal(units[0].textStart,0);assert.equal(units.at(-1).textEnd,text.length);
    for (const u of units) { assert.ok(u.text.length<=200);assert.ok(!/^[\uDC00-\uDFFF]/.test(u.text));assert.ok(!/[\uD800-\uDBFF]$/.test(u.text)); }
    assert.deepEqual(units,f.prepareStandard(c,{text}));
  }
  const text='Été 3,14 € — do not anglicize.';
  assert.equal(prepareSherpa({}, {}, {text}, c)[0].text,text);
  for(const segment of [{text:'a\0b'},{text:'hello',speed:0},{text:'hello',speed:1e100},{text:'hello',speed:1e-100},{text:'hello',referenceAudio:{}}]) assert.throws(()=>f.validateStandardSegment(c,segment));
});
test('synthesis sends original text, model voice and speed without expressive controls', () => {
  let generated;const tts={generate:c=>(generated=c,{samples:new Float32Array([1,2]),sampleRate:22050})};
  const segment={text:'Été',voiceId:'p3922',speed:1.25,emotion:'angry',intensity:1};
  const audio=synthesizeSherpa(tts,{text:segment.text,textStart:0,textEnd:3},segment,piper('rhasspy/piper-en_US-libritts-high'));
  assert.deepEqual(generated,{text:'Été',sid:0,speed:1.25});assert.equal(audio.samples.length,2);
});
test('Kokoro uses language overrides and enables FSTs only for Chinese; one live engine at a time', () => {
  const created=[],calls=[];let live=0;
  const create=(_,config)=>{assert.equal(config.silenceScale,1);assert.equal(live,0);live++;created.push(config);return {handle:1,sampleRate:24000,numSpeakers:54,
    generate:c=>{calls.push(c);return {samples:new Float32Array(6001),sampleRate:24000};},free:()=>{live--;}};};
  const session=new KokoroSession({},create);
  const generate=sid=>session.generate({text:'123 hello',sid,speed:1.3});
  assert.equal(generate(21).samples.length,6001,'Kokoro output must not receive Kitten tail trimming');
  assert.equal(calls.at(-1).extra.lang,'en');assert.equal(created[0].ruleFsts,'');
  generate(45);assert.match(created.at(-1).ruleFsts,/rule_number_zh/);assert.equal(calls.at(-1).extra.lang,'en-us');
  generate(46);assert.equal(created.length,2);
  generate(30);assert.equal(created.length,3);assert.equal(created.at(-1).ruleFsts,'');assert.equal(calls.at(-1).extra.lang,'fr');
  assert.equal(calls.at(-1).speed,1.3);
  assert.throws(()=>generate(37),/Japanese/);assert.equal(created.length,3);
  session.free();session.free();assert.equal(live,0);assert.throws(()=>generate(0),/unloaded/);
});
test('Kokoro rejects stale 53-speaker voice exports and recovers safely after route creation failure', () => {
  let frees=0;
  assert.throws(()=>new KokoroSession({},()=>({numSpeakers:53,sampleRate:24000,free(){frees++;}})),/54-speaker/);assert.equal(frees,1);
  let n=0;
  const session=new KokoroSession({},()=>{if(++n===2)throw Error('allocation failed');return {numSpeakers:54,sampleRate:24000,free(){frees++;},generate(){return {samples:new Float32Array(1),sampleRate:24000};}};});
  assert.throws(()=>session.generate({sid:45,text:'one',speed:1}),/allocation failed/);
  session.generate({sid:45,text:'one',speed:1});assert.equal(n,3);session.free();
});
class FakeWorker {
  handlers=new Map();calls=[];
  addEventListener(name, fn){this.handlers.set(name,fn);}
  removeEventListener(name){this.handlers.delete(name);}
  terminate(){this.terminated=true;}
  postMessage(request,transfer){
    this.calls.push({request,transfer});
    const value=request.type==='init'?{sampleRate:24000}:request.type==='prepare'?f.prepareStandard(kokoro(),request.segment):{samples:new Float32Array(10),sampleRate:24000};
    queueMicrotask(()=>this.handlers.get('message')?.({data:{id:request.id,value}}));
  }
}
test('backend warns once on meaningless emotion and keeps dialogue voice/speed overrides', async () => {
  const worker=new FakeWorker(),backend=new SherpaTextToSpeechBackend(worker);const b=new Uint8Array(4);
  await backend.initialize({family:'kokoro',config:kokoro(),wasm:b,files:{model_onnx:b},espeak:b});
  assert.equal(worker.calls[0].transfer.length,1,'deduplicate shared buffers');
  const previous=console.warn,warnings=[];console.warn=m=>warnings.push(m);
  const model=new TextToSpeechModel(backend);
  try {
    const g=model.generateDialogue([{text:'one',voiceId:'bf_emma',speed:1.2},{text:'two',voiceId:53}],{emotion:'angry',intensity:.2,speed:.8});
    await g.finished;
    const calls=worker.calls.filter(c=>c.request.type==='synthesize').map(c=>c.request.segment);
    assert.deepEqual(calls.map(c=>[c.voiceId,c.speed]),[['bf_emma',1.2],[53,.8]]);
    assert.equal(warnings.filter(w=>w.startsWith('emotion')).length,1);assert.equal(warnings.filter(w=>w.startsWith('intensity')).length,1);
    assert.throws(()=>model.generate('invalid',{voiceId:37}),/Japanese/);
    assert.throws(()=>model.generate('invalid',{referenceAudio:{samples:new Float32Array(1),sampleRate:24000}}),/referenceAudio/);
  } finally {console.warn=previous;await model.unload();}
  assert.equal(worker.terminated,true);
});
// The real WASM wrapper with an ABI stub, no model or inference runtime.
function moduleStub({nullHandle=false}={}) {
  const memory=new ArrayBuffer(65536),freed=[],generated=[];let offset=16;
  const m={HEAP8:new Int8Array(memory),HEAP32:new Int32Array(memory),HEAPF32:new Float32Array(memory),
    _malloc:n=>{const p=offset;offset=(offset+n+3)&~3;return p;},_free:p=>freed.push(p),
    lengthBytesUTF8:s=>new TextEncoder().encode(s).length,
    stringToUTF8(s,p){const b=new TextEncoder().encode(s);m.HEAP8.set(b,p);m.HEAP8[p+b.length]=0;},
    UTF8ToString(p){let end=p;while(m.HEAP8[end])end++;return new TextDecoder().decode(new Uint8Array(memory,p,end-p));},
    setValue(p,v,t){if(t==='float')m.HEAPF32[p/4]=v;else m.HEAP32[p/4]=v;},
    _CopyHeap(src,n,dst){m.HEAP8.copyWithin(dst,src,src+n);},
    _SherpaOnnxCreateOfflineTts:()=>nullHandle?0:1,
    _SherpaOnnxOfflineTtsSampleRate:()=>24000,_SherpaOnnxOfflineTtsNumSpeakers:()=>54,
    _SherpaOnnxDestroyOfflineTts(){},_SherpaOnnxDestroyOfflineTtsGeneratedAudio:h=>freed.push(h),
    _SherpaOnnxOfflineTtsGenerateWithConfig(_,text,p){
      generated.push({text:m.UTF8ToString(text),sid:m.HEAP32[p/4+2],speed:m.HEAPF32[p/4+1],extra:JSON.parse(m.UTF8ToString(m.HEAP32[p/4+8]))});
      const audio=m._malloc(12),samples=m._malloc(4);m.HEAPF32[samples/4]=.5;m.HEAP32.set([samples,1,24000],audio/4);return audio;
    },
  };return {m,freed,generated};
}
test('WASM generation config serializes string lang beside Pocket numeric extras and owns returned samples', () => {
  const {m,freed,generated}=moduleStub();const tts=new OfflineTts({},m);
  const result=tts.generate({text:'été',sid:30,speed:1.25,extra:{lang:'fr-fr',seed:7,temperature:.7}});
  assert.deepEqual(generated[0],{text:'été',sid:30,speed:1.25,extra:{lang:'fr-fr',seed:7,temperature:.7}});
  m.HEAPF32.fill(0);assert.equal(result.samples[0],.5);assert.ok(freed.length);tts.free();
  assert.throws(()=>new OfflineTts({},moduleStub({nullHandle:true}).m),/Failed to create/);
});

const loaderBundle = await build({entryPoints:[new URL('../../src/tts-next/load.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm',
  define:{'import.meta.url':JSON.stringify(new URL('../../src/tts-next/load.ts',import.meta.url).href)},
  plugins:[{name:'isolated-asset-store',setup(b){
    b.onResolve({filter:/(assets\/(index|store)|runtime\/urls|worker\/generatedModelUrls)\.js$/},args=>({path:args.path,namespace:'fixture'}));
    b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path.endsWith('index.js')?
      'export async function acquireModelAssetLease(id){const f=globalThis.__ttsLoader;f.leases++;return {signal:f.signal,assertCurrent:async()=>{f.checked++},release(){f.released++}}} export async function downloadModel(id){globalThis.__ttsLoader.downloads.push(id)}':
      path.endsWith('store.js')?'export async function readAsset(url){const f=globalThis.__ttsLoader;f.reads.push(url);return url.endsWith("model_config")?f.config:new Uint8Array([1])}':
      path.endsWith('urls.js')?'export const SHERPA_WASM_URL="https://fixture.test/speech.wasm";':
      'export const REGISTRY_ORIGIN="https://fixture.test";export const SHARED_ASSETS={espeak_ng_data_zip:{path:"/espeak.zip"}};export const MODEL_ASSETS=globalThis.__ttsLoader.registry;',loader:'js'}));
  }}]});
async function loaderFixture(id) {
  const config=f.standardModel(id),keys=['model_onnx','model_tokens',...(config.family==='piper'?['model_config']:['model_voices','lexicon_zh','rule_date_zh','rule_number_zh','rule_phone_zh'])];
  const fixture={registry:{[id]:Object.fromEntries(keys.map(k=>[k,{path:'/'+k}]))},leases:0,released:0,checked:0,downloads:[],reads:[],signal:new AbortController().signal,
    config:bytes({audio:{sample_rate:22050},num_speakers:config.speakers,espeak:{voice:config.voice},phoneme_type:'espeak',speaker_id_map:{},inference:{noise_scale:.667,noise_w:.8,length_scale:1}})};
  globalThis.__ttsLoader=fixture;
  const module=await import('data:text/javascript;base64,'+Buffer.from(loaderBundle.outputFiles[0].text+'\n// '+id).toString('base64'));
  return {fixture,module};
}
test('loader dispatches every Piper and Kokoro record, consumes shared dependencies, and preserves lease fences',async()=>{
  const previous=globalThis.Worker;const workers=[];
  globalThis.Worker=class extends FakeWorker{constructor(){super();workers.push(this);}};
  try{
    for(const [id,spec] of Object.entries(f.STANDARD_TTS_MODELS).filter(([,spec])=>spec.family!=='kitten')){
      const {fixture,module}=await loaderFixture(id);const model=await module.loadTextToSpeech(id);
      assert.deepEqual(fixture.downloads,[id]);assert.equal(fixture.checked,1);assert.ok(fixture.released);
      assert.ok(fixture.reads.includes('https://fixture.test/espeak.zip'));
      assert.ok(fixture.reads.includes('https://fixture.test/speech.wasm'));
      const init=workers.at(-1).calls[0].request.assets;
      assert.equal(init.family,spec.family);assert.equal(init.config.modelId,id);
      if(spec.family==='piper')assert.equal(init.config.espeakVoice,spec.voice);
      else assert.ok(init.files.lexicon_zh&&init.files.rule_number_zh);
      await model.unload();assert.ok(workers.at(-1).terminated);
    }
    for(const id of Object.keys(f.STANDARD_TTS_MODELS).filter(id=>id.startsWith('KittenML/'))){
      const {fixture,module}=await loaderFixture(id);
      const model=await module.loadTextToSpeech(id);
      assert.deepEqual(fixture.downloads,[id]);assert.ok(fixture.released);
      const init=workers.at(-1).calls[0].request.assets;
      assert.equal(init.family,'kitten');assert.equal(init.config.numSpeakers,8);
      assert.deepEqual(Object.keys(init.files).sort(),['model_onnx','model_tokens','model_voices']);
      assert.ok(!fixture.reads.some(url=>url.includes('lexicon')));
      await model.unload();
    }
  }finally{globalThis.Worker=previous;delete globalThis.__ttsLoader;}
});

test('Piper initialization uses the VITS ABI fields and rejects mismatched model speaker metadata', () => {
  const {m}=moduleStub();const written=new Map();let destroyed=0;
  m.FS={analyzePath:()=>({exists:true}),writeFile:(name,b)=>written.set(name,b),mkdir(){}};
  m._SherpaOnnxCreateOfflineTts=p=>{
    assert.equal(m.UTF8ToString(m.HEAP32[p/4]),'/model_onnx');
    assert.equal(m.UTF8ToString(m.HEAP32[p/4+2]),'/model_tokens');
    assert.equal(m.UTF8ToString(m.HEAP32[p/4+3]),'/espeak-ng-data');
    assert.ok(Math.abs(m.HEAPF32[p/4+4]-.667)<1e-6);
    assert.ok(Math.abs(m.HEAPF32[p/4+5]-.8)<1e-6);
    assert.equal(m.HEAPF32[p/4+6],1);return 1;
  };
  m._SherpaOnnxOfflineTtsSampleRate=()=>22050;
  m._SherpaOnnxOfflineTtsNumSpeakers=()=>904;
  m._SherpaOnnxDestroyOfflineTts=()=>destroyed++;
  const assets={family:'piper',config:piper('rhasspy/piper-en_US-libritts-high'),wasm:new Uint8Array(),files:{model_onnx:new Uint8Array([1]),model_tokens:new Uint8Array([2])},espeak:new Uint8Array()};
  const engine=initializeSherpa(m,assets);assert.equal(engine.numSpeakers,904);
  assert.ok(written.has('/model_tokens'));engine.free();
  m._SherpaOnnxOfflineTtsNumSpeakers=()=>20;
  assert.throws(()=>initializeSherpa(m,assets),/metadata/);assert.equal(destroyed,2);
});


test('Kitten initializes its ABI config, preserves engine priors/tail, and passes raw text', () => {
  const {m,generated}=moduleStub();let freed=0;
  m.FS={analyzePath:()=>({exists:true}),writeFile(){},mkdir(){}};
  m._SherpaOnnxOfflineTtsNumSpeakers=()=>8;
  m._SherpaOnnxDestroyOfflineTts=()=>freed++;
  m._SherpaOnnxCreateOfflineTts=p=>{
    // Current C ABI: VITS(8), common(3), Matcha(8), Kokoro(8), Kitten(5).
    const kitten=p/4+27;
    assert.equal(m.UTF8ToString(m.HEAP32[kitten]),'/model_onnx');
    assert.equal(m.UTF8ToString(m.HEAP32[kitten+1]),'/model_voices');
    assert.equal(m.UTF8ToString(m.HEAP32[kitten+2]),'/model_tokens');
    assert.equal(m.UTF8ToString(m.HEAP32[kitten+3]),'/espeak-ng-data');
    assert.equal(m.HEAPF32[kitten+4],1);return 1;
  };
  const c=f.standardConfig('KittenML/kitten-tts-nano-0.8');
  const assets={family:'kitten',config:c,wasm:new Uint8Array(),espeak:new Uint8Array(),
    files:{model_onnx:new Uint8Array([1]),model_tokens:new Uint8Array([2]),model_voices:new Uint8Array([3])}};
  const engine=initializeSherpa(m,assets);
  const segment={text:'I paid $12.50.',voiceId:'Hugo',speed:1.25};
  let sent;
  const fake={generate:config=>(sent=config,{samples:new Float32Array(6000),sampleRate:24000})};
  const audio=synthesizeSherpa(fake,f.prepareStandard(c,segment)[0],segment,c);
  assert.deepEqual(sent,{text:segment.text,sid:4,speed:1.25,silenceScale:1});
  assert.equal(audio.samples.length,6000);
  assert.throws(()=>synthesizeSherpa({generate:()=>({samples:new Float32Array(),sampleRate:0})},f.prepareStandard(c,segment)[0],segment,c),/Kitten text preparation or synthesis failed/);
  engine.free();assert.equal(freed,1);
  m._SherpaOnnxOfflineTtsNumSpeakers=()=>20;
  assert.throws(()=>initializeSherpa(m,assets),/Kitten runtime metadata/);assert.equal(freed,2);
});
