import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from '../../node_modules/esbuild/lib/main.js';
const built = await build({ entryPoints: [new URL('../../src/stt-next/microphone.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
const { startMicrophone } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ worklet = true, moduleFails = false, denied = false, pending = false, resumeFails = false, setupFails = false } = {}) {
  const old = Object.getOwnPropertyDescriptors(globalThis); let grant; let processor; let context; let resumed = false; let moduleSource;
  class Track extends EventTarget { readyState = 'live'; stops = 0; stop() { this.stops++; this.readyState = 'ended'; } getSettings() { return { channelCount: 2 }; } }
  const track = new Track(); const stream = new EventTarget(); stream.getTracks = stream.getAudioTracks = () => [track];
  class Node { connect() {} disconnect() { this.disconnected = true; } }
  class Context extends EventTarget {
    state = 'suspended'; sampleRate = 48000; destination = new Node(); closes = 0;
    constructor() { super(); context = this; if (worklet) this.audioWorklet = { addModule: async url => { moduleSource = await (await fetch(url)).text(); if (moduleFails) throw Error('CSP'); } }; }
    async resume() { resumed = true; if (resumeFails) throw Error('resume failed'); this.state = 'running'; }
    async close() { this.closes++; this.state = 'closed'; this.dispatchEvent(new Event('statechange')); }
    createMediaStreamSource() { if (setupFails) throw Error('source failed'); return new Node(); }
    createGain() { return Object.assign(new Node(), { gain: { value: 1 } }); }
    createScriptProcessor() { return processor = Object.assign(new Node(), { onaudioprocess: null }); }
  }
  class Worklet extends Node { constructor() { super(); processor = this; this.port = { close() {} }; } }
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: () => denied ? Promise.reject(Error('denied')) : pending ? new Promise(resolve => grant = resolve) : Promise.resolve(stream) } } });
  globalThis.AudioContext = Context; globalThis.AudioWorkletNode = Worklet;
  return { track, stream, get context() { return context; }, get processor() { return processor; }, get resumed() { return resumed; }, get moduleSource() { return moduleSource; }, grant: () => grant(stream), restore() { for (const name of ['navigator', 'AudioContext', 'AudioWorkletNode']) { if (old[name]) Object.defineProperty(globalThis, name, old[name]); else delete globalThis[name]; } } };
}

test('permission cancellation settles promptly and late capture releases tracks', async () => {
  const f = fixture({ pending: true });
  try {
    const abort = new AbortController(); const start = startMicrophone(() => {}, () => assert.fail('unexpected notification'), abort.signal);
    assert.ok(f.resumed); abort.abort(); await assert.rejects(start, { name: 'AbortError' }); assert.equal(f.context.closes, 1);
    f.grant(); await tick(); assert.equal(f.track.stops, 1);
  } finally { f.restore(); }
});

test('permission rejection closes context', async () => {
  const f = fixture({ denied: true });
  try { await assert.rejects(startMicrophone(() => {}, () => {}), /denied/); assert.equal(f.context.closes, 1); }
  finally { f.restore(); }
});

test('worklet receives owned PCM, detects track loss once and stops', async () => {
  const f = fixture(); const audio = []; const errors = [];
  try {
    const handle = await startMicrophone(pcm => audio.push(pcm), error => errors.push(error));
    f.processor.port.onmessage({ data: { samples: new Float32Array([0.5]) } }); assert.equal(audio[0].sampleRate, 48000);
    f.track.dispatchEvent(new Event('ended')); f.stream.dispatchEvent(new Event('inactive'));
    assert.equal(errors.length, 1); assert.match(errors[0].message, /disconnected/); assert.equal(f.track.stops, 1);
    assert.equal(handle.stop(), handle.stop()); await handle.stop(); assert.equal(f.context.closes, 1);
  } finally { f.restore(); }
});

test('generated worklet downmixes and reports lost input', async () => {
  const f = fixture();
  try {
    const handle = await startMicrophone(() => {}, () => {}); let Processor; const messages = [];
    vm.runInNewContext(f.moduleSource, { AudioWorkletProcessor: class { port = { postMessage: data => messages.push(data) }; }, registerProcessor: (_, value) => Processor = value, Float32Array });
    const instance = new Processor(); assert.equal(instance.process([[]]), true);
    instance.process([[new Float32Array([1, -1]), new Float32Array([0, 1])]]);
    assert.deepEqual([...messages[0].samples], [0.5, 0]); assert.equal(instance.process([[]]), false); assert.match(messages[1].error, /disconnected/);
    await handle.stop();
  } finally { f.restore(); }
});

for (const moduleFails of [false, true]) test(`fallback downmix and intentional stop (${moduleFails ? 'CSP' : 'no worklet'})`, async () => {
  const f = fixture({ worklet: moduleFails, moduleFails }); const audio = []; const errors = [];
  try {
    const handle = await startMicrophone(pcm => audio.push(pcm), error => errors.push(error));
    f.processor.onaudioprocess({ inputBuffer: { length: 2, numberOfChannels: 2, getChannelData: i => new Float32Array(i ? [0, 1] : [1, -1]) } });
    assert.deepEqual([...audio[0].samples], [0.5, 0]); await handle.stop(); f.track.dispatchEvent(new Event('ended'));
    assert.equal(errors.length, 0); assert.equal(f.track.stops, 1);
  } finally { f.restore(); }
});

for (const failure of ['processor', 'context']) test(`post-start ${failure} failure releases capture and notifies once`, async () => {
  const f = fixture(); const errors = [];
  try {
    const handle = await startMicrophone(() => {}, error => errors.push(error));
    if (failure === 'processor') f.processor.onprocessorerror();
    else { f.context.state = 'suspended'; f.context.dispatchEvent(new Event('statechange')); }
    assert.equal(errors.length, 1); assert.equal(f.track.stops, 1); await handle.stop();
  } finally { f.restore(); }
});

test('resume rejection settles while permission is pending and closes late tracks', async () => {
  const f = fixture({ pending: true, resumeFails: true });
  try {
    await assert.rejects(startMicrophone(() => {}, () => {}), /resume failed/);
    assert.equal(f.context.closes, 1); f.grant(); await tick(); assert.equal(f.track.stops, 1);
  } finally { f.restore(); }
});

test('capture graph setup failure releases acquired tracks', async () => {
  const f = fixture({ setupFails: true });
  try {
    await assert.rejects(startMicrophone(() => {}, () => {}), /source failed/);
    assert.equal(f.context.closes, 1); assert.equal(f.track.stops, 1);
  } finally { f.restore(); }
});
