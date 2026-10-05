import { emptyRecord, type AssetRecord, type AssetStore } from "./store.js";
import { Sha256 } from "./sha256.js";
import { abortError, AssetIntegrityError, checkAbort, ModelAssetsDeletedError, notify,
  type AssetManifestEntry, type DownloadModelOptions, type ModelAssetLease } from "./types.js";

interface Transfer {
  readonly generation: number;
  controller: AbortController;
  listeners: Set<(bytes: number, size?: number) => void>;
  bytes: number;
  size?: number;
  promise: Promise<void>;
}
export interface AssetManagerDependencies {
  store: AssetStore;
  manifest: (id: string) => readonly AssetManifestEntry[];
  privateManifest: (id: string) => readonly AssetManifestEntry[];
  fetch: typeof fetch;
  persistence: (policy: DownloadModelOptions["persistence"]) => Promise<void>;
  lock?: <T>(url: string, signal: AbortSignal, run: () => Promise<T>) => Promise<T>;
  now?: () => number;
}
function compatible(record: AssetRecord, asset: AssetManifestEntry): boolean {
  return (asset.sha256 === undefined || record.sha256 === asset.sha256) &&
    (asset.sizeBytes === undefined || record.sizeBytes === asset.sizeBytes);
}
function lengthHeader(value: string | null): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new AssetIntegrityError("Invalid Content-Length");
  return Number(value);
}
function signalWait<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  // Notification callbacks can abort after work was created but before it is
  // awaited. Still observe that work's rejection on the synchronous abort path.
  if (signal.aborted) void promise.catch(() => undefined);
  checkAbort(signal);
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason ?? abortError()); };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

/** Internal injectable coordinator. Production uses the IndexedDB store; tests use
 * deterministic storage/transport, never a production memory-only fallback. */
export class AssetManager {
  private transfers = new Map<string, Transfer>();
  private callers = new Map<string, Set<AbortController>>();
  private deletions = new Map<string, Promise<void>>();
  constructor(private readonly deps: AssetManagerDependencies) {}

