import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../../node_modules/esbuild/lib/main.js';

const bundled = await build({ entryPoints: [new URL('../../src/stt-next/model.ts', import.meta.url).pathname],
  bundle: true, write: false, platform: 'node', format: 'esm' });
const { SpeechToTextModel, StreamingSpeechToTextModel, SttModelOwner } =
  await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text + '\n//# sourceURL=stt-lifecycle-bundle.mjs').toString('base64'));
const gate = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
// Bounded microtask/event-loop turns, never elapsed-time sleeps. Test timeouts are watchdogs only.
async function until(predicate, description = 'expected transition') {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(description);
}
const turn = () => new Promise(resolve => setImmediate(resolve));
const pcm = (length = 5120, value = 0.25) => ({ samples: new Float32Array(length).fill(value), sampleRate: 16000 });
function backend(kind = 'offline') {
  const calls = [];
  // Exactly SpeechToTextBackend's methods and return shapes; observations live outside it.
  const api = {
    kind,
    validate(options) { calls.push(['validate', options]); },
    async configure(options) { calls.push(['configure', options]); },
    async decode(samples) { calls.push(['decode', samples.slice()]); return { text: 'recognized' }; },
    async openStream() { calls.push(['open']); },
    async pushStream(samples, finish = false) { calls.push(['push', samples.slice(), finish]); return { text: 'recognized', isEndpoint: false }; },
    async resetStream() { calls.push(['reset']); },
    async closeStream() { calls.push(['close']); },
    setFailureHandler(handler) { failure = handler; },
    async unload() { calls.push(['unload']); },
  };
  let failure;
  return { api, calls, fail: error => failure(error) };
}
function fixture(t, kind = 'offline', live = false) {
  const b = backend(kind);
  const model = live ? new StreamingSpeechToTextModel(b.api) : new SpeechToTextModel(b.api);
  t.models.push(model);
  return { ...b, model };
}
const lifecycle = (name, body) => test(name, { timeout: 3000 }, async t => {
  t.models = [];
  try { await body(t); } finally {
    // Release test gates before teardown, including when an assertion fails.
    t.after(async () => { for (const model of t.models) await model.unload(); });
  }
});

lifecycle('FIFO is reserved before async Blob decoding; notifications follow handle return', async t => {
  const { calls, model } = fixture(t);
  const decoding = gate(); const entered = gate(); let closed = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'AudioContext');
  globalThis.AudioContext = class {
    decodeAudioData() { entered.resolve(); return decoding.promise; }
    async close() { closed++; }
  };
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'AudioContext', previous); else delete globalThis.AudioContext; });
  t.after(() => decoding.resolve({ sampleRate: 16000, length: 16, numberOfChannels: 1, getChannelData: () => pcm(16, 0.125).samples }));
  let first; const seen = [];
  first = model.transcribe(new Blob(['encoded']), { onTranscript: e => { assert.ok(first); seen.push(e.text); } });
  const second = model.transcribe(pcm(16, 0.5));
  await entered.promise; await turn();
  assert.equal(calls.filter(c => c[0] === 'decode').length, 0);
  decoding.resolve({ sampleRate: 16000, length: 16, numberOfChannels: 1, getChannelData: () => pcm(16, 0.125).samples });
  await Promise.all([first.result(), second.result()]); await turn();
  assert.deepEqual(calls.filter(c => c[0] === 'decode').map(c => c[1][0]), [0.125, 0.5]);
  assert.equal(closed, 1); assert.deepEqual(seen, ['recognized']);
});

lifecycle('queued cancel releases owned input immediately and never configures or infers it', async t => {
  const { api, calls, model } = fixture(t); const native = gate();
  t.after(() => native.resolve({ text: 'first' }));
  api.decode = samples => { calls.push(['decode', samples]); return native.promise; };
  const first = model.transcribe(pcm()); await until(() => calls.some(c => c[0] === 'decode'));
  const queued = model.transcribe(pcm(100, 0.75), { language: 'queued' });
  assert.ok(queued.input?.samples instanceof Float32Array, 'queued operation must own a snapshot before cancellation');
  queued.cancel(); queued.cancel();
  assert.deepEqual(await queued.result(), { text: '', stopReason: 'cancelled' });
  // White-box ownership check is deliberate: no nondeterministic GC/finalizer assertions.
  assert.equal(queued.input, undefined, 'cancel must drop the SDK-owned PCM snapshot');
  native.resolve({ text: 'first' }); await first.result(); await model.unload();
  assert.equal(calls.filter(c => c[0] === 'decode').length, 1);
  assert.ok(!calls.some(c => c[0] === 'configure' && c[1].language === 'queued'));
});

