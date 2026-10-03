import { createOfflineTts, prepareWfloatText, type SherpaModule, type OfflineTts } from '../wasm/sherpa-onnx-tts.js';
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

export function initializeSherpa(module: SherpaModule, assets: WorkerAssets): OfflineTts {
  ensureHeapViews(module);
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
export function prepareSherpa(module: SherpaModule, tts: OfflineTts, segment: SpeechSegment): PreparedUnit[] {
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
export function synthesizeSherpa(tts: OfflineTts, unit: PreparedUnit, segment: SpeechSegment) {
  validateWfloatSegment(segment);
  // The wrapper copies WASM memory into JS-owned samples before freeing native audio.
  return tts.generate({ text: unit.text, sid: voiceNumber(segment.voiceId), speed: segment.speed ?? 1 });
}
