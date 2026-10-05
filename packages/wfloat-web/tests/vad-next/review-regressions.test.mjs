import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from '../../node_modules/esbuild/lib/main.js';

// One bundle preserves the capture brand across the real VAD and STT operations.
const bundle = await build({
  stdin: {
    contents: `export { VadOperation } from './src/vad-next/session.ts';
      export { configuration } from './src/vad-next/segmenter.ts';
      export { LiveSession } from './src/stt-next/session.ts';
      export { createMicrophoneCaptureWithFactory } from './src/audio-next/microphone.ts';`,
    resolveDir: new URL('../../', import.meta.url).pathname,
  },
  bundle: true, write: false, format: 'esm', platform: 'node',
});
const { VadOperation, configuration, LiveSession, createMicrophoneCaptureWithFactory } =
  await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const turn = () => new Promise(resolve => setImmediate(resolve));
const pcm = (length = 30720, sampleRate = 48000) => ({
  samples: Float32Array.from({ length }, (_, i) => .25 + .05 * Math.sin(i / 30)), sampleRate,
});
const flatten = frames => frames.flatMap(frame => [...frame]);
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
function vad(options = {}, score = async () => 1) {
  const frames = [], errors = [], starts = [], ends = [], probabilities = [];
  let releases = 0;
  const operation = new VadOperation({
    sampleRate: 16000, frameSize: 512,
    async score(frame) { frames.push(frame.slice()); return score(frame, frames.length); },
  }, configuration({
    minSpeechDurationMs: 0, minSilenceDurationMs: 32, speechPaddingMs: 0, returnAudio: true,
    onError: error => errors.push(error), onSpeechStart: event => starts.push(event),
    onSpeechEnd: event => ends.push(event), onProbability: event => probabilities.push(event),
    ...options,
  }), false, () => { releases++; });
  operation.begin();
  return { operation, frames, errors, starts, ends, probabilities, get releases() { return releases; } };
}
function stt(recognize = async (_, finish) => ({ text: finish ? 'heard' : 'draft', isEndpoint: false })) {
  const frames = [], errors = [];
  let releases = 0;
  const operation = new LiveSession({
    kind: 'online',
    async pushStream(frame, finish) { frames.push(frame.slice()); return recognize(frame, finish); },
    async resetStream() {},
  }, { onError: error => errors.push(error) }, () => { releases++; });
  return { operation, frames, errors, get releases() { return releases; } };
}
async function pair(t, { score, recognize, factory } = {}) {
  // Expected operation failures are asserted via result/onError below.
  t.mock.method(console, 'error', () => {});
  const v = vad({}, score), s = stt(recognize);
  let deliver, fail, starts = 0, stops = 0;
  const mic = createMicrophoneCaptureWithFactory((audio, error, signal) => {
    deliver = audio; fail = error; starts++;
    return factory ? factory(audio, error, signal) : Promise.resolve({ async stop() { stops++; } });
  });
  t.after(async () => { v.operation.cancel(); s.operation.cancel(); await mic.stop(); });
  await v.operation.attachMicrophone(mic);
  await s.operation.attachMicrophone(mic);
  return { v, s, mic, send: audio => deliver(audio), fail: error => fail(error),
    get starts() { return starts; }, get stops() { return stops; } };
}

for (const threshold of [0, .001, .009, .01, .15, .5, 1]) {
  test(`omitted and explicitly undefined silence defaults accept speechThreshold=${threshold}`, () => {
    for (const options of [{ speechThreshold: threshold }, { speechThreshold: threshold, silenceThreshold: undefined }]) {
      const config = configuration(options);
      assert.ok(config.silenceThreshold >= 0);
      assert.ok(config.silenceThreshold <= threshold);
      assert.equal(config.speechThreshold, threshold);
    }
  });
}
test('explicit invalid threshold relationships still reject', () => {
  assert.throws(() => configuration({ speechThreshold: 0, silenceThreshold: .01 }), /must not exceed/);
});

