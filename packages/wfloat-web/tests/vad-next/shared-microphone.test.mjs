import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../../node_modules/esbuild/lib/main.js';
const root = new URL('../../', import.meta.url).pathname;
const bundle = await build({ stdin: { contents: `export * from './src/audio-next/microphone.ts'; export {LiveSession} from './src/stt-next/session.ts';`, resolveDir: root }, bundle: true, write: false, format: 'esm', platform: 'node' });
const { createMicrophoneCapture, createMicrophoneCaptureWithFactory: create, attachCapture, LiveSession } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const turn = () => new Promise(resolve => setImmediate(resolve));
const pcm = (length = 480, sampleRate = 48000) => ({ samples: new Float32Array(length).fill(.25), sampleRate });
function harness() {
  let audio, error, signal, starts = 0, stops = 0;
  const mic = create((a, e, s) => { audio = a; error = e; signal = s; starts++; return Promise.resolve({ async stop() { stops++; } }); });
  return { mic, send: a => audio(a), fail: e => error(e), get starts() { return starts; }, get stops() { return stops; }, get signal() { return signal; } };
}
function session(options = {}) {
  const chunks = [];
  const live = new LiveSession({ kind: 'online', async pushStream(samples, end) { chunks.push(samples); return { text: end ? 'heard' : 'draft', isEndpoint: false }; }, async resetStream() {} }, options, () => {});
  return { live, chunks };
}
const quiet = fn => async () => { const old = console.error; console.error = () => {}; try { await fn(); } finally { console.error = old; } };

