import { OperationController, signalReason } from '../platform/cancellation';
import { Platform } from 'react-native';
import { MODEL_ASSETS, REGISTRY_ORIGIN, SHARED_ASSETS } from '../../generatedModelUrls';
import { request } from '../platform/bridge';
import { Sha256 } from './sha256';
import { checkAbort, notify, ModelAssetsDeletedError, type DownloadModelOptions } from './types';
export * from './types';

type File = { path: string; sha256: string; sizeBytes: number };
type Composite = { parts: File[]; sha256: string; sizeBytes: number; filename: string };
type Asset = { name: string; sha256: string; sizeBytes: number; key: string; shared: boolean; url?: string; parts?: Asset[] };
export type Task = 'tts' | 'stt' | 'vad' | 'llm';
function keyFor(url: string): string {
  // Registry URLs are ASCII; escape non-ASCII rather than depending on TextEncoder in Hermes.
  const ascii = encodeURI(decodeURI(url));
  const hash = new Sha256();
  hash.update(Uint8Array.from(ascii, c => c.charCodeAt(0)));
  return hash.digest();
}
export function modelManifest(id: string): { family: string; task: Task; assets: Asset[] } {
  if (!Object.prototype.hasOwnProperty.call(MODEL_ASSETS, id)) throw new TypeError(`Unknown model: ${id}`);
  const record = MODEL_ASSETS[id as keyof typeof MODEL_ASSETS];
  const family = 'family' in record ? record.family : 'wfloat';
  const task: Task = ['wfloat', 'pocket', 'piper', 'kokoro', 'kitten'].includes(family) ? 'tts' : family === 'silero-vad' ? 'vad' : ['smollm', 'gemma3', 'qwen3'].includes(family) ? 'llm' : 'stt';
  const assets: Asset[] = [];
  const append = (name: string, file: File, shared: boolean) => {
    const url = REGISTRY_ORIGIN + file.path;
    assets.push({ ...file, name, url, key: keyFor(url), shared });
  };
  for (const [name, file] of Object.entries(record)) {
    if (typeof file !== 'object' || !file) continue;
    if ('parts' in file) {
      const composite = file as unknown as Composite;
      if (!Array.isArray(composite.parts) || !composite.parts.length ||
          !/^[0-9a-f]{64}$/i.test(composite.sha256) || !Number.isSafeInteger(composite.sizeBytes) || composite.sizeBytes < 0 ||
          (typeof composite.filename !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(composite.filename)) || composite.parts.some(part =>
            !part || typeof part.path !== 'string' || !part.path.startsWith('/') || !/^[0-9a-f]{64}$/i.test(part.sha256) || !Number.isSafeInteger(part.sizeBytes) || part.sizeBytes < 0) ||
          new Set(composite.parts.map(part => part.path)).size !== composite.parts.length ||
          composite.parts.reduce((sum, part) => sum + part.sizeBytes, 0) !== composite.sizeBytes)
        throw new TypeError(`Invalid composite asset: ${id}/${name}`);
      const parts = composite.parts.map((part, i) => {
        const url = REGISTRY_ORIGIN + part.path;
        return { ...part, name: `${name}.part${i}`, url, key: keyFor(url), shared: false };
      });
      assets.push({ name, parts, sha256: composite.sha256, sizeBytes: composite.sizeBytes,
        key: keyFor(`assembled:${id}/${name}/${composite.sha256}`), shared: false });
    } else if ('path' in file) append(name, file as File, false);
  }
  if (['wfloat', 'piper', 'kokoro', 'kitten'].includes(family)) append('espeak_data', Platform.OS === 'ios' ? SHARED_ASSETS.espeak_ng_data_aar : SHARED_ASSETS.espeak_ng_data_zip, true);
  return { family: 'family' in record ? record.family : 'wfloat', task, assets };
}

