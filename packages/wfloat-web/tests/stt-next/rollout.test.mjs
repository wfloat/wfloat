import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { build } from '../../node_modules/esbuild/lib/main.js';
const load = async path => {
  const result = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text + '\n//# sourceURL=stt-rollout-test-bundle.mjs').toString('base64'));
};
const { sttCapabilities, validateRecognitionOptions } = await load('../../src/stt-next/capabilities.ts');
const { recognizerConfig, SherpaRecognizer, NativeDiagnostics } = await load('../../src/stt-next/sherpa.ts');
const { OfflineRecognizer } = await load('../../src/wasm/sherpa-onnx-asr.ts');
const { joinText, overlapText } = await load('../../src/stt-next/transcript.ts');
const multilingual = ['openai/whisper-tiny', 'openai/whisper-base', 'openai/whisper-small'];
const moonshine = 'moonshine-ai/moonshine-base';
const french = 'shaojieli/streaming-zipformer-fr';
const bilingual = 'k2-fsa/streaming-zipformer-zh-en';

test('multilingual Whisper forwards supported language and English translation; omission restores autodetect', () => {
  for (const id of multilingual) {
    const config = options => recognizerConfig(id, options).modelConfig.whisper;
    assert.equal(config({}).language, '');
    assert.equal(config({}).task, 'transcribe');
    for (const [input, expected] of [['fr-CA', 'fr'], ['ZH_hans_CN', 'zh'], ['haw', 'haw'], ['jw', 'jw']]) {
      const c = config({ language: input, task: 'translate', timestamps: 'segment' });
      assert.equal(c.language, expected); assert.equal(c.task, 'translate');
      assert.equal(c.enableSegmentTimestamps, 1); assert.equal(c.enableTokenTimestamps, 0);
    }
    for (const language of ['auto', '', 'xx', 'yue', 'en:foo', ' fr', null]) assert.throws(() => config({ language }));
    for (const options of [{ task: 'translate-fr' }, { hotwords: [] }, { timestamps: 'word' }]) assert.throws(() => config(options));
  }
  assert.equal(recognizerConfig('openai/whisper-tiny-en').modelConfig.whisper.language, 'en');
  assert.throws(() => recognizerConfig('openai/whisper-tiny-en', { task: 'translate' }));
});

test('French and bilingual Zipformer retain streaming, endpoints and greedy-only decoding', () => {
  for (const [id, languages] of [[french, ['fr', 'fr-FR']], [bilingual, ['zh-CN', 'en-US']]]) {
    assert.equal(sttCapabilities(id).kind, 'online');
    for (const language of languages) {
      const c = recognizerConfig(id, { language });
      assert.deepEqual(c.featConfig, { sampleRate: 16000, featureDim: 80 });
      assert.equal(c.decodingMethod, 'greedy_search'); assert.equal(c.enableEndpoint, 1);
      assert.equal(c.hotwordsBuf, ''); assert.equal(c.modelConfig.bpeVocab, undefined);
      assert.equal(c.modelConfig.language, undefined); // no fabricated language constraint
    }
    for (const options of [{ hotwords: [] }, { hotwords: ['bonjour'] }, { language: 'de' }, { task: 'translate' }, { timestamps: 'segment' }]) assert.throws(() => recognizerConfig(id, options));
  }
  assert.throws(() => recognizerConfig(french, { language: 'en' }));
});

test('Parakeet config and automatic-language-only policy survive additions', () => {
  const id = 'nvidia/parakeet-tdt-0.6b-v3';
  const c = recognizerConfig(id);
  assert.equal(c.featConfig.featureDim, 128); assert.equal(c.modelConfig.modelType, 'nemo_transducer');
  assert.equal(c.modelConfig.transducer.joiner, '/joiner.onnx');
  assert.throws(() => validateRecognitionOptions(id, { language: 'en' }), /automatically/);
});

