import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../../node_modules/esbuild/lib/main.js';
const load = async path => {
  const result = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'));
};
const { SherpaVadBackend } = await load('../../src/vad-next/backend.ts');
const { SherpaVadScorer } = await load('../../src/vad-next/sherpa.ts');
class Worker {
  listeners = new Map(); requests = []; terminated = 0;
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type) { this.listeners.delete(type); }
  postMessage(request, transfer) { this.requests.push(structuredClone(request, { transfer })); }
  terminate() { this.terminated++; }
  reply(value, index = this.requests.length - 1) { this.listeners.get('message')?.({ data: { id: this.requests[index].id, value } }); }
}
const assets = () => ({ wasm: new Uint8Array([1]), model: new Uint8Array([2]) });
test('initialization transfers owned assets, score snapshots PCM, unload waits for native acknowledgment', async () => {
  const worker = new Worker(); const backend = new SherpaVadBackend(worker); const data = assets();
  const init = backend.initialize(data); assert.equal(data.model.byteLength, 0); worker.reply(); await init;
  assert.equal(backend.sampleRate, 16000); assert.equal(backend.frameSize, 512);
  const samples = new Float32Array(512).fill(0.2); const scoring = backend.score(samples);
  samples.fill(0.8); assert.equal(worker.requests.at(-1).samples[0], Math.fround(0.2)); assert.equal(samples.length, 512);
  worker.reply(0.75); assert.equal(await scoring, 0.75);
  const reset = backend.reset(); worker.reply(); await reset;
  const unloading = backend.unload(); assert.equal(backend.unload(), unloading); assert.equal(worker.terminated, 0);
  await assert.rejects(backend.score(samples), /unloaded/); worker.reply(); await unloading;
  assert.equal(worker.terminated, 1);
});
test('invalid frame input never enters worker and does not poison backend', async () => {
  const worker = new Worker(); const backend = new SherpaVadBackend(worker);
  for (const samples of [[], new Float32Array(511), new Float32Array(513), new Float32Array(512).fill(NaN)]) await assert.rejects(backend.score(samples));
  assert.equal(worker.requests.length, 0);
  const scoring = backend.score(new Float32Array(512)); worker.reply(0.01); assert.equal(await scoring, 0.01);
  const unloading = backend.unload(); worker.reply(); await unloading;
});
test('fatal idle errors are sticky, notify once and reject all pending requests', async () => {
  const worker = new Worker(); const backend = new SherpaVadBackend(worker); const failures = [];
  backend.setFailureHandler(error => failures.push(error));
  worker.listeners.get('error')({ message: 'native abort' }); worker.listeners.get('messageerror')();
  assert.equal(failures.length, 1); await assert.rejects(backend.reset(), error => error === failures[0]);
  await backend.unload(); assert.equal(worker.terminated, 1);
  const w = new Worker(); const b = new SherpaVadBackend(w);
  const one = b.score(new Float32Array(512)); const two = b.reset();
  const rejected = Promise.all([assert.rejects(one, /trap/), assert.rejects(two, /trap/)]);
  w.listeners.get('message')({ data: { id: 0, fatal: true, error: { name: 'Error', message: 'trap' } } });
  await rejected; await b.unload();
});
test('abortInitialization terminates promptly; abort after readiness preserves native teardown', async () => {
  const worker = new Worker(); const backend = new SherpaVadBackend(worker);
  const init = backend.initialize(assets()); const rejected = assert.rejects(init, { name: 'AbortError' });
  backend.abortInitialization(); await rejected; await backend.unload(); assert.equal(worker.terminated, 1);
  const w = new Worker(); const b = new SherpaVadBackend(w); const ready = b.initialize(assets()); w.reply(); await ready;
  b.abortInitialization(); assert.equal(w.terminated, 0); const done = b.unload(); w.reply(); await done;
});
function nativeFixture() {
  const calls = []; let probability = 0.25;
  const module = {
    wasmMemory: new WebAssembly.Memory({ initial: 1 }),
    _malloc: size => { calls.push(['malloc', size]); return size === 2048 ? 1024 : 32; },
    _free: ptr => calls.push(['free', ptr]), stringToUTF8() {},
    FS: { writeFile: path => calls.push(['write', path]), unlink: path => calls.push(['unlink', path]) },
    _WfloatCreateVadScorer: () => 7, _WfloatDestroyVadScorer: h => calls.push(['destroy', h]),
    _WfloatResetVadScorer: h => { calls.push(['reset', h]); return 1; },
    _WfloatScoreVadFrame: (h, ptr, n) => { calls.push(['score', h, [...new Float32Array(module.wasmMemory.buffer, ptr, n)]]); module.wasmMemory.grow(1); return probability; },
  };
  return { module, calls, probability: value => probability = value };
}
test('native adapter owns one input allocation, scores silence, survives memory growth and releases resources', () => {
  const f = nativeFixture(); const scorer = new SherpaVadScorer(f.module, 'snakers4/silero-vad', assets());
  assert.ok(f.calls.some(c => c[0] === 'unlink'));
  assert.equal(scorer.score(new Float32Array(512)), 0.25);
  scorer.score(new Float32Array(512).fill(0.5)); assert.equal(f.calls.at(-1)[2][511], 0.5);
  scorer.reset(); assert.equal(f.calls.at(-1)[0], 'reset');
  f.probability(NaN); assert.throws(() => scorer.score(new Float32Array(512)), /invalid speech probability/);
  scorer.unload(); scorer.unload(); assert.equal(f.calls.filter(c => c[0] === 'destroy').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'free' && c[1] === 1024).length, 1);
  assert.throws(() => scorer.reset(), /unloaded/);
});
test('native construction failures clean up model file, path and partial scorer', () => {
  const f = nativeFixture(); const malloc = f.module._malloc;
  f.module._malloc = size => size === 2048 ? 0 : malloc(size);
  assert.throws(() => new SherpaVadScorer(f.module, 'snakers4/silero-vad', assets()), /allocate VAD input/);
  assert.ok(f.calls.some(c => c[0] === 'destroy')); assert.ok(f.calls.some(c => c[0] === 'unlink'));
  assert.ok(f.calls.some(c => c[0] === 'free' && c[1] === 32));
});