for (const outcome of ['cancel', 'fail']) {
  test(`${outcome} from onProbability suppresses the already queued speech-start`, async t => {
    t.mock.method(console, 'error', () => {});
    const events = [], cause = Error('dependent failed');
    let v;
    v = vad({
      onProbability() {
        events.push('probability');
        if (outcome === 'cancel') v.operation.cancel(); else v.operation.fail(cause);
        events.push(outcome);
      },
      onSpeechStart: () => events.push('start'), onSpeechEnd: () => events.push('end'),
    });
    t.after(() => v.operation.cancel());
    await v.operation.push(pcm(1024, 16000));
    if (outcome === 'cancel') assert.deepEqual(await v.operation.result(), { segments: [], stopReason: 'cancelled' });
    else await assert.rejects(v.operation.result(), error => error.cause === cause && error.partialResult.segments.length === 0);
    await v.operation.released; await turn();
    assert.deepEqual(events, ['probability', outcome]);
    assert.equal(v.errors.length, outcome === 'fail' ? 1 : 0);
    assert.equal(v.releases, 1);
  });
}
test('successful finish still delivers the final end event before result continuation', async t => {
  const events = [];
  const v = vad({ onSpeechEnd: event => events.push(['end', event.endMs]) });
  t.after(() => v.operation.cancel());
  await v.operation.push(pcm(1024, 16000));
  const result = await v.operation.finish(); events.push(['result']);
  assert.deepEqual(events, [['end', 64], ['result']]);
  assert.deepEqual(result.segments, [{ id: '0', startMs: 0, endMs: 64 }]);
});

test('shared VAD and STT receive identical resampled audio and origin; stop permits explicit drain', async t => {
  const h = await pair(t);
  assert.equal(h.starts, 0);
  await h.mic.start(); assert.equal(h.starts, 1);
  const audio = pcm(); const original = audio.samples.slice();
  h.send(audio); await turn();
  assert.deepEqual(audio.samples, original);
  let settled = 0;
  void h.v.operation.result().then(() => settled++);
  void h.s.operation.result().then(() => settled++);
  await h.mic.stop(); await turn(); assert.equal(settled, 0);
  const [v, s] = await Promise.all([h.v.operation.finish(), h.s.operation.finish()]);
  assert.equal(v.stopReason, 'complete'); assert.equal(s.stopReason, 'complete');
  assert.deepEqual(flatten(h.v.frames), flatten(h.s.frames));
  assert.equal(flatten(h.v.frames).length, 10240);
  assert.equal(h.v.probabilities[0].startMs, 0);
  assert.equal(h.v.probabilities.at(-1).endMs, 640);
  assert.deepEqual(v.segments, [{ id: '0', startMs: 0, endMs: 640 }]);
  assert.equal(h.v.ends[0].audio.samples.length, 10240);
  assert.equal(h.stops, 1);
});

for (const first of ['v', 's']) {
  test(`${first === 'v' ? 'VAD' : 'STT'} finish detaches independently while its sibling keeps receiving`, async t => {
    const h = await pair(t), done = h[first], sibling = h[first === 'v' ? 's' : 'v'];
    await h.mic.start(); h.send(pcm()); await turn();
    assert.equal((await done.operation.finish()).stopReason, 'complete'); await done.operation.released;
    const calls = done.frames.length, siblingCalls = sibling.frames.length;
    const retainedClip = first === 'v' ? done.ends[0].audio.samples.slice() : undefined;
    assert.equal(h.stops, 0);
    h.send(pcm()); await turn();
    assert.equal(done.frames.length, calls); assert.ok(sibling.frames.length > siblingCalls);
    await h.mic.stop(); assert.equal((await sibling.operation.finish()).stopReason, 'complete');
    assert.equal(flatten(sibling.frames).length, 20480);
    if (retainedClip) assert.deepEqual(done.ends[0].audio.samples, retainedClip);
    assert.equal(done.releases, 1); assert.deepEqual(sibling.errors, []);
  });
  test(`${first === 'v' ? 'VAD' : 'STT'} cancellation discards pending audio without stopping sibling`, async t => {
    const gate = deferred(); t.after(() => gate.resolve());
    const h = await pair(t, first === 'v'
      ? { score: async () => { await gate.promise; return 1; } }
      : { recognize: async () => { await gate.promise; return { text: 'late', isEndpoint: false }; } });
    const cancelled = h[first], sibling = h[first === 'v' ? 's' : 'v'];
    await h.mic.start(); h.send(pcm()); await turn();
    assert.equal(cancelled.frames.length, 1);
    cancelled.operation.cancel();
    const result = await cancelled.operation.result(); assert.equal(result.stopReason, 'cancelled');
    assert.deepEqual(result.segments, []);
    assert.equal(h.stops, 0);
    h.send(pcm()); gate.resolve(); await cancelled.operation.released; await turn();
    assert.equal(cancelled.frames.length, 1);
    if (first === 'v') { assert.deepEqual(cancelled.starts, []); assert.deepEqual(cancelled.ends, []); }
    await h.mic.stop(); assert.equal((await sibling.operation.finish()).stopReason, 'complete');
    assert.equal(flatten(sibling.frames).length, 20480); assert.deepEqual(sibling.errors, []);
    assert.equal(cancelled.releases, 1);
  });
  test(`${first === 'v' ? 'VAD' : 'STT'} backend failure fails only that dependent`, async t => {
    const cause = Error('inference failed');
    const h = await pair(t, first === 'v'
      ? { score: async () => { throw cause; } }
      : { recognize: async () => { throw cause; } });
    const failed = h[first], sibling = h[first === 'v' ? 's' : 'v'];
    await h.mic.start(); h.send(pcm());
    let error;
    await assert.rejects(failed.operation.result(), value => { error = value; return value.cause === cause; });
    await failed.operation.released; await turn();
    assert.deepEqual(failed.errors, [error]); assert.equal(h.stops, 0);
    const calls = failed.frames.length;
    h.send(pcm()); await turn(); assert.equal(failed.frames.length, calls);
    await assert.rejects(failed.operation.finish(), value => value === error);
    await h.mic.stop(); assert.equal((await sibling.operation.finish()).stopReason, 'complete');
    assert.equal(flatten(sibling.frames).length, 20480); assert.deepEqual(sibling.errors, []);
  });
}