test('Moonshine v2 requires merged decoder and .ort paths, Tiny keeps v1 and ONNX', () => {
  for (const [id, roles, suffix] of [[moonshine, ['encoder', 'merged_decoder'], 'ort'], ['UsefulSensors/moonshine-tiny', ['encoder', 'preprocessor', 'uncached_decoder', 'cached_decoder'], 'onnx']]) {
    const files = new Map(); const unlinked = []; let configuration;
    const module = { HEAP8: new Int8Array(4), HEAP32: new Int32Array(1), HEAPF32: new Float32Array(1), FS: { writeFile: (p, b) => files.set(p, b), unlink: p => unlinked.push(p) } };
    const assets = Object.fromEntries(['tokens', ...roles].map(k => [k, new Uint8Array([1])]));
    const factories = { offline: c => { configuration = c; return { handle: 1, free() {} }; } };
    const r = new SherpaRecognizer(module, id, assets, new NativeDiagnostics(), factories);
    assert.deepEqual([...files.keys()], ['/tokens.txt', ...roles.map(k => `/${k}.${suffix}`)]);
    assert.deepEqual(unlinked, [...files.keys()]);
    assert.equal(configuration.modelConfig.moonshine.mergedDecoder, id === moonshine ? '/merged_decoder.ort' : '');
    if (id === moonshine) {
      assert.equal(configuration.modelConfig.moonshine.preprocessor, '');
      const missing = { ...assets }; delete missing.merged_decoder;
      assert.throws(() => new SherpaRecognizer(module, id, missing, new NativeDiagnostics(), factories), /merged_decoder/);
    }
    for (const options of [{ language: 'fr' }, { task: 'translate' }, { hotwords: [] }, { timestamps: 'segment' }]) assert.throws(() => r.configure(options));
    r.unload();
  }
});

function heapModule() {
  const heap = new Uint8Array(65536); const view = new DataView(heap.buffer); let cursor = 16;
  const allocations = new Map(); const freed = [];
  const string = p => new TextDecoder().decode(heap.subarray(p, heap.indexOf(0, p)));
  const module = {
    _malloc: size => { const p = cursor; cursor += (size + 3) & ~3; allocations.set(p, size); return p; },
    _free: p => { assert.ok(allocations.has(p)); assert.ok(!freed.includes(p)); freed.push(p); },
    lengthBytesUTF8: text => new TextEncoder().encode(text).length,
    stringToUTF8: (text, p) => { const b = new TextEncoder().encode(text); heap.set(b, p); heap[p + b.length] = 0; },
    setValue: (p, value, type) => type === 'float' ? view.setFloat32(p, value, true) : view.setInt32(p, value, true),
    _CopyHeap: (src, size, dst) => heap.copyWithin(dst, src, src + size),
  };
  return { module, view, string, allocations, freed };
}
test('bundled binding packs native wasm32 offsets and releases config allocations even on native failure', () => {
  for (const fail of [false, true]) {
    const f = heapModule();
    const capture = p => {
      assert.equal(f.allocations.get(p), 336);
      const str = offset => f.string(f.view.getInt32(p + offset, true));
      assert.equal(str(8 + 96), '');
      assert.equal(str(8 + 96 + 4), '/encoder.ort');
      assert.equal(str(8 + 96 + 16), '/merged_decoder.ort');
      assert.equal(str(296), 'greedy_search');
      if (fail) throw Error('native rejection');
      return 7;
    };
    f.module._SherpaOnnxCreateOfflineRecognizer = capture;
    f.module._SherpaOnnxOfflineRecognizerSetConfig = (_, p) => capture(p);
    if (fail) assert.throws(() => new OfflineRecognizer(recognizerConfig(moonshine), f.module), /native rejection/);
    else { const r = new OfflineRecognizer(recognizerConfig(moonshine), f.module); r.setConfig(recognizerConfig(moonshine)); }
    assert.equal(f.freed.length, f.allocations.size);
  }
});