type Transfer = { controller: OperationController; listeners: Set<(bytes: number) => void>; bytes: number; promise: Promise<{path: string}> };
const transfers = new Map<string, Transfer>();
const callers = new Map<string, Set<OperationController>>();
const deletions = new Map<string, Promise<void>>();
function lease(id: string, signal?: AbortSignal) {
  checkAbort(signal);
  const controller = new OperationController();
  const abort = () => controller.abort(signal ? signalReason(signal) : undefined);
  signal?.addEventListener('abort', abort, { once: true });
  const set = callers.get(id) ?? new Set<OperationController>();
  callers.set(id, set); set.add(controller);
  let released = false;
  return { signal: controller.signal, release() {
    if (released) return; released = true;
    signal?.removeEventListener('abort', abort); set.delete(controller);
    if (!set.size) callers.delete(id);
  } };
}
function wait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); try { checkAbort(signal); } catch (error) { reject(error); } };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort();
  });
}
type Cached = {path: string; sizeBytes: number} | null;
async function acquire(asset: Asset, signal: AbortSignal, progress: (bytes: number) => void, cachedParts?: Cached[]): Promise<{path: string}> {
  checkAbort(signal);
  let transfer = transfers.get(asset.key);
  if (transfer?.controller.signal.aborted) {
    await wait(transfer.promise.catch(() => undefined), signal);
    transfer = undefined;
  }
  if (!transfer) {
    const controller = new OperationController();
    const created: Transfer = { controller, listeners: new Set(), bytes: 0, promise: Promise.resolve({path: ''}) };
    created.promise = (asset.parts ? (async () => {
      const bytes = asset.parts!.map((part, i) => cachedParts?.[i]?.sizeBytes === part.sizeBytes ? part.sizeBytes : 0);
      created.bytes = bytes.reduce((a, b) => a + b, 0);
      for (let i = 0; i < asset.parts!.length; i++) {
        if (cachedParts?.[i]?.sizeBytes === asset.parts![i]!.sizeBytes) continue;
        await acquire(asset.parts![i]!, controller.signal, value => {
          bytes[i] = value;
          created.bytes = bytes.reduce((a, b) => a + b, 0);
          for (const listener of created.listeners) listener(created.bytes);
        });
      }
      checkAbort(controller.signal);
      return request<{path: string}>({ op: 'assetAssemble', key: asset.key, sha256: asset.sha256,
        sizeBytes: asset.sizeBytes, parts: asset.parts!.map(({key, sha256, sizeBytes}) => ({key, sha256, sizeBytes})) }, {signal: controller.signal});
    })() : request<{path: string}>({ op: 'assetDownload', ...asset }, {
      signal: controller.signal,
      onEvent: event => {
        if (event.type !== 'download') return;
        created.bytes = event.downloadedBytes;
        for (const listener of created.listeners) listener(created.bytes);
      },
    })).finally(() => { if (transfers.get(asset.key) === created) transfers.delete(asset.key); });
    transfers.set(asset.key, created); transfer = created;
  }
  transfer.listeners.add(progress);
  if (transfer.bytes) progress(transfer.bytes);
  try { return await wait(transfer.promise, signal); }
  finally {
    transfer.listeners.delete(progress);
    if (!transfer.listeners.size) transfer.controller.abort();
  }
}
async function obtain(id: string, options: DownloadModelOptions, signal: AbortSignal): Promise<Record<string, string>> {
  const { assets } = modelManifest(id);
  const deleting = deletions.get(id);
  if (deleting) await wait(deleting, signal);
  checkAbort(signal);
  notify(options.onProgress, { phase: 'checking' });
  const states = await Promise.all(assets.map(asset => request<{path: string;sizeBytes: number}|null>({ op: 'assetStat', key: asset.key, sha256: asset.sha256, sizeBytes: asset.sizeBytes }, {signal})));
  const partStates = await Promise.all(assets.map(async (asset, i) =>
    asset.parts && states[i]?.sizeBytes !== asset.sizeBytes ? Promise.all(asset.parts.map(part =>
      request<Cached>({op:'assetStat', key:part.key, sha256:part.sha256, sizeBytes:part.sizeBytes}, {signal}))) : undefined));
  const bytes = states.map((state, i) => state?.sizeBytes === assets[i]!.sizeBytes ? state.sizeBytes :
    (partStates[i]?.reduce((sum, part, j) => sum + (part?.sizeBytes === assets[i]!.parts![j]!.sizeBytes ? part.sizeBytes : 0), 0) ?? 0));
  const paths: Record<string, string> = {};
  const totalBytes = assets.reduce((sum, asset) => sum + asset.sizeBytes, 0);
  let speedTime = Date.now(), speedBytes = bytes.reduce((a,b) => a+b,0);
  const progress = () => {
    const downloadedBytes = bytes.reduce((a,b) => a+b,0);
    const elapsed = Date.now() - speedTime;
    const bytesPerSecond = elapsed > 250 ? Math.max(0, (downloadedBytes - speedBytes) * 1000 / elapsed) : undefined;
    notify(options.onProgress, {phase:'downloading', downloadedBytes, totalBytes,
      progress: totalBytes ? Math.min(1, downloadedBytes / totalBytes) : 1,
      ...(bytesPerSecond !== undefined ? { bytesPerSecond, ...(bytesPerSecond > 0 ? { estimatedTimeRemainingMs: Math.max(0,totalBytes-downloadedBytes) / bytesPerSecond * 1000 } : {}) } : {}),
    });
  };
  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i]!;
    checkAbort(signal);
    const state = states[i];
    if (state && state.sizeBytes === asset.sizeBytes) { paths[asset.name] = state.path; continue; }
    const needsNetwork = bytes[i] !== asset.sizeBytes;
    if (needsNetwork) progress();
    let sampled = false;
    const path = await acquire(asset, signal, value => {
      bytes[i] = value;
      // Initial progress may describe resumed bytes already on disk, not throughput.
      if (!sampled) { sampled = true; speedTime = Date.now(); speedBytes = bytes.reduce((a,b) => a+b,0); }
      if (needsNetwork) progress();
    }, partStates[i]);
    bytes[i] = asset.sizeBytes; paths[asset.name] = path.path;
    if (needsNetwork) progress();
    // Restart speed sample to avoid including long integrity checks in next asset's rate.
    speedTime = Date.now(); speedBytes = bytes.reduce((a,b) => a+b,0);
  }
  checkAbort(signal);
  return paths;
}
export async function downloadModel(id: string, options: DownloadModelOptions = {}): Promise<void> {
  modelManifest(id);
  const owned = lease(id, options.signal);
  try { await obtain(id, options, owned.signal); checkAbort(owned.signal); owned.release(); notify(options.onProgress, {phase:'ready'}); }
  finally { owned.release(); }
}
export async function loadAssets(id: string, task: Task, options: DownloadModelOptions = {}) {
  const manifest = modelManifest(id);
  if (manifest.task !== task) throw new TypeError(`${id} is not a ${task} model.`);
  const owned = lease(id, options.signal);
  try {
    const paths = await obtain(id, options, owned.signal);
    // Pass the extracted data directory to every eSpeak-backed family, never the archive.
    const espeak = manifest.assets.find(value => value.name === 'espeak_data' && value.shared);
    if (espeak) {
      const asset = espeak;
      paths.espeak_data = (await request<{path:string}>({op:'prepareEspeak', path:paths.espeak_data, key:asset.key, format:Platform.OS === 'ios' ? 'aar' : 'zip'}, {signal:owned.signal})).path;
    }
    checkAbort(owned.signal);
    return { paths, family: manifest.family, signal: owned.signal, assertCurrent: () => checkAbort(owned.signal), release: owned.release };
  } catch (error) { owned.release(); throw error; }
}
export function deleteModelAssets(id: string): Promise<void> {
  const manifest = modelManifest(id);
  const existing = deletions.get(id);
  if (existing) return existing;
  for (const controller of callers.get(id) ?? []) controller.abort(new ModelAssetsDeletedError());
  const deleting = (async () => {
    // Wait for cancelled writers to settle before physical removal.
    for (const asset of manifest.assets.flatMap(value => [value, ...(value.parts ?? [])]).filter(value => !value.shared)) {
      const transfer = transfers.get(asset.key);
      transfer?.controller.abort(new ModelAssetsDeletedError());
      await transfer?.promise.catch(() => {});
      await request({op:'assetDelete',key:asset.key});
    }
  })().finally(() => { if (deletions.get(id) === deleting) deletions.delete(id); });
  deletions.set(id, deleting);
  return deleting;
}