test('public helper prepares synchronously; stop before start is terminal', async () => {
  const mic = createMicrophoneCapture();
  assert.equal(typeof mic.start, 'function');
  const stopped = mic.stop(); assert.equal(mic.stop(), stopped); await stopped;
  await assert.rejects(mic.start(), /terminal/);
  assert.throws(() => attachCapture(mic, () => {}, () => {}), /before capture starts/);
});
test('branding, synchronous start, shared native timeline, independent copies and detach', async () => {
  const h = harness(), seen = [];
  assert.equal(h.starts, 0);
  assert.throws(() => attachCapture({ start() {}, stop() {} }, () => {}, () => {}), /Expected a MicrophoneCapture/);
  assert.throws(() => attachCapture({ ...h.mic }, () => {}, () => {}), /Expected a MicrophoneCapture/);
  const detach = attachCapture(h.mic, a => { seen.push(a.samples[0]); a.samples.fill(99); }, assert.fail);
  attachCapture(h.mic, a => seen.push([a.samples[0], a.sampleRate, a.samples.length]), assert.fail);
  const started = h.mic.start(); assert.equal(h.starts, 1); assert.equal(h.mic.start(), started);
  assert.throws(() => attachCapture(h.mic, () => {}, () => {}), /before capture starts/);
  await started;
  const input = pcm(); h.send(input); assert.equal(input.samples[0], .25);
  detach(); detach(); h.send(input);
  assert.deepEqual(seen, [.25, [.25, 48000, 480], [.25, 48000, 480]]);
  await h.mic.stop(); h.send(input); assert.equal(seen.length, 3); assert.equal(h.stops, 1);
  await assert.rejects(h.mic.start(), /terminal/);
});
for (const asyncThrow of [false, true]) test(`consumer ${asyncThrow ? 'async' : 'sync'} failure isolates siblings`, quiet(async () => {
  const h = harness(), cause = Error('dependent failed'), errors = []; let received = 0;
  attachCapture(h.mic, () => { if (asyncThrow) return Promise.reject(cause); throw cause; }, e => { errors.push(e); return Promise.reject(Error('error callback')); });
  attachCapture(h.mic, () => received++, assert.fail);
  await h.mic.start(); h.send(pcm()); await turn(); h.send(pcm()); await turn();
  assert.deepEqual(errors, [cause]); assert.equal(received, 2); assert.equal(h.stops, 0);
  await h.mic.stop();
}));
for (const synchronous of [false, true]) test(`startup failure (${synchronous ? 'sync' : 'async'}) fails all dependents once`, async () => {
  const cause = Error('permission denied'), errors = [];
  const mic = create(() => { if (synchronous) throw cause; return Promise.reject(cause); });
  attachCapture(mic, assert.fail, e => errors.push(e)); attachCapture(mic, assert.fail, e => errors.push(e));
  await assert.rejects(mic.start(), e => e === cause); assert.deepEqual(errors, [cause, cause]);
  await mic.stop(); await assert.rejects(mic.start(), /terminal/);
});
test('stop promptly cancels pending permission and closes late acquisition exactly once', async () => {
  let resolve, signal, stops = 0;
  const mic = create((_, __, s) => { signal = s; return new Promise(r => resolve = r); });
  attachCapture(mic, assert.fail, assert.fail);
  const start = mic.start(); const stop = mic.stop(); assert.equal(stop, mic.stop()); await stop;
  assert.equal(signal.aborted, true); await assert.rejects(start, { name: 'AbortError' });
  resolve({ async stop() { stops++; } }); await turn(); assert.equal(stops, 1);
});
test('failure during acquisition closes late capture and preserves first error', async () => {
  let resolve, fail, stops = 0; const errors = [], cause = Error('disconnected');
  const mic = create((_, e) => { fail = e; return new Promise(r => resolve = r); });
  attachCapture(mic, assert.fail, e => errors.push(e)); const start = mic.start(); fail(cause); fail(Error('second'));
  await assert.rejects(start, e => e === cause); resolve({ async stop() { stops++; } }); await turn();
  assert.deepEqual(errors, [cause]); assert.equal(stops, 1); await mic.stop();
});
test('stop waits for running cleanup; cleanup rejection is observed and repeatable', async () => {
  let reject; const cause = Error('close failed');
  const mic = create(async () => ({ stop: () => new Promise((_, r) => reject = r) }));
  await mic.start(); const stop = mic.stop(); assert.equal(stop, mic.stop()); reject(cause);
  await assert.rejects(stop, e => e === cause);
});
test('STT attaches before start, resamples equally, finishes independently, rejects mixing', async () => {
  const h = harness(), a = session(), b = session();
  await a.live.attachMicrophone(h.mic); await b.live.attachMicrophone(h.mic); assert.equal(h.starts, 0);
  await assert.rejects(a.live.push(pcm()), /mix sources/);
  await assert.rejects(a.live.startMicrophone(), /mix sources/);
  await assert.rejects(a.live.attachMicrophone(h.mic), /mix sources/);
  await h.mic.start(); h.send(pcm(4800));
  assert.equal((await a.live.finish()).text, 'heard'); assert.equal(h.stops, 0);
  const c = session(); await assert.rejects(c.live.attachMicrophone(h.mic), /before capture starts/); c.live.cancel();
  h.send(pcm(4800)); await h.mic.stop(); assert.equal((await b.live.finish()).text, 'heard');
  assert.equal(a.chunks.flatMap(a => [...a]).length, 1600);
  assert.equal(b.chunks.flatMap(a => [...a]).length, 3200);
  assert.deepEqual(a.chunks.flatMap(a => [...a]), b.chunks.flatMap(a => [...a]).slice(0, 1600));
  await Promise.all([a.live.released, b.live.released]);
});
test('invalid attachment leaves STT usable; prior input and owned capture reject attachment', async () => {
  const a = session(), h = harness();
  await assert.rejects(a.live.attachMicrophone({}), /Expected a MicrophoneCapture/);
  await a.live.push(pcm()); await assert.rejects(a.live.attachMicrophone(h.mic), /mix sources/); await a.live.finish();
  let stops = 0;
  const owned = new LiveSession({}, {}, () => {}, async () => ({ async stop() { stops++; } }));
  await owned.startMicrophone(); await assert.rejects(owned.attachMicrophone(h.mic), /mix sources/); owned.cancel();
  await owned.released; assert.equal(stops, 1); await h.mic.stop();
});
test('STT cancellation and consumer failure detach independently; source failure fails remaining sessions', quiet(async () => {
  const h = harness(), cancelled = session(), failed = session({ maxBufferedAudioMs: 1 }), errors = [];
  const remaining = session({ onError: e => errors.push(e) });
  for (const s of [cancelled, failed, remaining]) await s.live.attachMicrophone(h.mic);
  cancelled.live.cancel(); await h.mic.start(); h.send(pcm(4800));
  await assert.rejects(failed.live.result(), /maxBufferedAudioMs/); assert.equal(h.stops, 0);
  const cause = Error('track lost'); h.fail(cause); h.fail(Error('again')); await turn();
  await assert.rejects(remaining.live.result(), e => e === errors[0] && e.cause === cause);
  assert.equal(errors.length, 1); assert.equal((await cancelled.live.result()).stopReason, 'cancelled'); assert.equal(h.stops, 1);
  await h.mic.stop(); await Promise.all([cancelled.live.released, failed.live.released, remaining.live.released]);
}));
test('intentional source stop leaves STT completion under caller control', async () => {
  const h = harness(), a = session(); await a.live.attachMicrophone(h.mic); await h.mic.start(); h.send(pcm()); await h.mic.stop();
  let settled = false; void a.live.result().then(() => settled = true); await turn(); assert.equal(settled, false);
  assert.equal((await a.live.finish()).stopReason, 'complete');
});
test('detaching every consumer leaves capture owned by the helper', async () => {
  const h = harness(); const detach = attachCapture(h.mic, assert.fail, assert.fail);
  await h.mic.start(); detach(); h.send(pcm()); assert.equal(h.stops, 0);
  await h.mic.stop(); assert.equal(h.stops, 1);
});
test('ignored startup/cleanup promises and abort-aware permission rejection are handled internally', quiet(async () => {
  const unhandled = []; const observe = e => unhandled.push(e); process.on('unhandledRejection', observe);
  try {
    const failed = create(() => { throw Error('startup'); }); failed.start();
    const pending = create((_, __, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')))));
    pending.start(); await pending.stop();
    const active = create(async () => ({ stop() { throw Error('cleanup'); } })); await active.start(); active.stop();
    await turn(); await turn(); assert.deepEqual(unhandled, []);
  } finally { process.off('unhandledRejection', observe); }
}));
