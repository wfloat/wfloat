import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from '../../node_modules/esbuild/lib/main.js';
const built = await build({ entryPoints: [new URL('../../src/stt-next/audio.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
const { snapshotAudio, snapshotPcm, normalizeAudio, StreamingResampler } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));

test('PCM ownership, validation, AudioBuffer downmix and immutable Blob', () => {
  const samples = new Float32Array([1, 2]);
  const owned = snapshotPcm({ samples, sampleRate: 44100 });
  samples.fill(0); assert.deepEqual([...owned.samples], [1, 2]);
  for (const sampleRate of [0, -1, NaN, Infinity]) assert.throws(() => snapshotPcm({ samples, sampleRate }));
  for (const samples of [[], new Float32Array(), new Float32Array([NaN]), new Float32Array([Infinity])]) assert.throws(() => snapshotPcm({ samples, sampleRate: 16000 }));
  const channels = [new Float32Array([1, -1]), new Float32Array([0, 1])];
  const mixed = snapshotAudio({ length: 2, numberOfChannels: 2, sampleRate: 48000, getChannelData: i => channels[i] });
  channels[0].fill(0); assert.deepEqual([...mixed.samples], [0.5, 0]);
  assert.throws(() => snapshotAudio({ length: 3, numberOfChannels: 2, sampleRate: 48000, getChannelData: i => channels[i] }));
  const blob = new Blob(['abc']); assert.equal(snapshotAudio(blob), blob);
});

test('streaming output matches whole timeline across tiny and irregular chunks and fractional rates', async () => {
  for (const rate of [8000, 11025, 16000, 22050, 44100, 48000, 96000, 44100.5]) {
    const input = Float32Array.from({ length: 997 }, (_, i) => Math.sin(i / 17));
    const whole = await normalizeAudio({ samples: input, sampleRate: rate });
    assert.equal(whole.samples.length, Math.ceil(input.length * 16000 / rate));
    for (const sizes of [[1], [1, 7, 2, 31, 3]]) {
      const r = new StreamingResampler(); const output = []; let n = 0;
      for (let i = 0; i < input.length;) {
        const end = Math.min(input.length, i + sizes[n++ % sizes.length]);
        output.push(...r.push({ samples: input.subarray(i, end), sampleRate: rate })); i = end;
        assert.throws(() => r.push({ samples: new Float32Array(), sampleRate: rate }));
      }
      output.push(...r.finish()); assert.deepEqual(output, [...whole.samples]);
      assert.equal(r.finish().length, 0); assert.throws(() => r.push({ samples: input, sampleRate: rate }));
    }
    // Independent interpolation oracle, including final sample extension.
    for (let k = 0; rate <= 16000 && k < whole.samples.length; k++) {
      const pos = k * rate / 16000; const left = Math.floor(pos); const a = input[Math.min(left, input.length - 1)];
      const b = input[Math.min(left + 1, input.length - 1)];
      assert.ok(Math.abs(whole.samples[k] - (a + (b - a) * (pos - left))) < 1e-6);
    }
  }
});

test('Blob decode closes context on success and failure', async () => {
  let closed = 0; let fail = false;
  globalThis.AudioContext = class {
    async decodeAudioData() { if (fail) throw new Error('decode failed'); return { sampleRate: 8000, length: 1, numberOfChannels: 1, getChannelData: () => new Float32Array([0.5]) }; }
    async close() { closed++; }
  };
  try {
    const pcm = await normalizeAudio(new Blob(['data'])); assert.deepEqual([...pcm.samples], [0.5, 0.5]);
    fail = true; await assert.rejects(normalizeAudio(new Blob(['data'])), /decode failed/); assert.equal(closed, 2);
    await assert.rejects(normalizeAudio(new Blob()), /empty/);
  } finally { delete globalThis.AudioContext; }
});

test('rate changes flush old tails in order; invalid pushes preserve state', async () => {
  const r = new StreamingResampler();
  const runs = [
    { samples: new Float32Array([1]), sampleRate: 8000 },
    { samples: new Float32Array([2, 3, 4]), sampleRate: 44100 },
    { samples: new Float32Array([5]), sampleRate: 11025 },
  ];
  const actual = []; const expected = [];
  for (const audio of runs) {
    actual.push(...r.push(audio));
    assert.throws(() => r.push({ samples: new Float32Array([NaN]), sampleRate: 12345 }));
    assert.throws(() => r.push({ samples: new Float32Array([1]), sampleRate: 0 }));
    expected.push(...(await normalizeAudio(audio)).samples);
  }
  actual.push(...r.finish()); assert.deepEqual(actual, expected);
  assert.equal(r.finish().length, 0);
  assert.equal(new StreamingResampler().finish().length, 0);
  const custom = new StreamingResampler(8000);
  assert.deepEqual([...custom.push({ samples: new Float32Array([1, 1, 1, 1]), sampleRate: 16000 }), ...custom.finish()], [1, 1]);
});

test('normalization reuses owned 16k PCM without copying or modifying it', async () => {
  const original = new Float32Array([0.25, -0.5]);
  const snapshot = snapshotPcm({ samples: original, sampleRate: 16000 });
  const normalized = await normalizeAudio(snapshot);
  assert.equal(normalized, snapshot); assert.equal(normalized.samples, snapshot.samples);
  assert.notEqual(normalized.samples, original);
});

test('anti-alias filter preserves speech-band tones and rejects frequencies above target Nyquist', async () => {
  for (const sampleRate of [22050, 44100, 48000, 96000]) {
    const rms = async frequency => {
      const samples = Float32Array.from({ length: sampleRate }, (_, i) => Math.sin(2 * Math.PI * frequency * i / sampleRate));
      const output = (await normalizeAudio({ samples, sampleRate })).samples;
      let energy = 0;
      for (let i = 200; i < output.length - 200; i++) energy += output[i] ** 2;
      return Math.sqrt(energy / (output.length - 400));
    };
    const pass = await rms(1000);
    assert.ok(pass > 0.69 && pass < 0.72, `passband ${sampleRate}: ${pass}`);
    for (const frequency of [8500, 10000]) {
      const stop = await rms(frequency);
      assert.ok(stop < 0.0071, `alias rejection ${sampleRate}/${frequency}: ${stop}`);
    }
  }
});

test('filter tail preserves DC and length for tiny inputs and does not borrow pushed memory', async () => {
  for (const sampleRate of [16000, 44100, 48000, 96000]) {
    for (const length of [1, 2, 7, 101]) {
      const samples = new Float32Array(length).fill(0.375);
      const r = new StreamingResampler();
      const body = r.push({ samples, sampleRate }); samples.fill(99);
      const output = [...body, ...r.finish()];
      assert.equal(output.length, Math.ceil(length * 16000 / sampleRate));
      for (const value of output) assert.ok(Math.abs(value - 0.375) < 1e-6);
    }
  }
});

test('full-file normalization allocates only output plus bounded Float32 history', async () => {
  const bundle = await build({ entryPoints: [new URL('../../src/stt-next/audio.ts', import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'iife', globalName: 'audio' });
  let allocated = 0;
  const TrackedFloat32 = new Proxy(Float32Array, {
    construct(target, args) {
      const value = Reflect.construct(target, args);
      allocated += value.length;
      return value;
    },
  });
  const context = vm.createContext({ Float32Array: TrackedFloat32 });
  vm.runInContext(bundle.outputFiles[0].text, context);
  const samples = new Float32Array(480000).fill(0.25);
  const result = await context.audio.normalizeAudio({ samples, sampleRate: 48000 });
  assert.equal(result.samples.length, 160000);
  assert.ok(allocated <= result.samples.length + 4096, `Float32 allocation exceeded output plus bounded history: ${allocated}`);
  assert.equal(samples[0], 0.25);
});
