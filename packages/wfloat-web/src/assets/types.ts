export type ModelProgressEvent =
  | { phase: "checking" }
  | { phase: "downloading"; downloadedBytes: number; totalBytes?: number; progress?: number;
      bytesPerSecond?: number; estimatedTimeRemainingMs?: number }
  | { phase: "loading"; progress?: number }
  | { phase: "ready" };

export interface DownloadModelOptions {
  signal?: AbortSignal;
  onProgress?: (event: ModelProgressEvent) => void;
  persistence?: "auto" | "request" | "off";
}
export interface AssetManifestEntry {
  url: string;
  sizeBytes?: number;
  sha256?: string;
  shared: boolean;
}
export class AssetStorageError extends Error {
  readonly name = "AssetStorageError";
  constructor(message: string, readonly cause?: unknown) { super(message); }
}
export class AssetIntegrityError extends Error { readonly name = "AssetIntegrityError"; }
export class ModelAssetsDeletedError extends Error {
  readonly name = "ModelAssetsDeletedError";
  constructor() { super("Model assets were deleted during this operation"); }
}
/** Safe competing-writer failure on platforms without Web Locks. */
export class AssetConflictError extends Error { readonly name = "AssetConflictError"; }
export function abortError(): DOMException { return new DOMException("Asset operation aborted", "AbortError"); }
export function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) {
  if (signal.reason instanceof ModelAssetsDeletedError || signal.reason instanceof AssetStorageError || signal.reason instanceof AssetIntegrityError) throw signal.reason;
  throw abortError();
} }
export function notify(callback: DownloadModelOptions["onProgress"], event: ModelProgressEvent): void {
  try {
    // Notifications cannot change the lifecycle, including accidental async callbacks.
    const result: unknown = callback?.(event);
    if (result && typeof (result as PromiseLike<unknown>).then === "function")
      Promise.resolve(result).catch(error => console.error("Wfloat progress callback failed", error));
  } catch (error) { console.error("Wfloat progress callback failed", error); }
}

/** Internal loader fence, held from before download through runtime readiness. */
export interface ModelAssetLease {
  readonly signal: AbortSignal;
  /** Check immediately before committing readiness; reject if assets were deleted. */
  assertCurrent(): Promise<void>;
  /** Stop monitoring once ready or failed. Does not abort a successfully loaded model. */
  release(): void;
}