test('source failure fails both consumers once, preserving completed VAD timing and STT provisional text', async t => {
  const h = await pair(t, { score: async (_, index) => index === 3 ? 0 : 1 });
  await h.mic.start(); h.send(pcm()); await turn();
  assert.equal(h.v.ends.length, 1); assert.equal(h.v.starts.length, 2);
  const clip = h.v.ends[0].audio.samples, saved = clip.slice();
  const cause = Error('microphone disconnected'); h.fail(cause); h.fail(Error('duplicate'));
  for (const consumer of [h.v, h.s]) {
    let error;
    await assert.rejects(consumer.operation.result(), value => { error = value; return value.cause === cause; });
    await turn(); assert.deepEqual(consumer.errors, [error]);
    await assert.rejects(consumer.operation.finish(), value => value === error);
    if (consumer === h.v) assert.deepEqual(error.partialResult, { segments: [{ id: '0', startMs: 0, endMs: 64 }] });
    else assert.deepEqual(error.partialResult.provisional, { text: 'draft' });
    await consumer.operation.released; assert.equal(consumer.releases, 1);
  }
  const calls = [h.v.frames.length, h.s.frames.length];
  h.send(pcm()); await turn(); assert.deepEqual([h.v.frames.length, h.s.frames.length], calls);
  assert.equal(h.v.ends.length, 1); assert.deepEqual(clip, saved);
  assert.equal(h.stops, 1); await h.mic.stop(); assert.equal(h.stops, 1);
});

test('capture startup rejection fails attached VAD and STT without inference', async t => {
  const cause = Error('permission denied');
  const h = await pair(t, { factory: () => Promise.reject(cause) });
  await assert.rejects(h.mic.start(), error => error === cause);
  for (const consumer of [h.v, h.s]) {
    await assert.rejects(consumer.operation.result(), error => error.cause === cause);
    await consumer.operation.released; await turn();
    assert.equal(consumer.errors.length, 1); assert.equal(consumer.frames.length, 0);
  }
});

test('source failure during both native calls discards queued audio and ignores late results', async t => {
  const gate = deferred(); t.after(() => gate.resolve());
  const h = await pair(t, {
    score: async () => { await gate.promise; return 1; },
    recognize: async () => { await gate.promise; return { text: 'late', isEndpoint: false }; },
  });
  await h.mic.start(); h.send(pcm()); await turn();
  assert.deepEqual([h.v.frames.length, h.s.frames.length], [1, 1]);
  const cause = Error('source lost during inference'); h.fail(cause);
  for (const consumer of [h.v, h.s]) {
    await assert.rejects(consumer.operation.result(), error => error.cause === cause);
  }
  let released = 0;
  void h.v.operation.released.then(() => released++);
  void h.s.operation.released.then(() => released++);
  await turn(); assert.equal(released, 0);
  gate.resolve(); await Promise.all([h.v.operation.released, h.s.operation.released]); await turn();
  assert.deepEqual([h.v.frames.length, h.s.frames.length], [1, 1]);
  assert.deepEqual(h.v.starts, []); assert.deepEqual(h.v.ends, []);
  for (const consumer of [h.v, h.s]) {
    assert.equal(consumer.errors.length, 1);
    assert.deepEqual(consumer.errors[0].partialResult.segments, []);
    assert.equal(consumer.errors[0].partialResult.provisional, undefined);
  }
  assert.equal(h.stops, 1);
});