lifecycle('file input, hotwords, options and callback are captured at invocation', async t => {
  const { api, calls, model } = fixture(t); const blocked = gate(); let n = 0;
  t.after(() => blocked.resolve({ text: 'first' }));
  api.decode = async samples => { calls.push(['decode', samples.slice()]); return ++n === 1 ? blocked.promise : { text: 'second' }; };
  const first = model.transcribe(pcm(16)); await until(() => n === 1);
  const input = pcm(20, 0.5); const events = []; const hotwords = ['original'];
  const options = { language: 'en', hotwords, onTranscript: e => events.push(e.text) };
  const second = model.transcribe(input, options);
  input.samples.fill(0.875); hotwords[0] = 'mutated'; options.language = 'fr'; options.onTranscript = () => assert.fail('replacement callback used');
  blocked.resolve({ text: 'first' }); await first.result(); const result = await second.result(); await turn();
  assert.equal(calls.filter(c => c[0] === 'decode')[1][1][0], 0.5);
  const config = calls.filter(c => c[0] === 'configure')[1][1];
  assert.equal(config.language, 'en'); assert.deepEqual(config.hotwords, ['original']); assert.deepEqual(events, ['second']);
  second.cancel(); assert.equal(await second.result(), result); assert.equal(second.result(), second.result());
});

for (const live of [false, true]) lifecycle(`${live ? 'live' : 'file'} cancel settles before native work and retains provisional snapshot`, async t => {
  const { api, model } = fixture(t, 'online', live); const blocked = gate(); let count = 0;
  t.after(() => blocked.resolve({ text: 'late mutation', isEndpoint: true }));
  api.pushStream = async () => ++count === 1 ? { text: 'draft', isEndpoint: false } : blocked.promise;
  const events = [];
  const operation = live ? await model.createSession({ onTranscript: e => events.push(e) }) : model.transcribe(pcm(16000), { onTranscript: e => events.push(e) });
  if (live) await operation.push(pcm(16000));
  await until(() => count === 2 && events.length === 1);
  operation.cancel(); const result = await operation.result();
  assert.equal(result.stopReason, 'cancelled'); assert.equal(result.text, ''); assert.deepEqual(result.provisional, { text: 'draft' });
  if (live) { assert.deepEqual(result.segments, []); assert.equal(await operation.finish(), result); }
  const snapshot = structuredClone(result);
  blocked.resolve({ text: 'late mutation', isEndpoint: true }); await model.unload(); await turn();
  assert.deepEqual(result, snapshot); assert.equal(events.length, 1); assert.equal(await operation.result(), result);
});

lifecycle('replacement live session waits for cancelled native call AND stream cleanup; racing creates reject', async t => {
  const { api, calls, model } = fixture(t, 'online', true); const native = gate(); const closing = gate(); let pushes = 0; let closes = 0;
  t.after(() => { native.resolve({ text: 'stale', isEndpoint: false }); closing.resolve(); });
  api.pushStream = () => { pushes++; return native.promise; };
  api.closeStream = async () => { calls.push(['close']); if (++closes === 1) await closing.promise; };
  const first = await model.createSession(); await first.push(pcm()); await until(() => pushes === 1);
  first.cancel(); assert.equal((await first.result()).stopReason, 'cancelled');
  let ready = false; const next = model.createSession().then(s => { ready = true; return s; });
  await assert.rejects(model.createSession(), /session|queued|owns/i);
  await turn(); assert.equal(calls.filter(c => c[0] === 'open').length, 1); assert.equal(ready, false);
  native.resolve({ text: 'stale', isEndpoint: false }); await until(() => closes === 1);
  assert.equal(ready, false); assert.equal(calls.filter(c => c[0] === 'open').length, 1);
  closing.resolve(); const second = await next; second.cancel();
  assert.equal(calls.filter(c => c[0] === 'open').length, 2);
});

lifecycle('simultaneous initial creates reserve ownership before asynchronous configure', async t => {
  const { api, model } = fixture(t, 'online', true); const configure = gate();
  t.after(() => configure.resolve()); api.configure = () => configure.promise;
  const first = model.createSession(); await assert.rejects(model.createSession(), /session|queued|owns/i);
  configure.resolve(); (await first).cancel();
});