test('ABI offsets are checked by wasm32 compiler against the current vendored C API', t => {
  const available = spawnSync('clang', ['--version']);
  if (available.error?.code === 'ENOENT') return t.skip('clang unavailable; heap packing test still runs');
  const header = new URL('../../../../vendor/sherpa-onnx/sherpa-onnx/c-api/c-api.h', import.meta.url).pathname;
  const code = `#include "${header}"\n#define OFF(T,f) __builtin_offsetof(T,f)\n_Static_assert(sizeof(SherpaOnnxOfflineMoonshineModelConfig)==20,"moonshine size");\n_Static_assert(OFF(SherpaOnnxOfflineMoonshineModelConfig,merged_decoder)==16,"merged offset");\n_Static_assert(OFF(SherpaOnnxOfflineModelConfig,moonshine)==96,"moonshine offset");\n_Static_assert(sizeof(SherpaOnnxOfflineModelConfig)==280,"model size");\n_Static_assert(sizeof(SherpaOnnxOfflineRecognizerConfig)==336,"recognizer size");\n_Static_assert(OFF(SherpaOnnxOfflineRecognizerConfig,decoding_method)==296,"decode offset");`;
  const result = spawnSync('clang', ['-target', 'wasm32', '-ffreestanding', '-fsyntax-only', '-x', 'c', '-'], { input: code, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('multilingual transcript joins and overlap preserve unspaced text and original spelling', () => {
  assert.equal(joinText('你好', '世界'), '你好世界');
  assert.equal(joinText('你好。', '世界'), '你好。世界');
  assert.equal(joinText('bonjour', 'le monde'), 'bonjour le monde');
  assert.equal(joinText('สวัสดี', 'ครับ'), 'สวัสดีครับ');
  assert.equal(overlapText('今天你好世界', '你好世界再见', '你好世界').text, '今天你好世界再见');
  assert.equal(overlapText('今日は東京', '東京です', '東京').text, '今日は東京です');
  assert.equal(overlapText('你好 OpenAI', 'OpenAI 世界', 'OpenAI').text, '你好 OpenAI 世界');
  assert.equal(overlapText('bonjour le monde', 'le monde entier', 'le monde').text, 'bonjour le monde entier');
  assert.equal(overlapText('旧文本', '新文本', '不匹配').text, '旧文本新文本');
});

test('loader delivers staged Moonshine v2 roles to its worker and ignores publication notices', async () => {
  const signal = new AbortController().signal;
  const oldWorker = globalThis.Worker;
  const oldFixture = globalThis.__sttRolloutFixture;
  const fixture = { signal, reads: [], releases: 0 };
  globalThis.__sttRolloutFixture = fixture;
  globalThis.Worker = class {};
  const mock = (contents) => ({ contents, loader: 'js' });
  try {
    const result = await build({ entryPoints: [new URL('../../src/stt-next/load.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm', define: { 'import.meta.url': JSON.stringify(new URL('../../src/stt-next/load.ts', import.meta.url).href) }, plugins: [{ name: 'stt-loader-fixture', setup(b) {
      b.onLoad({ filter: /\/assets\/index\.ts$/ }, () => mock(`export async function acquireModelAssetLease() { const f=globalThis.__sttRolloutFixture;return {signal:f.signal,assertCurrent:async()=>{},release:()=>f.releases++}; } export async function downloadModel() {}`));
      b.onLoad({ filter: /\/assets\/store\.ts$/ }, () => mock(`export async function readAsset(url) {globalThis.__sttRolloutFixture.reads.push(url);return new Uint8Array([1]);}`));
      b.onLoad({ filter: /\/assets\/composite\.ts$/ }, () => mock(`export const isComposite=()=>false; export const readComposite=()=>{throw Error('unexpected composite');};`));
      b.onLoad({ filter: /\/runtime\/urls\.ts$/ }, () => mock(`export const SHERPA_WASM_URL='wasm';`));
      b.onLoad({ filter: /\/worker\/generatedModelUrls\.ts$/ }, () => mock(`export const REGISTRY_ORIGIN='https://registry.invalid';export const MODEL_ASSETS={'moonshine-ai/moonshine-base':{tokens:{path:'/tokens.txt'},encoder:{path:'/encoder.ort'},merged_decoder:{path:'/decoder.ort'},license:{path:'/LICENSE'}}};`));
      b.onLoad({ filter: /\/stt-next\/backend\.ts$/ }, () => mock(`export class SherpaSpeechToTextBackend {constructor(_,id){globalThis.__sttRolloutFixture.id=id;} async initialize(assets){globalThis.__sttRolloutFixture.assets=assets;} async unload(){} abortInitialization(){}}`));
      b.onLoad({ filter: /\/stt-next\/model\.ts$/ }, () => mock(`export class SpeechToTextModel {} export class StreamingSpeechToTextModel {}`));
    } }] });
    const { loadSpeechToText } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text + '\n//# sourceURL=stt-loader-rollout.mjs').toString('base64'));
    await loadSpeechToText(moonshine);
    assert.equal(fixture.id, moonshine);
    assert.deepEqual(Object.keys(fixture.assets).sort(), ['encoder', 'merged_decoder', 'tokens', 'wasm']);
    assert.deepEqual(fixture.reads, ['wasm', 'https://registry.invalid/tokens.txt', 'https://registry.invalid/encoder.ort', 'https://registry.invalid/decoder.ort']);
  } finally {
    if (oldWorker === undefined) delete globalThis.Worker; else globalThis.Worker = oldWorker;
    if (oldFixture === undefined) delete globalThis.__sttRolloutFixture; else globalThis.__sttRolloutFixture = oldFixture;
  }
});
