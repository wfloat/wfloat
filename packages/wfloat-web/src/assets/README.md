# Internal browser asset lifecycle

`index.ts` provides `downloadModel(id, options): Promise<void>` and
`deleteModelAssets(id): Promise<void>`. `store.ts` provides the worker's
`readAsset(url, {signal}): Promise<Uint8Array>`. Reads never fetch; they return
owned, integrity-checked bytes. Runtime initialization must consume those bytes,
including WASM bytes, rather than initiating another network download.

## Loader integration

The public package index should register its exact build-generated runtime URLs
once, internally, using `configureRuntimeAssets("speech", [{url}])` and
`configureRuntimeAssets("llama", [{url}])`. Include a separate `.data` entry if a
runtime requires one. These are shared dependencies. This hook is not an
application-facing setup requirement. CI runtime URLs carrying a SHA-256 suffix
supply their own expected hash; release URLs without a digest are checked against
response lengths and a locally computed SHA-256 for subsequent stored reads.

`getModelAssetManifest` exposes registry model files and per-model shared data
(TTS eSpeak ZIP). `getModelDownloadManifest` adds registered runtime files and
rejects if runtime integration is missing. Unknown model IDs reject. Registry
`sizeBytes` and `sha256` flow through the existing generator without script edits.

Hold a lease across the entire pending load, not just the download:

```ts
const lease = await acquireModelAssetLease(id, { signal: options.signal });
try {
  await downloadModel(id, {
    ...options,
    signal: lease.signal,
    // Forward checking/downloading, suppress download-only ready here.
    onProgress: event => {
      if (event.phase !== "ready") options.onProgress?.(event);
    },
  });
  // Emit loading; initialize worker from readAsset(), observing lease.signal.
  // On cancellation/deletion, tear down privately allocated runtime resources.
  const model = await initializeWorkerFromStoredAssets(lease.signal);
  await lease.assertCurrent(); // Immediately before committing readiness.
  // Emit ready and return model. Any failure must clean up the private model.
  return model;
} finally {
  lease.release();
}
```

Lease helpers are internal integration, not public download/load handles.
Same-page deletion immediately aborts affected leases and downloads with
`ModelAssetsDeletedError`. Other contexts check durable generation tombstones on
every checkpoint and before readiness, with polling while pending. Releasing a
lease detaches caller cancellation and monitoring. Completed owned reads remain
valid after deletion; no live backing-file dependency is exposed.

## Storage and coordination

IndexedDB stores bounded chunks and checkpoint metadata in atomic transactions.
Writes request strict durability and reject on storage failure; there is no
memory-only fallback. A matching complete checkpoint is reused. Partial chunks
are rehashed incrementally before HTTP Range resume, and complete registered
assets must match both length and SHA-256 before publication. A server ignoring
Range causes a safe restart. Invalid range/length responses reject. Hash mismatch
clears the unusable partial. Valid prefixes survive cancellation/network failure.
No full-model buffer is needed during transfer/hash verification; worker reads
necessarily allocate the returned model bytes.

Web Locks coordinate per-URL writers across eligible contexts. Without Web Locks,
same-manager calls still share a transfer; transactional compare-and-set protects
against conflicting cross-context writes, which reject with AssetConflictError
instead of mixing data. Deletion increments durable generations and removes all
private chunks atomically. Stale writers cannot recreate those files; shared
runtime/data dependencies remain. No service worker or PWA installation is needed.

Persistence `off` skips requests; `request` allows browser permission UI; `auto`
recognizes mainstream Chromium and known Safari/Apple WebKit browser UAs,
including iOS Firefox (`FxiOS`), Chrome (`CriOS`), and Edge (`EdgiOS`). The actual
`persist()` capability is required, so UA detection alone never assumes Storage
API availability. Desktop/Android Firefox, unknown browsers, and unrecognized
embedded contexts are excluded from auto requests. WebKit documents heuristic
persistence grants and full Storage API support from Safari/iOS 17 in
[Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/). Requests are coordinated with Web Locks and an atomic
IndexedDB attempt timestamp. A denial is remembered for the page visit, with a
later visit allowed to retry. Permission denial itself is nonfatal. Browser
storage retention is never guaranteed. References:
[StorageManager.persist](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist),
[Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API), and
[IndexedDB durability](https://developer.mozilla.org/en-US/docs/Web/API/IDBDatabase/transaction).

## Verification

From the repository root:

```sh
node packages/wfloat-web/src/assets/tests/run.mjs
node packages/wfloat-web/src/assets/tests/run-browser.mjs
node packages/wfloat-web/src/assets/tests/stress-browser.mjs
packages/wfloat-web/node_modules/.bin/tsc --noEmit --strict --skipLibCheck \
  --target ES2020 --module ESNext --moduleResolution bundler --lib ES2020,DOM \
  packages/wfloat-web/src/assets/index.ts
```

The browser runner uses an isolated temporary Chromium profile, an ephemeral
localhost server, and a tiny local fixture. Set `CHROME_BINARY` outside macOS.
It exercises actual IndexedDB and Web Locks with independent store/coordinator
instances, not full tab suspension or browser restart recovery. Deterministic
Node tests cover transport failures, abort/deletion races, leases, progress,
SHA-256, persistence policy, and a transactional fake store. Neither test uses
real model downloads.

The Playwright stress runner uses an existing local installation (override
`PLAYWRIGHT_MODULE`) and installed Chrome (`PLAYWRIGHT_CHANNEL`, default `chrome`).
It bundles in memory and uses isolated browser contexts and 32-byte HTTP fixtures,
with no dependency installs or model downloads. Its 22 cases exercise separate
tabs, owner-tab closure/takeover, queued-waiter cancellation, deletion during a
pending persistence request, incompatible-cache progress, callback-triggered
abort, corrupt/truncated HTTP responses, changed ETags, transaction rollback,
injected quota errors, stored corruption, and 12 cancel/resume/delete cycles.
Quota errors are injected inside real IndexedDB transactions; the suite does not
fill the disk. Native synchronous quota errors remain recognizable as
`QuotaExceededError`; transaction aborts reject as `AssetStorageError`. No error
surface was renamed. Firefox/Safari, actual quota exhaustion, crash recovery,
suspended-tab recovery, and full worker/runtime integration still need validation.

The package asset ignore rule must remain root-anchored (`/assets/`) so it does
not hide this source directory.