lifecycle('push owns reusable buffers; finish drains accepted input once and rejects subsequent input', async t => {
  const { api, model } = fixture(t, 'online', true); const native = gate(); const received = []; let count = 0;
  t.after(() => native.resolve({ text: 'first', isEndpoint: false }));
  api.pushStream = async (samples, finish) => { received.push([samples.slice(), finish]); return ++count === 1 ? native.promise : { text: 'all', isEndpoint: false }; };
  const session = await model.createSession(); const input = pcm(5120, 0.125);
  await session.push(input); input.samples.fill(0.5); await session.push(input); input.samples.fill(0.75);
  const acceptance = session.push(input); const finishing = session.finish(); await acceptance; input.samples.fill(1);
  assert.equal(session.finish(), finishing); await assert.rejects(session.push(pcm()), /accept/i);
  let settled = false; void session.result().then(() => { settled = true; }); await turn(); assert.equal(settled, false);
  native.resolve({ text: 'first', isEndpoint: false }); const result = await finishing;
  assert.equal(result.stopReason, 'complete'); assert.equal(await session.result(), result);
  const flattened = Float32Array.from(received.flatMap(([s]) => Array.from(s)));
  assert.deepEqual(flattened, Float32Array.from([...pcm(5120, 0.125).samples, ...pcm(5120, 0.5).samples, ...pcm(5120, 0.75).samples]));
  assert.equal(received.filter(([, finish]) => finish).length, 1);
});

lifecycle('invalid and empty input reject; supplied silence succeeds; invalid push does not kill valid work', async t => {
  t.mock.method(console, 'error', () => {});
  const file = fixture(t); assert.throws(() => file.model.transcribe(pcm(0)), /nonempty/i);
  await assert.rejects(file.model.transcribe(new Blob([])).result(), /empty/i);
  const { api, model } = fixture(t, 'offline', true); api.decode = async () => ({ text: '' });
  const empty = await model.createSession(); await assert.rejects(empty.finish(), /without audio|empty/i);
  const session = await model.createSession();
  await session.push(pcm(32, 0)); await assert.rejects(session.push(pcm(0)), /nonempty/i);
  await assert.rejects(session.push({ samples: new Float32Array([NaN]), sampleRate: 16000 }), /finite/i);
  const result = await session.finish(); assert.deepEqual(result, { text: '', segments: [], stopReason: 'complete' });
});

lifecycle('opt-in backlog fails once with the same error; default has no audio cap', async t => {
  t.mock.method(console, 'error', () => {});
  const { model } = fixture(t, 'online', true); const errors = [];
  const limited = await model.createSession({ maxBufferedAudioMs: 1, onError: error => errors.push(error) });
  await limited.push(pcm());
  let failure; await assert.rejects(limited.result(), e => { failure = e; return /maxBufferedAudioMs/.test(e.message); });
  await assert.rejects(limited.finish(), e => e === failure); await assert.rejects(limited.push(pcm()));
  await turn(); assert.deepEqual(errors, [failure]); assert.deepEqual(failure.partialResult, { text: '', segments: [] });
  const unlimited = await model.createSession(); await unlimited.push(pcm(16000 * 70));
  assert.equal((await unlimited.finish()).stopReason, 'complete');
});

lifecycle('live IDs survive retraction and finalization, duplicate hypotheses emit no spam', async t => {
  const { api, model } = fixture(t, 'online', true); const events = []; let index = 0;
  const outputs = [['draft', false], ['draft', false], ['', false], ['', false], ['final', true], ['next', false], ['next', false]];
  api.pushStream = async () => { const [text, isEndpoint] = outputs[index++] ?? ['next', false]; return { text, isEndpoint }; };
  const session = await model.createSession({ onTranscript: e => events.push(e) });
  await session.push(pcm(5120 * outputs.length)); await until(() => index === outputs.length); await turn();
  assert.deepEqual(events.map(e => [e.id, e.text, e.isFinal]), [['0', 'draft', false], ['0', '', false], ['0', 'final', true], ['1', 'next', false]]);
  const result = await session.finish(); await turn();
  assert.deepEqual(result.segments.map(s => [s.id, s.text]), [['0', 'final'], ['1', 'next']]);
  assert.equal(result.text, 'final next'); assert.equal(events.length, 5);
});

lifecycle('callback throw, rejection and never-settling promise cannot hang control promises', async t => {
  const { api, model } = fixture(t, 'online', true); const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args));
  let count = 0; api.pushStream = async () => ({ text: String(++count), isEndpoint: false });
  let session; const events = [];
  session = await model.createSession({ onTranscript: e => {
    assert.ok(session); events.push(e); if (events.length === 1) throw Error('sync UI');
    if (events.length === 2) return Promise.reject(Error('async UI'));
    return new Promise(() => {});
  }, onError: () => assert.fail('application callback errors must not fail recognition') });
  await session.push(pcm(5120 * 4)); const result = await session.finish(); await turn();
  assert.equal(result.stopReason, 'complete'); assert.ok(events.length >= 3);
  assert.equal(logs.filter(args => args.some(arg => arg?.message === 'sync UI' || arg?.message === 'async UI')).length, 2);
});