  /** A loader must acquire before download, pass lease.signal through initialization,
   * assertCurrent immediately before readiness, and release in its finally block. */
  async acquireModelAssetLease(id: string, options: { signal?: AbortSignal } = {}): Promise<ModelAssetLease> {
    checkAbort(options.signal);
    const controller = new AbortController();
    const cancel = () => { try { checkAbort(options.signal); } catch (error) { controller.abort(error); } };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const callers = this.callers.get(id) ?? new Set<AbortController>();
    callers.add(controller); this.callers.set(id, callers);
    let timer: ReturnType<typeof setInterval> | undefined;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (timer !== undefined) clearInterval(timer);
      options.signal?.removeEventListener("abort", cancel);
      callers.delete(controller);
      if (!callers.size) this.callers.delete(id);
    };
    try {
      const deleting = this.deletions.get(id);
      if (deleting) await signalWait(deleting, controller.signal);
      checkAbort(controller.signal);
      const assets = this.deps.privateManifest(id).filter(asset => !asset.shared);
      const records = await signalWait(Promise.all(assets.map(asset => this.deps.store.stat(asset.url))), controller.signal);
      let checking: Promise<void> | undefined;
      const assertCurrent = (): Promise<void> => {
        if (released) return Promise.reject(new Error("Model asset lease was released"));
        if (checking) return checking;
        checking = (async () => {
          checkAbort(controller.signal);
          for (let i = 0; i < assets.length; i++) {
            const current = await this.deps.store.stat(assets[i].url);
            if (current.generation !== records[i].generation) throw new ModelAssetsDeletedError();
          }
          checkAbort(controller.signal);
        })().catch(error => { if (!released) controller.abort(error); throw error; }).finally(() => { checking = undefined; });
        return checking;
      };
      timer = setInterval(() => { void assertCurrent().catch(() => undefined); }, 250);
      checkAbort(controller.signal);
      return { signal: controller.signal, assertCurrent, release };
    } catch (error) { release(); throw error; }
  }

  async downloadModel(id: string, options: DownloadModelOptions = {}): Promise<void> {
    checkAbort(options.signal);
    const controller = new AbortController();
    const cancel = () => { try { checkAbort(options.signal); } catch (error) { controller.abort(error); } };
    options.signal?.addEventListener("abort", cancel, { once: true });
    const callers = this.callers.get(id) ?? new Set<AbortController>();
    callers.add(controller); this.callers.set(id, callers);
    const detach: (() => void)[] = [];
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      const deleting = this.deletions.get(id);
      if (deleting) await signalWait(deleting, controller.signal);
      checkAbort(controller.signal);
      const assets = [...new Map(this.deps.manifest(id).map(asset => [asset.url, asset])).values()];
      notify(options.onProgress, { phase: "checking" });
      const records = await signalWait(Promise.all(assets.map(asset => this.deps.store.stat(asset.url))), controller.signal);
      const verifyGeneration = async () => {
        const latestRecords: AssetRecord[] = [];
        for (let i = 0; i < assets.length; i++) {
          const latest = await this.deps.store.stat(assets[i].url);
          latestRecords.push(latest);
          if (!assets[i].shared && latest.generation !== records[i].generation) throw new ModelAssetsDeletedError();
          // Report durable progress from an owner in another tab while this
          // context waits for its Web Lock. Shared dependencies count too.
          const transfer = this.transfers.get(assets[i].url);
          if (transfer && transfer.generation === latest.generation && compatible(latest, assets[i]) && latest.bytes > transfer.bytes) {
            transfer.bytes = latest.bytes; transfer.size = latest.sizeBytes;
            for (const listener of transfer.listeners) listener(latest.bytes, latest.sizeBytes);
          }
        }
        return latestRecords;
      };
      // A deleting tab need not rely on delivery of a BroadcastChannel message.
      // The transactional tombstone is authoritative, including after suspension.
      let polling = false;
      timer = setInterval(() => {
        if (polling) return;
        polling = true;
        void verifyGeneration().catch(error => controller.abort(error)).finally(() => { polling = false; });
      }, 250);
      // Capture and monitor the generation before permission work can suspend
      // this call. A deleting tab must fence callers already waiting here.
      await signalWait(this.deps.persistence(options.persistence), controller.signal);
      const currentRecords = await verifyGeneration();
      checkAbort(controller.signal);
      const missing = assets.map((asset, i) => ({ asset, record: currentRecords[i] }))
        .filter(({ asset, record }) => !record.complete || !compatible(record, asset));
      const counters = missing.map(({ asset, record }) => {
        const candidate = this.transfers.get(asset.url);
        const current = candidate?.generation === record.generation ? candidate : undefined;
        const base = compatible(record, asset) ? Math.max(record.bytes, current?.bytes ?? 0) : 0;
        return { base, bytes: base, size: asset.sizeBytes ?? (compatible(record, asset) ? record.sizeBytes : undefined) ?? current?.size };
      });
      const now = this.deps.now ?? (() => performance.now());
      let lastTime = now(), lastBytes = 0, speed: number | undefined;
      const progress = () => {
        if (controller.signal.aborted || !missing.length) return;
        const downloadedBytes = counters.reduce((n, c) => n + Math.max(0, c.bytes - c.base), 0);
        const known = counters.every(c => c.size !== undefined);
        const totalBytes = known ? counters.reduce((n, c) => n + Math.max(0, c.size! - c.base), 0) : undefined;
        const time = now(), elapsed = time - lastTime;
        if (elapsed >= 250 && downloadedBytes > lastBytes) {
          const measured = (downloadedBytes - lastBytes) * 1000 / elapsed;
          speed = speed === undefined ? measured : speed * 0.75 + measured * 0.25;
          lastTime = time; lastBytes = downloadedBytes;
        }
        notify(options.onProgress, { phase: "downloading", downloadedBytes,
          ...(totalBytes === undefined ? {} : { totalBytes, progress: totalBytes ? Math.min(1, downloadedBytes / totalBytes) : 1 }),
          ...(speed === undefined ? {} : { bytesPerSecond: speed,
            ...(totalBytes === undefined ? {} : { estimatedTimeRemainingMs: Math.max(0, totalBytes - downloadedBytes) / speed * 1000 }) }) });
      };
      progress();
      const waits = missing.map(({ asset, record }, i) => {
        const listener = (bytes: number, size?: number) => {
          // A server ignoring Range restarts the file; reused baseline bytes are
          // never counted as new caller progress or speed.
          counters[i].bytes = Math.max(counters[i].bytes, bytes);
          counters[i].size = size; progress();
        };
        return this.join(asset, record, listener, controller.signal, detach);
      });
      await signalWait(Promise.all(waits), controller.signal);
      await verifyGeneration();
      if (controller.signal.aborted) throw controller.signal.reason ?? abortError();
      notify(options.onProgress, { phase: "ready" });
    } catch (error) {
      // A join may still be awaiting an older aborted writer and not yet have a
      // release callback. Cancel the operation before cleanup so that deferred
      // work cannot create another transfer after this call has already failed.
      controller.abort(error);
      throw error;
    } finally {
      if (timer !== undefined) clearInterval(timer);
      for (const release of detach) release();
      options.signal?.removeEventListener("abort", cancel);
      callers.delete(controller);
      if (!callers.size) this.callers.delete(id);
    }
  }

  private async join(asset: AssetManifestEntry, record: AssetRecord,
    listener: (bytes: number, size?: number) => void, signal: AbortSignal, detach: (() => void)[]): Promise<void> {
    checkAbort(signal);
    let transfer = this.transfers.get(asset.url);
    while (transfer) {
      checkAbort(signal);
      if (transfer.generation > record.generation) throw new ModelAssetsDeletedError();
      if (transfer.generation < record.generation) {
        // A tombstone already fences the old writer's store mutations. Replace
        // it immediately; do not make the new generation depend on old cleanup.
        // Web Locks still serialize the actual writers when available.
        transfer.controller.abort(new ModelAssetsDeletedError());
        if (this.transfers.get(asset.url) === transfer) this.transfers.delete(asset.url);
        transfer = undefined;
        break;
      }
      if (!transfer.controller.signal.aborted) break;
      await signalWait(transfer.promise.catch(() => undefined), signal);
      // Another caller could have installed a newer generation while we waited.
      transfer = this.transfers.get(asset.url);
    }
    checkAbort(signal);
    if (!transfer) {
      const controller = new AbortController();
      const created: Transfer = { generation: record.generation, controller, listeners: new Set(), bytes: compatible(record, asset) ? record.bytes : 0,
        size: asset.sizeBytes ?? (compatible(record, asset) ? record.sizeBytes : undefined), promise: Promise.resolve() };
      transfer = created;
      this.transfers.set(asset.url, created);
      const run = () => this.transfer(asset, record.generation, created);
      created.promise = Promise.resolve().then(() => this.deps.lock
        ? this.deps.lock(asset.url, controller.signal, run) : run()).catch(error => {
          checkAbort(controller.signal);
          throw error;
        }).finally(() => {
          if (this.transfers.get(asset.url) === created) this.transfers.delete(asset.url);
        });
      // Cancellation can release every waiter before the writer settles.
      void created.promise.catch(() => undefined);
    }
    const active = transfer;
    active.listeners.add(listener);
    let released = false;
    const release = () => {
      if (released) return;
      released = true; active.listeners.delete(listener);
      if (!active.listeners.size) active.controller.abort();
    };
    detach.push(release);
    listener(active.bytes, active.size);
    try { await signalWait(active.promise, signal); } finally { release(); }
  }

  private async transfer(asset: AssetManifestEntry, generation: number, transfer: Transfer): Promise<void> {
    const { store } = this.deps, signal = transfer.controller.signal;
    let record = await store.stat(asset.url);
    if (record.generation !== generation) throw new ModelAssetsDeletedError();
    if (record.complete && compatible(record, asset)) {
      transfer.bytes = record.bytes; transfer.size = record.sizeBytes;
      for (const listener of transfer.listeners) listener(record.bytes, record.sizeBytes);
      return;
    }
    const reset = async () => {
      const next = { ...emptyRecord(asset.url, generation), sha256: asset.sha256, sizeBytes: asset.sizeBytes };
      await store.save(record, next, undefined, true); record = next;
    };
    if (!compatible(record, asset) || (record.bytes && !asset.sha256 && !record.validator)) await reset();
    if (!record.sha256 && asset.sha256) { const next = { ...record, sha256: asset.sha256, sizeBytes: asset.sizeBytes }; await store.save(record, next); record = next; }
    let hash = new Sha256();
    for (let i = 0; i < record.chunks; i++) { checkAbort(signal); hash.update(await store.chunk(record, i)); }
    const publishProgress = () => {
      transfer.bytes = record.bytes; transfer.size = record.sizeBytes;
      for (const listener of transfer.listeners) listener(record.bytes, record.sizeBytes);
    };
    const finalize = async () => {
      checkAbort(signal);
      if (record.sizeBytes !== undefined && record.bytes !== record.sizeBytes) throw new AssetIntegrityError("Asset length differs from manifest/response");
      const digest = hash.digest();
      if (asset.sha256 && digest !== asset.sha256) {
        await reset(); throw new AssetIntegrityError(`SHA-256 mismatch: ${asset.url}`);
      }
      const next = { ...record, complete: true, sha256: digest };
      await store.save(record, next); record = next; publishProgress();
    };
    // A cancelled operation may have saved every byte before its final commit.
    if (record.sizeBytes !== undefined && record.bytes === record.sizeBytes) { await finalize(); return; }
    checkAbort(signal);
    const offset = record.bytes;
    const headers: Record<string, string> = {};
    if (offset) { headers.Range = `bytes=${offset}-`; if (record.validator) headers["If-Range"] = record.validator; }
    const response = await this.deps.fetch(asset.url, { signal, headers });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      if (!response.ok || !response.body) throw new Error(`Asset download failed (${response.status}): ${asset.url}`);
      const encoding = response.headers.get("Content-Encoding");
      // Browser streams are decoded: encoded Content-Length cannot validate them.
      const encoded = !!encoding && encoding !== "identity";
      if (encoded && response.status === 206) throw new AssetIntegrityError("Encoded asset ranges cannot be resumed safely");
      const contentLength = encoded ? undefined : lengthHeader(response.headers.get("Content-Length"));
      let size = asset.sizeBytes;
      if (response.status === 206) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
        if (!range || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[2]) + 1 !== Number(range[3]) ||
          (contentLength !== undefined && contentLength !== Number(range[2]) - offset + 1) ||
          (size !== undefined && size !== Number(range[3]))) throw new AssetIntegrityError("Invalid asset Content-Range");
        size = Number(range[3]);
      } else if (response.status === 200) {
        if (offset) { await reset(); hash = new Sha256(); }
        if (size !== undefined && contentLength !== undefined && size !== contentLength) throw new AssetIntegrityError("Content-Length differs from asset manifest");
        size ??= contentLength;
      } else throw new AssetIntegrityError(`Unexpected asset status: ${response.status}`);
      const etag = response.headers.get("ETag");
      const validator = etag && !etag.startsWith("W/") ? etag : undefined;
      if (response.status === 206 && record.validator && validator && validator !== record.validator)
        throw new AssetIntegrityError("Asset validator changed during resume");
      if (response.status === 206 && !asset.sha256 && (!validator || validator !== record.validator))
        throw new AssetIntegrityError("Cannot validate resumed runtime asset");
      const next = { ...record, sizeBytes: size, validator };
      await store.save(record, next); record = next; publishProgress();
      reader = response.body.getReader();
      let received = 0;
      for (;;) {
        checkAbort(signal);
        const { value, done } = await reader.read();
        if (done) break;
        // Bound individual IDB values even if a transport provides huge chunks.
        for (let offset = 0; offset < value.length; offset += 1024 * 1024) {
          checkAbort(signal);
          const chunk = value.slice(offset, offset + 1024 * 1024);
          if (record.sizeBytes !== undefined && record.bytes + chunk.length > record.sizeBytes)
            throw new AssetIntegrityError("Asset response exceeds expected length");
          const next = { ...record, bytes: record.bytes + chunk.length, chunks: record.chunks + 1 };
          await store.save(record, next, chunk); record = next;
          hash.update(chunk); received += chunk.length; publishProgress();
        }
      }
      if (contentLength !== undefined && received !== contentLength) throw new AssetIntegrityError("Truncated asset response");
      await finalize();
    } finally {
      if (reader) { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      else await response.body?.cancel().catch(() => undefined);
    }
  }

  async deleteModelAssets(id: string): Promise<void> {
    const existing = this.deletions.get(id);
    if (existing) return existing;
    const urls = this.deps.privateManifest(id).filter(asset => !asset.shared).map(asset => asset.url);
    const error = new ModelAssetsDeletedError();
    for (const caller of this.callers.get(id) ?? []) caller.abort(error);
    for (const url of urls) this.transfers.get(url)?.controller.abort(error);
    const deletion = this.deps.store.delete(urls).finally(() => {
      if (this.deletions.get(id) === deletion) this.deletions.delete(id);
    });
    this.deletions.set(id, deletion);
    return deletion;
  }
}
