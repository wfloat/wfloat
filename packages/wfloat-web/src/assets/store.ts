import { AssetConflictError, AssetIntegrityError, AssetStorageError, checkAbort, ModelAssetsDeletedError } from "./types.js";
import { Sha256 } from "./sha256.js";

export interface AssetRecord {
  url: string;
  generation: number;
  bytes: number;
  chunks: number;
  complete: boolean;
  sha256?: string;
  sizeBytes?: number;
  validator?: string;
}
export function emptyRecord(url: string, generation = 0): AssetRecord {
  return { url, generation, bytes: 0, chunks: 0, complete: false };
}
/** Every mutation compares the generation and checkpoint in one transaction.
 * Deletion leaves a tombstone: owners, including suspended tabs, cannot resurrect it. */
export interface AssetStore {
  stat(url: string): Promise<AssetRecord>;
  chunk(record: AssetRecord, index: number): Promise<Uint8Array>;
  save(before: AssetRecord, after: AssetRecord, chunk?: Uint8Array, reset?: boolean): Promise<void>;
  delete(urls: readonly string[]): Promise<void>;
}
function compare(actual: AssetRecord, expected: AssetRecord): void {
  if (actual.generation !== expected.generation) throw new ModelAssetsDeletedError();
  if (actual.bytes !== expected.bytes || actual.chunks !== expected.chunks || actual.complete !== expected.complete)
    throw new AssetConflictError("Another context advanced this asset checkpoint");
}
export class IndexedDbAssetStore implements AssetStore {
  private database?: Promise<IDBDatabase>;
  private open(): Promise<IDBDatabase> {
    if (!this.database) this.database = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") { reject(new AssetStorageError("IndexedDB asset storage is unavailable")); return; }
      const request = indexedDB.open("wfloat-assets-v1", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("files", { keyPath: "url" });
        request.result.createObjectStore("chunks");
        request.result.createObjectStore("policy");
      };
      request.onerror = () => reject(new AssetStorageError("Cannot open asset storage", request.error));
      request.onblocked = () => reject(new AssetStorageError("Asset storage upgrade is blocked"));
      request.onsuccess = () => {
        request.result.onversionchange = () => { request.result.close(); this.database = undefined; };
        resolve(request.result);
      };
    }).catch(error => { this.database = undefined; throw error; });
    return this.database;
  }
  private async transaction<T>(mode: IDBTransactionMode,
    run: (tx: IDBTransaction, result: (value: T) => void, fail: (error: unknown) => void) => void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      let value: T;
      let failure: unknown;
      let tx: IDBTransaction;
      try { tx = db.transaction(["files", "chunks", "policy"], mode, { durability: "strict" }); }
      catch (error) { reject(new AssetStorageError("Cannot access asset storage", error)); return; }
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure ?? new AssetStorageError("Asset storage transaction failed", tx.error));
      // The transaction's abort is authoritative: never resolve on request success.
      const fail = (error: unknown) => { failure = error; tx.abort(); };
      try { run(tx, result => { value = result; }, fail); } catch (error) { fail(error); }
    });
  }
  /** Atomically claim one persistence request across overlapping page visits.
   * A later navigation can retry a denial; this is not a permanent denial flag. */
  claimPersistence(visitStarted: number): Promise<boolean> {
    return this.transaction("readwrite", (tx, result) => {
      const policy = tx.objectStore("policy");
      const request = policy.get("persistence-attempt");
      request.onsuccess = () => {
        if (typeof request.result === "number" && request.result >= visitStarted) { result(false); return; }
        policy.put(Date.now(), "persistence-attempt"); result(true);
      };
    });
  }
  stat(url: string): Promise<AssetRecord> {
    return this.transaction("readonly", (tx, result) => {
      const request = tx.objectStore("files").get(url);
      request.onsuccess = () => result(request.result ?? emptyRecord(url));
    });
  }
  chunk(record: AssetRecord, index: number): Promise<Uint8Array> {
    return this.transaction("readonly", (tx, result, fail) => {
      const request = tx.objectStore("files").get(record.url);
      request.onsuccess = () => {
        try { compare(request.result ?? emptyRecord(record.url), record); }
        catch (error) { fail(error); return; }
        const bytes = tx.objectStore("chunks").get([record.url, index]);
        bytes.onsuccess = () => {
          if (!(bytes.result instanceof Uint8Array)) fail(new AssetIntegrityError("Stored asset chunk is missing"));
          else result(bytes.result);
        };
      };
    });
  }
  save(before: AssetRecord, after: AssetRecord, chunk?: Uint8Array, reset = false): Promise<void> {
    return this.transaction("readwrite", (tx, result, fail) => {
      const files = tx.objectStore("files"), chunks = tx.objectStore("chunks");
      const request = files.get(before.url);
      request.onsuccess = () => {
        try {
          compare(request.result ?? emptyRecord(before.url), before);
          if (reset) chunks.delete(IDBKeyRange.bound([before.url, 0], [before.url, Number.MAX_SAFE_INTEGER]));
          if (chunk) chunks.put(chunk, [before.url, before.chunks]);
          files.put(after);
          result(undefined);
        } catch (error) { fail(error); }
      };
    });
  }
  delete(urls: readonly string[]): Promise<void> {
    return this.transaction("readwrite", (tx, result) => {
      const files = tx.objectStore("files"), chunks = tx.objectStore("chunks");
      for (const url of urls) {
        const request = files.get(url);
        request.onsuccess = () => {
          files.put(emptyRecord(url, (request.result?.generation ?? 0) + 1));
          chunks.delete(IDBKeyRange.bound([url, 0], [url, Number.MAX_SAFE_INTEGER]));
        };
      }
      result(undefined);
    });
  }
}
export const assetStore = new IndexedDbAssetStore();

/** Returns owned bytes, so deletion/unload cannot invalidate already-loaded instances.
 * Does not fetch: loaders must await downloadModel before dispatching worker reads. */
export async function readAsset(url: string, options: { signal?: AbortSignal } = {}): Promise<Uint8Array> {
  return readStoredAsset(assetStore, url, options.signal);
}
export async function readStoredAsset(store: AssetStore, url: string, signal?: AbortSignal): Promise<Uint8Array> {
  checkAbort(signal);
  const record = await store.stat(url);
  if (!record.complete) throw new AssetStorageError(`Asset is not downloaded: ${url}`);
  const bytes = new Uint8Array(record.bytes), hash = new Sha256();
  let offset = 0;
  for (let i = 0; i < record.chunks; i++) {
    checkAbort(signal);
    const chunk = await store.chunk(record, i);
    if (offset + chunk.length > bytes.length) throw new AssetIntegrityError("Stored asset length is invalid");
    bytes.set(chunk, offset); hash.update(chunk); offset += chunk.length;
  }
  checkAbort(signal);
  if (offset !== record.bytes || (record.sizeBytes !== undefined && offset !== record.sizeBytes) || hash.digest() !== record.sha256)
    throw new AssetIntegrityError(`Stored asset failed integrity verification: ${url}`);
  return bytes;
}