lifecycle('failure shares one error and stable partial snapshot across onError/result/finish', async t => {
  const { api, model } = fixture(t, 'online', true); const native = gate(); const errors = []; const cause = Error('native failure'); let count = 0;
  t.after(() => native.resolve({ text: 'late', isEndpoint: true }));
  api.pushStream = async () => { if (++count === 1) return { text: 'final', isEndpoint: true }; if (count === 2) return { text: 'draft', isEndpoint: false }; return native.promise; };
  const session = await model.createSession({ onError: error => { errors.push(error); return Promise.reject(Error('error UI')); } });
  const logs = []; t.mock.method(console, 'error', (...args) => logs.push(args));
  await session.push(pcm(5120 * 3)); await until(() => count === 3); native.reject(cause);
  let failure; await assert.rejects(session.result(), error => { failure = error; return error.name === 'TranscriptionError'; });
  await assert.rejects(session.finish(), error => error === failure); await turn();
  assert.equal(failure.cause, cause); assert.deepEqual(errors, [failure]);
  assert.deepEqual(failure.partialResult, { text: 'final', segments: [{ id: '0', text: 'final' }], provisional: { text: 'draft' } });
  assert.equal('stopReason' in failure.partialResult, false); const snapshot = structuredClone(failure.partialResult);
  session.cancel(); await assert.rejects(session.push(pcm()));
  const next = await model.createSession(); next.cancel(); await model.unload();
  assert.deepEqual(failure.partialResult, snapshot); assert.equal(errors.length, 1);
  assert.ok(logs.some(args => args.some(arg => arg?.message === 'error UI')));
});

for (const kind of ['online', 'offline']) lifecycle(`${kind} live >25s windows and irregular tails account for every nonzero input sample`, async t => {
  const { api, model } = fixture(t, kind, true); const seen = new Uint8Array(16000 * 53 + 137); const events = []; const ranges = [];
  // Every value encodes its input position exactly, stays nonzero, and avoids silence endpoints.
  const samples = Float32Array.from({ length: seen.length }, (_, i) => (i + 1) / 1048576);
  const references = []; let expectedReference; let expectedWindowStart = 0;
  const record = chunk => {
    if (!chunk.length) return;
    const first = Math.round(chunk[0] * 1048576) - 1;
    const end = first + chunk.length;
    // Validate reference samples too, but they must never count as new coverage.
    assert.deepEqual(chunk, samples.subarray(first, end), 'native input remains contiguous and ordered');
    if (kind === 'offline' && expectedReference) {
      assert.deepEqual([first, end], expectedReference, 'one exact 3s suffix reference precedes the next window after rotation');
      references.push([first, end]); expectedReference = undefined;
      return [first, end];
    }
    if (kind === 'offline') {
      assert.equal(first, expectedWindowStart, 'only a full window rotates the main decode origin');
      if (chunk.length === 25 * 16000) {
        expectedReference = [end - 3 * 16000, end];
        expectedWindowStart += 22 * 16000;
      }
    }
    for (let index = first; index < end; index++) seen[index]++;
    ranges.push([first, end]);
    return [first, end];
  };
  api.decode = async chunk => {
    const [first, end] = record(chunk);
    // Recognition depends on actual audio positions, including the short reference.
    return { text: Array.from({ length: Math.ceil(end / 16000) - Math.floor(first / 16000) },
      (_, i) => `second${Math.floor(first / 16000) + i}`).join(' ') };
  };
  api.pushStream = async (chunk, finish) => { record(chunk); return { text: finish ? 'whole utterance' : 'draft', isEndpoint: false }; };
  const session = await model.createSession({ onTranscript: e => events.push(e) });
  // Feed while recognition is open, including multiple full windows, then an odd tail.
  for (let start = 0; start < samples.length; start += 16000 * 7 + 19) {
    await session.push({ samples: samples.slice(start, start + 16000 * 7 + 19), sampleRate: 16000 });
    await turn();
  }
  const result = await session.finish(); await turn();
  assert.equal(result.stopReason, 'complete'); assert.equal(seen.findIndex(n => n === 0), -1, 'no sample may disappear between windows or at finish');
  assert.equal(ranges.at(-1)[1], samples.length); assert.equal(result.segments.length, 1, 'native windows must not become artificial utterances');
  assert.equal(result.segments[0].id, '0'); assert.equal(events.filter(e => e.isFinal).length, 1);
  if (kind === 'online') assert.ok(seen.every(n => n === 1), 'online input must not be replayed');
  else {
    assert.ok(ranges.every(([start, end]) => end - start <= 25 * 16000));
    assert.deepEqual(references, [[22 * 16000, 25 * 16000], [44 * 16000, 47 * 16000]]);
    assert.equal(expectedReference, undefined);
    assert.equal(result.text, Array.from({ length: 54 }, (_, i) => `second${i}`).join(' '));
  }
});

