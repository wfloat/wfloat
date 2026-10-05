import type { DownloadModelOptions } from "./types.js";
import { assetStore } from "./store.js";

let attempted = false;
let pending: Promise<void> | undefined;
const visitStarted = typeof performance === "undefined" ? Date.now() : performance.timeOrigin;
/** Mainstream Chromium and recognized Apple WebKit browsers decide silently.
 * requestPersistence also feature-detects persist(): UA versions alone do not
 * establish Storage API support. FxiOS is WebKit, unlike desktop/Android Firefox.
 * WebKit policy: https://webkit.org/blog/14403/updates-to-storage-policy/ */
export function canRequestSilently(userAgent: string): boolean {
  if (/(?:Electron|; wv\)|Version\/.*Chrome)/.test(userAgent)) return false;
  if (/(?:Chrome|Chromium|Edg)\/\d+/.test(userAgent)) return true;
  // AppleWebKit is also present in Chromium UAs; require an Apple platform and
  // a known browser signature. Do not infer the engine from iOS alone.
  return /AppleWebKit\/\d+/.test(userAgent) &&
    /(?:iPhone|iPad|iPod|Macintosh)/.test(userAgent) &&
    !/(?:Firefox|Gecko)\//.test(userAgent) &&
    /(?:Version\/\d+.*Safari\/|(?:FxiOS|CriOS|EdgiOS)\/\d+)/.test(userAgent);
}
export async function requestPersistence(policy: DownloadModelOptions["persistence"] = "auto"): Promise<void> {
  if (policy === "off" || typeof navigator === "undefined" || !navigator.storage?.persist) return;
  const storage = navigator.storage;
  if (await storage.persisted().catch(() => false)) return;
  if (policy === "auto" && !canRequestSilently(navigator.userAgent)) return;
  if (pending) return pending;
  if (attempted) return;
  pending = (async () => {
    const request = async () => {
      if (await storage.persisted().catch(() => false)) return;
      // IndexedDB's transaction makes the decision atomic even without Web
      // Locks. No localStorage dependency (workers and restricted contexts work).
      if (!await assetStore.claimPersistence(visitStarted)) { attempted = true; return; }
      attempted = true;
      await storage.persist().catch(() => false);
    };
    if (navigator.locks) await navigator.locks.request("wfloat-persistence", request);
    else await request();
  })().finally(() => { pending = undefined; });
  return pending;
}
