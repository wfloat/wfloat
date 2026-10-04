export type ModelProgressEvent =
  | { phase: 'checking' }
  | { phase: 'downloading'; downloadedBytes: number; totalBytes?: number; progress?: number; bytesPerSecond?: number; estimatedTimeRemainingMs?: number }
  | { phase: 'loading'; progress?: number }
  | { phase: 'ready' };
export interface DownloadModelOptions { signal?: AbortSignal; onProgress?: (event: ModelProgressEvent) => void }
export class ModelAssetsDeletedError extends Error {
  readonly name = 'ModelAssetsDeletedError';
  constructor() { super('Model assets were deleted during this operation'); }
}
export class AssetStorageError extends Error { readonly name = 'AssetStorageError'; }
export class AssetIntegrityError extends Error { readonly name = 'AssetIntegrityError'; }
export { checkAbort, abortError, notify } from '../platform/bridge';