lifecycle('unload cancels queued files immediately but waits for active native work before teardown', async t => {
  const { api, calls, model } = fixture(t); const native = gate(); let entered = false;
  t.after(() => native.resolve({ text: 'late' }));
  api.decode = async () => { entered = true; return native.promise; };
  const active = model.transcribe(pcm()); await until(() => entered); const queued = model.transcribe(pcm());
  const cleanup = model.unload(); assert.equal(model.unload(), cleanup);
  assert.equal((await active.result()).stopReason, 'cancelled'); assert.equal((await queued.result()).stopReason, 'cancelled');
  assert.throws(() => model.transcribe(pcm()), /unloaded/i); await turn();
  assert.equal(calls.filter(c => c[0] === 'unload').length, 0);
  native.resolve({ text: 'late' }); await cleanup; assert.equal(calls.filter(c => c[0] === 'unload').length, 1);
});

lifecycle('internal STT model owner enforces mixed live/file exclusivity including pending creation', async t => {
  const b = backend('online');
  // The internal owner is intentionally not part of the public consumer surface.
  const owner = new SttModelOwner(b.api);
  t.models.push(owner);
  const configuring = gate(); t.after(() => configuring.resolve()); b.api.configure = () => configuring.promise;
  const pending = owner.createSession(); assert.throws(() => owner.transcribe(pcm()), /live|owns/i);
  configuring.resolve(); const session = await pending; assert.throws(() => owner.transcribe(pcm()), /live|owns/i);
  session.cancel(); const operation = owner.transcribe(pcm());
  await assert.rejects(owner.createSession(), /session|queued/i); await operation.result();
  const next = await owner.createSession(); next.cancel();
});

lifecycle('silence after a finalized endpoint does not retract a nonexistent next utterance', async t => {
  const { api, model } = fixture(t, 'online', true); const events = []; let count = 0;
  api.pushStream = async () => ++count === 1 ? { text: 'done', isEndpoint: true } : { text: '', isEndpoint: false };
  const session = await model.createSession({ onTranscript: e => events.push(e) });
  await session.push(pcm(5120 * 3)); const result = await session.finish(); await turn();
  assert.deepEqual(events.map(e => [e.id, e.text, e.isFinal]), [['0', 'done', true]]);
  assert.deepEqual(result.segments, [{ id: '0', text: 'done' }]);
});

lifecycle('session options and callbacks snapshot before configure resolves; result alone never finishes', async t => {
  const { api, calls, model } = fixture(t, 'online', true); const configure = gate(); const events = [];
  t.after(() => configure.resolve());
  api.configure = async options => { calls.push(['configure', options]); await configure.promise; };
  const hotwords = ['original']; const options = { hotwords, language: 'en', onTranscript: e => events.push(e) };
  const creating = model.createSession(options); hotwords[0] = 'mutated'; options.language = 'fr';
  let wrongCallback = false; options.onTranscript = () => { wrongCallback = true; };
  configure.resolve(); const session = await creating; let settled = false;
  void session.result().then(() => { settled = true; }); await session.push(pcm()); await turn();
  assert.equal(settled, false); assert.equal(wrongCallback, false); assert.equal(events.length, 1);
  const config = calls.find(c => c[0] === 'configure')[1]; assert.deepEqual(config.hotwords, ['original']); assert.equal(config.language, 'en');
  await session.finish();
});

lifecycle('cancel during finish wins over late native failure and keeps the established provisional', async t => {
  const { api, model } = fixture(t, 'online', true); const native = gate(); let count = 0; const errors = [];
  t.after(() => native.resolve({ text: 'late', isEndpoint: true }));
  api.pushStream = async () => ++count === 1 ? { text: 'draft', isEndpoint: false } : native.promise;
  const session = await model.createSession({ onError: error => errors.push(error) });
  await session.push(pcm()); await until(() => count === 1); await turn();
  const finishing = session.finish(); await until(() => count === 2); session.cancel();
  const result = await finishing; assert.deepEqual(result, { text: '', segments: [], provisional: { text: 'draft' }, stopReason: 'cancelled' });
  native.reject(Error('late decode failure')); await model.unload(); await turn();
  assert.equal(await session.result(), result); assert.deepEqual(errors, []);
});

