import { prepareStandard, standardVoice, validateStandardSegment, type StandardConfig } from './families.js';
import { KokoroSession, type SherpaTts } from './kokoro.js';
import { preparePocket, validatePocketSegment } from './pocket.js';
import type { SpeechAudio } from './types.js';
const pocketReferences = new WeakMap<SherpaTts, SpeechAudio>();
import { createOfflineTts, prepareWfloatText, type SherpaModule } from '../wasm/sherpa-onnx-tts.js';
import { voiceNumber, validateWfloatSegment, type WorkerAssets } from './backend.js';
import type { PreparedUnit } from './backend-types.js';
import type { SpeechSegment } from './types.js';

/** Extracted from the legacy worker's stored ZIP staging, with strict bounds checks. */
export function installEspeak(module: SherpaModule, bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 0;
  const mkdir = (path: string) => {
    let prefix = '';
    for (const part of path.split('/').filter(Boolean)) {
      prefix += '/' + part;
      if (!module.FS.analyzePath(prefix).exists) module.FS.mkdir(prefix);
    }
  };
  while (offset + 4 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    if (offset + 30 > bytes.length) throw new Error('Truncated eSpeak ZIP header.');
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const compressed = view.getUint32(offset + 18, true);
    const size = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if (flags & 9 || method !== 0 || compressed !== size) throw new Error('eSpeak requires an unencrypted stored ZIP without data descriptors.');
    const dataOffset = offset + 30 + nameLength + extraLength;
    const end = dataOffset + size;
    if (end > bytes.length) throw new Error('Truncated eSpeak ZIP entry.');
    const rawName = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const parts = rawName.replace(/\\/g, '/').split('/').filter(part => part && part !== '.');
    if (parts.includes('..') || rawName.includes('\0')) throw new Error('Invalid eSpeak ZIP path.');
    // The published archive permits a single enclosing directory.
    const root = parts.indexOf('espeak-ng-data');
    if (root >= 0) {
      const path = '/' + parts.slice(root).join('/');
      if (rawName.endsWith('/')) mkdir(path);
      else { mkdir(path.slice(0, path.lastIndexOf('/'))); module.FS.writeFile(path, bytes.subarray(dataOffset, end)); }
    }
    offset = end;
  }
  if (!module.FS.analyzePath('/espeak-ng-data').exists) throw new Error('eSpeak archive has no data directory.');
}

/** Some shipped factories export memory but omit HEAP views. Getters remain valid
 * after WASM memory growth; a once-created typed array would become detached. */
export function ensureHeapViews(module: SherpaModule) {
  const memory = (module as unknown as { wasmMemory?: WebAssembly.Memory }).wasmMemory;
  for (const [name, View] of [['HEAP8', Int8Array], ['HEAP32', Int32Array], ['HEAPF32', Float32Array]] as const) {
    if (module[name]) continue;
    if (!memory) throw new Error('Sherpa runtime does not expose its WASM memory.');
    let view: Int8Array | Int32Array | Float32Array;
    Object.defineProperty(module, name, { get() {
      if (!view || view.buffer !== memory.buffer) view = new View(memory.buffer);
      return view;
    } });
  }
}

