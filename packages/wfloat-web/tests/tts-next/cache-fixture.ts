// Exercise the loader's actual storage/persistence dependencies with four local bytes.
import { AssetManager } from '../../src/assets/manager.js';
import { IndexedDbAssetStore, readStoredAsset } from '../../src/assets/store.js';
import { requestPersistence } from '../../src/assets/persistence.js';
const url = new URL('/cache-probe.bin', location.href).href;
const store = new IndexedDbAssetStore();
const manager = new AssetManager({
  store,
  manifest: () => [{ url, sizeBytes: 4, shared: false }],
  privateManifest: () => [{ url, sizeBytes: 4, shared: false }],
  fetch: (...args) => fetch(...args),
  persistence: requestPersistence,
});
export async function probe() {
  let persistenceRequests = 0;
  const original = navigator.storage.persist;
  navigator.storage.persist = async () => { persistenceRequests++; return false; };
  try {
    await manager.downloadModel('local-cache-probe', { persistence: 'off' });
    return { bytes: [...await readStoredAsset(store, url)], persistenceRequests };
  } finally { navigator.storage.persist = original; }
}
