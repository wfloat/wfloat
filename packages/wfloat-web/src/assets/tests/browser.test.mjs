import { IndexedDbAssetStore, emptyRecord, readStoredAsset } from '../store.ts';
import { AssetManager } from '../manager.ts';
import { Sha256 } from '../sha256.ts';
const output = document.querySelector('pre');
const assert = (value, message) => { if (!value) throw Error(message); };
const data = new TextEncoder().encode('tiny browser asset fixture');
const entry = { url: new URL('/fixture', location.href).href, sizeBytes: data.length,
  sha256: new Sha256().update(data).digest(), shared: false };
const lines = [];
async function rejects(promise, name) {
  try { await promise; } catch (error) { assert(error.name === name, `Expected ${name}, got ${error}`); return; }
  throw Error(`Expected rejection ${name}`);
}
try {
  const first = new IndexedDbAssetStore(), second = new IndexedDbAssetStore();
  const original = await first.stat(entry.url);
  const partial = { ...original, bytes: 3, chunks: 1, sha256: entry.sha256, sizeBytes: data.length };
  await first.save(original, partial, data.slice(0,3));
  assert((await second.stat(entry.url)).bytes === 3, 'Cross-connection checkpoint visibility');
  assert((await second.chunk(partial,0)).length === 3, 'Cross-connection bytes');
  await rejects(second.save(original, partial, data.slice(0,3)), 'AssetConflictError');
  await second.delete([entry.url]);
  await rejects(first.save(partial, { ...partial, complete: true }), 'ModelAssetsDeletedError');
  lines.push('PASS real IDB checkpoints, competing writes, deletion tombstones');
  const attempts = await Promise.all([first.claimPersistence(performance.timeOrigin), second.claimPersistence(performance.timeOrigin)]);
  assert(attempts.filter(Boolean).length === 1, 'Persistence atomic across connections');
  lines.push('PASS atomic persistence request claim');
  let requests = 0;
  const make = store => new AssetManager({ store, manifest:()=>[entry], privateManifest:()=>[entry],
    fetch: (...args) => { requests++; return fetch(...args); }, persistence:async()=>{},
    lock: async (url, signal, run) => navigator.locks.request(`test:${url}`, { signal }, run) });
  const a=make(first),b=make(second);
  await Promise.all([a.downloadModel('fixture'),b.downloadModel('fixture')]);
  assert(requests === 1, `Web Locks should deduplicate, got ${requests}`);
  const loaded=await readStoredAsset(second, entry.url);
  assert(new TextDecoder().decode(loaded) === new TextDecoder().decode(data), 'Real IDB read integrity');
  await a.deleteModelAssets('fixture');
  assert(new TextDecoder().decode(loaded) === new TextDecoder().decode(data), 'Loaded bytes survive deletion');
  await rejects(readStoredAsset(first,entry.url), 'AssetStorageError');
  lines.push('PASS real Web Locks deduplication, stored byte integrity, owned read lifetime');
  output.textContent = lines.join('\n'); document.body.dataset.result='pass';
} catch (error) { output.textContent=lines.join('\n')+'\n'+error.stack; document.body.dataset.result='fail'; }

await fetch('/report', {method:'POST',body:JSON.stringify({result:document.body.dataset.result,text:output.textContent})});