export type SherpaMode = boolean | StandardConfig;
export function initializeSherpa(module: SherpaModule, assets: WorkerAssets): SherpaTts {
  ensureHeapViews(module);
  if ('family' in assets && assets.family === 'pocket') {
    for (const [name, bytes] of Object.entries(assets.files)) module.FS.writeFile('/' + name, bytes);
    const tts = createOfflineTts(module, {
      offlineTtsModelConfig: { offlineTtsPocketModelConfig: {
        lmMain: '/lm_main', lmFlow: '/lm_flow', encoder: '/encoder', decoder: '/decoder',
        textConditioner: '/text_conditioner', vocabJson: '/vocab_json', tokenScoresJson: '/token_scores_json',
        voiceEmbeddingCacheCapacity: 8,
      }, numThreads: 1, debug: 0, provider: 'cpu' }, maxNumSentences: 1,
    });
    try {
      // Registry preset is canonical mono 24-kHz PCM16 WAV produced during staging.
      const bytes = assets.files.reference_audio;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (bytes.length < 44 || view.getUint32(0, false) !== 0x52494646 || view.getUint32(8, false) !== 0x57415645 || view.getUint32(12, false) !== 0x666d7420 || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== 24000 || view.getUint16(34, true) !== 16 || view.getUint32(36, false) !== 0x64617461 || view.getUint32(40, true) !== bytes.length - 44 || (bytes.length - 44) % 2) throw new Error('Invalid Pocket preset WAV.');
      const samples = new Float32Array((bytes.length - 44) / 2);
      if (!samples.length || samples.length > 240000) throw new Error('Invalid Pocket preset duration.');
      for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(44 + i * 2, true) / 32768;
      pocketReferences.set(tts, { samples, sampleRate: 24000 });
      return tts;
    } catch (error) { tts.free(); throw error; }
  }
  if ('config' in assets) {
    const required = assets.family === 'piper' ? ['model_onnx', 'model_tokens'] :
      assets.family === 'kitten' ? ['model_onnx', 'model_tokens', 'model_voices'] :
      ['model_onnx', 'model_tokens', 'model_voices', 'lexicon_zh', 'rule_date_zh', 'rule_number_zh', 'rule_phone_zh'];
    for (const name of required) {
      const bytes = assets.files[name];
      if (!bytes?.length) throw new Error(`Missing TTS worker asset: ${name}`);
      module.FS.writeFile('/' + name, bytes);
    }
    installEspeak(module, assets.espeak);
    if (assets.family === 'kokoro') return new KokoroSession(module);
    const c = assets.config;
    if (assets.family === 'kitten') {
      const tts = createOfflineTts(module, {
        offlineTtsModelConfig: { offlineTtsKittenModelConfig: {
          model: '/model_onnx', tokens: '/model_tokens', voices: '/model_voices',
          dataDir: '/espeak-ng-data', lengthScale: 1,
        }, numThreads: 1, debug: 0, provider: 'cpu' },
        maxNumSentences: 1, ruleFsts: '', ruleFars: '', silenceScale: 1,
      });
      if (tts.sampleRate !== c.sampleRate || tts.numSpeakers !== c.numSpeakers) {
        tts.free(); throw new Error('Kitten runtime metadata does not match its configuration.');
      }
      return tts;
    }
    const tts = createOfflineTts(module, {
      offlineTtsModelConfig: { offlineTtsVitsModelConfig: {
        model: '/model_onnx', tokens: '/model_tokens', dataDir: '/espeak-ng-data',
        noiseScale: c.noiseScale, noiseScaleW: c.noiseScaleW, lengthScale: c.lengthScale,
      }, numThreads: 1, debug: 0, provider: 'cpu' }, maxNumSentences: 1, ruleFsts: '', ruleFars: '',
    });
    if (tts.sampleRate !== c.sampleRate || tts.numSpeakers !== c.numSpeakers) {
      tts.free(); throw new Error('Piper runtime metadata does not match its configuration.');
    }
    return tts;
  }
  module.FS.writeFile('/model.onnx', assets.model);
  module.FS.writeFile('/tokens.txt', assets.tokens);
  installEspeak(module, assets.espeak);
  return createOfflineTts(module, {
    offlineTtsModelConfig: {
      offlineTtsWfloatModelConfig: { model: '/model.onnx', tokens: '/tokens.txt', dataDir: '/espeak-ng-data', noiseScale: 0.667, noiseScaleW: 0.8, lengthScale: 1 },
      numThreads: 1, debug: 0, provider: 'cpu',
    },
    ruleFsts: '', ruleFars: '', maxNumSentences: 1,
  });
}
export function prepareSherpa(module: SherpaModule, tts: SherpaTts, segment: SpeechSegment, pocket: SherpaMode = false): PreparedUnit[] {
  if (typeof pocket === 'object') return prepareStandard(pocket, segment);
  if (pocket) return preparePocket(segment);
  validateWfloatSegment(segment);
  const prepared = prepareWfloatText(module, { text: segment.text, emotion: segment.emotion ?? 'neutral', intensity: segment.intensity ?? 0.5 }, tts.handle);
  if (prepared.text.length !== prepared.textClean.length || prepared.text.join('') !== segment.text) throw new Error('Sherpa original-text alignment does not match input.');
  let cursor = 0;
  return prepared.text.map((text, index) => {
    const textStart = cursor;
    cursor += text.length; // UTF-16 original text, never normalized-text or UTF-8 offsets.
    return { text: prepared.textClean[index], textStart, textEnd: cursor };
  });
}
export function synthesizeSherpa(tts: SherpaTts, unit: PreparedUnit, segment: SpeechSegment, pocket: SherpaMode = false) {
  if (typeof pocket === 'object') {
    validateStandardSegment(pocket, segment);
    const audio = tts.generate({ text: unit.text, sid: standardVoice(pocket, segment.voiceId), speed: segment.speed ?? 1,
      ...(pocket.family === 'kitten' ? { silenceScale: 1 } : {}) });
    if (pocket.family === 'kitten' && (!audio.samples.length || audio.sampleRate !== 24000)) {
      throw new Error('Kitten text preparation or synthesis failed: no valid audio was produced.');
    }
    return audio;
  }
  if (pocket) {
    validatePocketSegment(segment);
    const audio = segment.referenceAudio as SpeechAudio | undefined ?? pocketReferences.get(tts);
    if (!audio || !(audio.samples instanceof Float32Array) || !audio.samples.length || audio.sampleRate !== 24000 || audio.samples.length > 240000) throw new Error('Invalid normalized Pocket reference audio.');
    return tts.generate({ text: unit.text, sid: 0, speed: 1, referenceAudio: audio,
      inferenceSteps: segment.inferenceSteps ?? 5, extra: { temperature: segment.temperature ?? .7, seed: segment.seed ?? -1 } });
  }
  validateWfloatSegment(segment);
  // The wrapper copies WASM memory into JS-owned samples before freeing native audio.
  return tts.generate({ text: unit.text, sid: voiceNumber(segment.voiceId), speed: segment.speed ?? 1 });
}