lifecycle('online unload waits for native call and stream close, cancels pending replacement', async t => {
  const { api, calls, model } = fixture(t, 'online', true); const native = gate(); const close = gate(); let entered = false;
  t.after(() => { native.resolve({ text: 'late', isEndpoint: false }); close.resolve(); });
  api.pushStream = () => { entered = true; return native.promise; };
  api.closeStream = async () => { calls.push(['close']); await close.promise; };
  const session = await model.createSession(); await session.push(pcm()); await until(() => entered); session.cancel();
  const next = model.createSession(); const nextRejected = assert.rejects(next, /unloaded/i);
  const unloading = model.unload(); assert.equal(model.unload(), unloading);
  await assert.rejects(model.createSession(), /unloaded/i); assert.equal((await session.result()).stopReason, 'cancelled');
  native.resolve({ text: 'late', isEndpoint: false }); await until(() => calls.some(c => c[0] === 'close'));
  assert.equal(calls.filter(c => c[0] === 'unload').length, 0);
  close.resolve(); await nextRejected; await unloading;
  assert.equal(calls.filter(c => c[0] === 'open').length, 1); assert.equal(calls.filter(c => c[0] === 'unload').length, 1);
});

lifecycle('file failure retains finalized metadata snapshot and does not return a success stopReason', async t => {
  const { api, model } = fixture(t); const cause = Error('second window failed'); let count = 0;
  const data = { text: 'first', words: [{ text: 'first', timing: { startMs: 0, endMs: 500 } }], segments: [{ text: 'first', timing: { startMs: 0, endMs: 500 } }] };
  api.decode = async () => { if (++count === 1) return data; throw cause; };
  const operation = model.transcribe(pcm(16000 * 26)); let failure;
  await assert.rejects(operation.result(), error => { failure = error; return error.name === 'TranscriptionError'; });
  assert.equal(failure.cause, cause); assert.deepEqual(failure.partialResult, data); assert.equal('stopReason' in failure.partialResult, false);
  const snapshot = structuredClone(failure.partialResult); data.words[0].timing.endMs = 999; data.segments[0].text = 'mutated';
  operation.cancel(); await assert.rejects(operation.result(), error => error === failure); assert.deepEqual(failure.partialResult, snapshot);
});

lifecycle('complete-audio offline windows partition >50s input exactly, including odd tail and metadata offsets', async t => {
  const { api, model } = fixture(t); const input = Float32Array.from({ length: 16000 * 52 + 37 }, (_, i) => (i + 1) / 1048576);
  const windows = []; let consumed = 0;
  api.decode = async samples => {
    assert.deepEqual(samples, input.subarray(consumed, consumed + samples.length));
    windows.push([consumed, samples.length]); consumed += samples.length;
    return { text: `part${windows.length}`, words: [{ text: `part${windows.length}`, timing: { startMs: 0, endMs: samples.length / 16 } }] };
  };
  const result = await model.transcribe({ samples: input, sampleRate: 16000 }).result();
  assert.equal(consumed, input.length); assert.equal(windows.length, 3);
  assert.equal(result.text, 'part1 part2 part3');
  assert.deepEqual(result.words.map(w => w.timing), windows.map(([start, length]) => ({ startMs: start / 16, endMs: (start + length) / 16 })));
});

lifecycle('decoded multichannel input snapshots before queueing and downmixes all channels', async t => {
  const { api, model } = fixture(t); const native = gate(); let count = 0; let received;
  t.after(() => native.resolve({ text: 'first' }));
  api.decode = async samples => { if (++count === 1) return native.promise; received = samples.slice(); return { text: 'mixed' }; };
  const first = model.transcribe(pcm(16)); await until(() => count === 1);
  const channels = [pcm(80, 0.25).samples, pcm(80, 0.75).samples];
  const buffer = { length: 80, sampleRate: 16000, numberOfChannels: 2, getChannelData: index => channels[index] };
  const operation = model.transcribe(buffer); channels[0].fill(0); channels[1].fill(0);
  native.resolve({ text: 'first' }); await first.result(); await operation.result();
  assert.deepEqual(received, pcm(80, 0.5).samples);
});

lifecycle('live backlog ignores decoded offline lookback retained for the next recognition window', async t => {
  const { api, model } = fixture(t, 'offline', true); let decoded = 0; const errors = [];
  api.decode = async () => { decoded++; return { text: 'draft' }; };
  const session = await model.createSession({ maxBufferedAudioMs: 4500, onError: e => errors.push(e) });
  await session.push(pcm(16000 * 4)); await until(() => decoded === 1); await turn();
  // Six seconds are retained, but only the new two seconds are pending work.
  await session.push(pcm(16000 * 2)); await until(() => decoded === 2); await turn();
  assert.equal((await session.finish()).stopReason, 'complete'); assert.deepEqual(errors, []);
});

