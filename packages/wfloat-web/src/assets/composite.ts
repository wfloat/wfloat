import { REGISTRY_ORIGIN } from '../worker/generatedModelUrls.js';
import { assetStore, type AssetStore } from './store.js';
import { AssetIntegrityError, AssetStorageError, checkAbort } from './types.js';
import { Sha256 } from './sha256.js';
export interface RegistryFile { path: string; sha256: string; sizeBytes?: number }
export interface CompositeAsset { filename: string; parts: readonly RegistryFile[]; sha256: string; sizeBytes: number }
export function isComposite(value: unknown): value is CompositeAsset {
  return !!value && typeof value === 'object' && 'parts' in value;
}
export function compositeParts(asset: CompositeAsset): readonly RegistryFile[] {
  if (!Array.isArray(asset.parts) || asset.parts.length < 2 || !Number.isSafeInteger(asset.sizeBytes) || asset.sizeBytes <= 0 || !/^[a-f0-9]{64}$/.test(asset.sha256) || !/^[a-zA-Z0-9_.-]+$/.test(asset.filename)) throw new AssetIntegrityError('Invalid composite asset manifest');
  let size = 0; const paths = new Set<string>();
  for (const part of asset.parts) {
    if (!part || typeof part.path !== 'string' || !part.path.startsWith('/') || paths.has(part.path) || !/^[a-f0-9]{64}$/.test(part.sha256) || !Number.isSafeInteger(part.sizeBytes) || part.sizeBytes! <= 0) throw new AssetIntegrityError('Invalid composite asset part');
    size += part.sizeBytes!; paths.add(part.path);
  }
  if (size !== asset.sizeBytes) throw new AssetIntegrityError('Composite asset sizes do not match');
  return asset.parts;
}
/** Reconstruct directly from persisted chunks into one final allocation. Parts
 * remain the cached/downloadable objects; no duplicate assembled cache is needed. */
export async function readComposite(asset: CompositeAsset, signal?: AbortSignal, store: AssetStore = assetStore): Promise<Uint8Array> {
  const parts = compositeParts(asset); checkAbort(signal);
  const bytes = new Uint8Array(asset.sizeBytes), whole = new Sha256(); let offset = 0;
  for (const part of parts) {
    checkAbort(signal);
    const record = await store.stat(REGISTRY_ORIGIN + part.path);
    if (!record.complete) throw new AssetStorageError(`Asset is not downloaded: ${part.path}`);
    if (record.bytes !== part.sizeBytes) throw new AssetIntegrityError('Composite part size mismatch');
    const hash = new Sha256(); let count = 0;
    for (let i = 0; i < record.chunks; i++) {
      checkAbort(signal); const chunk = await store.chunk(record, i);
      if (count + chunk.length > part.sizeBytes!) throw new AssetIntegrityError('Composite part overflow');
      bytes.set(chunk, offset); offset += chunk.length; count += chunk.length;
      hash.update(chunk); whole.update(chunk);
    }
    if (count !== part.sizeBytes || hash.digest() !== part.sha256) throw new AssetIntegrityError(`Composite part failed integrity verification: ${part.path}`);
  }
  checkAbort(signal);
  if (offset !== asset.sizeBytes || whole.digest() !== asset.sha256) throw new AssetIntegrityError('Reconstructed model failed integrity verification');
  return bytes;
}
