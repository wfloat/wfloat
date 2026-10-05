import { AssetManager } from "./manager.js";
import { getModelAssetManifest, getModelDownloadManifest } from "./manifest.js";
import { requestPersistence } from "./persistence.js";
import { assetStore } from "./store.js";
import type { DownloadModelOptions, ModelAssetLease } from "./types.js";

const manager = new AssetManager({
  store: assetStore,
  manifest: getModelDownloadManifest,
  privateManifest: getModelAssetManifest,
  fetch: (...args) => fetch(...args),
  persistence: requestPersistence,
  lock: async (url, signal, run) => typeof navigator !== "undefined" && navigator.locks
    ? navigator.locks.request(`wfloat-asset:${url}`, { signal }, run) : run(),
});
export function downloadModel(id: string, options: DownloadModelOptions = {}): Promise<void> {
  return manager.downloadModel(id, options);
}
/** Internal loader integration; not a new public loading handle. */
export function acquireModelAssetLease(id: string, options: { signal?: AbortSignal } = {}): Promise<ModelAssetLease> {
  return manager.acquireModelAssetLease(id, options);
}
export function deleteModelAssets(id: string): Promise<void> { return manager.deleteModelAssets(id); }
export { configureRuntimeAssets, getModelAssetManifest, getModelDownloadManifest, getModelRuntimeFamily } from "./manifest.js";
export type { AssetModelId, RuntimeFamily } from "./manifest.js";
export { AssetStorageError, AssetIntegrityError, ModelAssetsDeletedError, AssetConflictError } from "./types.js";
export type { DownloadModelOptions, ModelProgressEvent, AssetManifestEntry, ModelAssetLease } from "./types.js";