lifecycle('onError-only consumers cause no hidden unhandled rejection and preserve callback identity', async t => {
  const { api, model } = fixture(t, 'online', true); const observed = gate(); const errors = [];
  t.mock.method(console, 'error', () => {});
  api.pushStream = async () => { throw Error('backend failed'); };
  const options = { onError: error => { errors.push(error); observed.resolve(); } };
  const session = await model.createSession(options); options.onError = () => assert.fail('mutated callback');
  await session.push(pcm()); await observed.promise;
  // Node's test runner independently fails on an SDK-created unhandled rejection here.
  await turn(); await assert.rejects(session.result(), error => error === errors[0]);
  await assert.rejects(session.finish(), error => error === errors[0]); assert.equal(errors.length, 1);
});

// Sample values encode positions, so identical words cannot hide a wrong overlap slice.
const positionedPcm = (seconds, startSecond = 0) => ({ sampleRate: 16000,
  samples: Float32Array.from({ length: seconds * 16000 }, (_, i) => (startSecond * 16000 + i + 1) / 1048576) });
function windowRecognizer(api, wordsForRange) {
  const ranges = [];
  api.decode = async samples => {
    const start = Math.round(samples[0] * 1048576) - 1;
    const end = start + samples.length;
    assert.equal(start % 16000, 0); assert.equal(end % 16000, 0);
    assert.deepEqual(samples, positionedPcm(samples.length / 16000, start / 16000).samples);
    ranges.push([start / 16000, end / 16000]);
    return { text: wordsForRange(start / 16000, end / 16000).join(' ') };
  };
  return ranges;
}

lifecycle('25 seconds of repeated yes plus 2 seconds retain all 27 words with one actual overlap reference', async t => {
  const { api, model } = fixture(t, 'offline', true); const events = [];
  const ranges = windowRecognizer(api, (start, end) => Array(end - start).fill('yes'));
  const session = await model.createSession({ onTranscript: event => events.push(event) });
  await session.push(positionedPcm(25));
  await until(() => events.length === 1); await turn();
  assert.deepEqual(ranges, [[0, 25]], 'reference decode is deferred until new audio needs another window');
  assert.equal(events.at(-1).text.split(' ').length, 25);
  await session.push(positionedPcm(2, 25));
  await until(() => ranges.length === 3); await turn();
  const result = await session.finish(); await turn();
  assert.deepEqual(ranges, [[0, 25], [22, 25], [22, 27]], 'finish must not re-decode the already recognized 5s remainder');
  assert.deepEqual(result.text.split(' '), Array(27).fill('yes'));
  assert.deepEqual(result.segments, [{ id: '0', text: result.text }]);
  assert.deepEqual(events.map(e => [e.id, e.text.split(' ').length, e.isFinal]),
    [['0', 25, false], ['0', 27, false], ['0', 27, true]]);
});

lifecycle('overlap spelling revision replaces recognize with recognise without duplicating the 3s phrase', async t => {
  const { api, model } = fixture(t, 'offline', true); const prefix = Array.from({ length: 22 }, (_, i) => `word${i}`);
  const ranges = windowRecognizer(api, (start, end) => {
    if (start === 0 && end === 25) return [...prefix, 'we', 'recognize', 'speech'];
    if (start === 22 && end === 25) return ['we', 'recognize', 'speech'];
    assert.deepEqual([start, end], [22, 27]);
    return ['we', 'recognise', 'speech', 'very', 'clearly'];
  });
  const session = await model.createSession(); await session.push(positionedPcm(25));
  await until(() => ranges.length === 1); await turn();
  assert.deepEqual(ranges, [[0, 25]]);
  await session.push(positionedPcm(2, 25)); await until(() => ranges.length === 3); await turn();
  const result = await session.finish();
  assert.deepEqual(result.text.split(' '), [...prefix, 'we', 'recognise', 'speech', 'very', 'clearly']);
  assert.deepEqual(ranges, [[0, 25], [22, 25], [22, 27]]);
});

lifecycle('finish of unchanged 24s with zero resampler tail finalizes cached text and metadata after exactly one decode', async t => {
  const { api, model } = fixture(t, 'offline', true); const chunks = []; const events = [];
  const words = [{ text: 'complete', timing: { startMs: 23000, endMs: 24000 } }];
  api.decode = async samples => { chunks.push(samples.slice()); return { text: 'complete', words }; };
  const session = await model.createSession({ onTranscript: event => events.push(event) });
  await session.push(pcm(24 * 16000)); await until(() => events.length === 1); await turn();
  assert.equal(chunks.length, 1); assert.equal(chunks[0].length, 24 * 16000);
  const finishing = session.finish(); assert.equal(session.finish(), finishing);
  const result = await finishing; await turn();
  assert.equal(chunks.length, 1, 'zero new samples must not trigger full-window inference');
  assert.deepEqual(events.map(e => e.isFinal), [false, true]);
  assert.deepEqual(result.segments, [{ id: '0', text: 'complete', words }]);
});

for (const sampleRate of [8000, 48000]) lifecycle(`finish decodes the genuinely new ${sampleRate}Hz resampler tail once rather than reusing stale 24s recognition`, async t => {
  const { api, model } = fixture(t, 'offline', true); const chunks = []; const events = [];
  api.decode = async samples => {
    chunks.push(samples.slice());
    return { text: samples.length === 24 * 16000 ? 'including tail' : 'before tail' };
  };
  const session = await model.createSession({ onTranscript: event => events.push(event) });
  await session.push({ samples: new Float32Array(24 * sampleRate).fill(0.25), sampleRate });
  await until(() => events.length === 1); await turn();
  assert.equal(chunks.length, 1);
  // Linear upsampling retains one output sample; the 48kHz sinc filter retains 24.
  assert.equal(chunks[0].length, 24 * 16000 - (sampleRate === 8000 ? 1 : 24));
  const finishing = session.finish(); assert.equal(session.finish(), finishing);
  const result = await finishing; await turn();
  assert.equal(chunks.length, 2, 'new tail requires one refreshed decode, not zero or repeated decodes');
  assert.equal(chunks[1].length, 24 * 16000);
  assert.deepEqual(chunks[1].subarray(0, chunks[0].length), chunks[0]);
  assert.ok(chunks[1].subarray(chunks[0].length).every(value => Math.abs(value - 0.25) < 1e-6));
  assert.equal(result.text, 'including tail'); assert.deepEqual(events.map(e => [e.text, e.isFinal]), [['before tail', false], ['including tail', true]]);
});

lifecycle('finish at exactly 25s with no new audio skips both overlap reference and retained-context decode', async t => {
  const { api, model } = fixture(t, 'offline', true); const events = [];
  const ranges = windowRecognizer(api, (start, end) => Array(end - start).fill('yes'));
  const session = await model.createSession({ onTranscript: event => events.push(event) });
  await session.push(positionedPcm(25)); await until(() => events.length === 1); await turn();
  const result = await session.finish(); await turn();
  assert.deepEqual(ranges, [[0, 25]], 'retained 3s are already recognized and cannot justify another decode');
  assert.deepEqual(result.text.split(' '), Array(25).fill('yes'));
  assert.deepEqual(events.map(e => e.isFinal), [false, true]);
});

for (const [boundary, previous, expected] of [
  ['unrelated predecessor', 'Keep important two three', 'Keep important one two three four five'],
  ['repeated boundary word', 'Keep two two three', 'Keep two one two three four five'],
]) {
lifecycle(`direct overlap matching preserves ${boundary} outside the actual anchor alignment`, async () => {
  const compiled = await build({ entryPoints: [new URL('../../src/stt-next/transcript.ts', import.meta.url).pathname],
    bundle: true, write: false, platform: 'node', format: 'esm' });
  const { overlapText } = await import('data:text/javascript;base64,' +
    Buffer.from(compiled.outputFiles[0].text + '\n//# sourceURL=stt-transcript-regression.mjs').toString('base64'));
  assert.deepEqual(overlapText(previous, 'one two three four five', 'one two three'), {
    text: expected, droppedWords: 2,
  });
});

lifecycle(`live overlap preserves ${boundary} before a partially recognized overlap boundary`, async t => {
  const { api, model } = fixture(t, 'offline', true); const events = [];
  const ranges = windowRecognizer(api, (start, end) => {
    if (start === 0 && end === 25) return previous.split(' ');
    if (start === 22 && end === 25) return ['one', 'two', 'three'];
    assert.deepEqual([start, end], [22, 27]);
    return ['one', 'two', 'three', 'four', 'five'];
  });
  const session = await model.createSession({ onTranscript: event => events.push(event) });
  await session.push(positionedPcm(25)); await until(() => events.length === 1); await turn();
  assert.deepEqual(ranges, [[0, 25]]);
  assert.equal(events[0].text, previous);
  await session.push(positionedPcm(2, 25)); await until(() => events.length === 2); await turn();
  const result = await session.finish(); await turn();
  assert.deepEqual(ranges, [[0, 25], [22, 25], [22, 27]], 'reference must describe the actual retained 3s, and finish must reuse the decoded window');
  assert.equal(result.text, expected);
  assert.deepEqual(result.segments, [{ id: '0', text: expected }]);
  assert.deepEqual(events.map(event => [event.id, event.text, event.isFinal]),
    [['0', previous, false], ['0', expected, false], ['0', expected, true]]);
});
}
