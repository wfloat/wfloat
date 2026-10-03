import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setImmediate as tick } from 'node:timers/promises';
import { AssetManager } from '../manager.ts';
import { emptyRecord, readStoredAsset, IndexedDbAssetStore, assetStore } from '../store.ts';
import { AssetConflictError, AssetIntegrityError, AssetStorageError, ModelAssetsDeletedError } from '../types.ts';
import { Sha256 } from '../sha256.ts';
import { canRequestSilently, requestPersistence } from '../persistence.ts';
import { configureRuntimeAssets, getModelAssetManifest, getModelDownloadManifest } from '../manifest.ts';
const bytes = text => new TextEncoder().encode(text);
const sha = data => createHash('sha256').update(data).digest('hex');
const asset = (name, content, shared = false) => ({ url: `https://example.test/${name}`, sizeBytes: content.length, sha256: sha(content), shared });
class Store {
  records = new Map(); chunks = new Map(); failWrite = false;
  async stat(url) { return structuredClone(this.records.get(url) ?? emptyRecord(url)); }
  compare(before) {
    const actual = this.records.get(before.url) ?? emptyRecord(before.url);
    if (before.generation !== actual.generation) throw new ModelAssetsDeletedError();
    if (actual.bytes !== before.bytes || actual.chunks !== before.chunks || actual.complete !== before.complete) throw new AssetConflictError();
  }
  async chunk(record, i) { this.compare(record); const chunk = this.chunks.get(record.url)?.[i];
    if (!chunk) throw new AssetIntegrityError(); return chunk.slice(); }
  async save(before, after, chunk, reset) {
    if (this.failWrite) throw new AssetStorageError('quota exceeded');
    this.compare(before);
    if (reset) this.chunks.delete(before.url);
    if (chunk) { const chunks = this.chunks.get(before.url) ?? []; chunks[before.chunks] = chunk.slice(); this.chunks.set(before.url, chunks); }
    this.records.set(before.url, structuredClone(after));
  }
  async delete(urls) { for (const url of urls) { const old = this.records.get(url) ?? emptyRecord(url);
    this.records.set(url, emptyRecord(url, old.generation + 1)); this.chunks.delete(url); } }
}
async function until(predicate) { for (let i=0;i<1000;i++) { if (await predicate()) return; await tick(); } throw Error('Condition did not become true'); }
function transport() {
  const requests = [];
  const fetch = async (url, options) => {
    let stream;
    const request = { url, options, respond(content, { status = 200, headers = {} } = {}) {
      const body = new ReadableStream({ start(c) { stream = c; }, cancel() { request.cancelled = true; } });
      options.signal?.addEventListener('abort', () => { try { stream.error(new DOMException('aborted', 'AbortError')); } catch {} }, {once:true});
      request.resolve(new Response(body, { status, headers: { 'Content-Length': String(content.length), ...headers } }));
      return { send(value) { if (!request.cancelled) stream.enqueue(value); }, end() { stream.close(); } };
    } };
    requests.push(request);
    return new Promise(resolve => { request.resolve = resolve; });
  };
  return { fetch, requests };
}
function manager(store, files, fetch, extra = {}) {
  return new AssetManager({ store, manifest: id => files[id], privateManifest: id => files[id], fetch,
    persistence: async () => {}, ...extra });
}
function automatic(content, counter = {n:0}) { return async () => {counter.n++; return new Response(content, {headers:{'Content-Length':String(content.length)}});}; }

test('owned incremental SHA-256 matches standard vectors and arbitrary chunk boundaries', () => {
  for (const length of [0,1,3,55,56,63,64,65,127,1000,1000000]) {
    const data = Uint8Array.from({length}, (_,i) => i % 251); const hash = new Sha256();
    for (let i=0;i<data.length;i+=37) hash.update(data.subarray(i,i+37));
    assert.equal(hash.digest(), sha(data));
  }
});
test('manifest includes eSpeak only for TTS, and requires configured shared runtime', () => {
  assert.equal(getModelAssetManifest('wfloat/wfloat-tts').filter(a=>a.shared).length,1);
  assert.equal(getModelAssetManifest('snakers4/silero-vad').filter(a=>a.shared).length,0);
  assert.throws(()=>getModelDownloadManifest('wfloat/wfloat-tts'), /Configure/);
  configureRuntimeAssets('speech',[{url:'https://example.test/runtime.wasm'}]);
  assert.equal(getModelDownloadManifest('wfloat/wfloat-tts').at(-1).shared,true);
  assert.throws(()=>getModelAssetManifest('__proto__'),/Unknown/);
  for (const a of getModelAssetManifest('wfloat/wfloat-tts')) assert.ok(a.sizeBytes>0 && a.sha256.length===64);
});
test('downloads commit verified bytes, reuse skips downloading, read returns owned bytes', async () => {
  const data=bytes('abcdef'), a=asset('a',data), store=new Store(), count={n:0};
  const m=manager(store,{a:[a]},automatic(data,count)), first=[], second=[];
  await m.downloadModel('a',{onProgress:e=>first.push(e)});
  const result=await readStoredAsset(store,a.url); assert.deepEqual(result,data);
  result[0]=0; assert.deepEqual(await readStoredAsset(store,a.url),data);
  await m.downloadModel('a',{onProgress:e=>second.push(e)});
  assert.equal(count.n,1); assert.deepEqual(second,[{phase:'checking'},{phase:'ready'}]);
  assert.equal(first.at(-2).progress,1); assert.equal(first.at(-1).phase,'ready');
});
test('per-URL sharing, caller-local abort, and late joiner denominator', async () => {
  const data=bytes('abcdef'), a=asset('a',data), store=new Store(), t=transport(), m=manager(store,{a:[a]},t.fetch);
  const signal=new AbortController(), events=[];
  const p1=m.downloadModel('a',{signal:signal.signal}); const rejection=assert.rejects(p1,{name:'AbortError'});
  await until(()=>t.requests.length===1); const stream=t.requests[0].respond(data);
  stream.send(data.subarray(0,2)); await until(async()=>(await store.stat(a.url)).bytes===2);
  const p2=m.downloadModel('a',{onProgress:e=>events.push(e)});
  await until(()=>events.some(e=>e.phase==='downloading'));
  signal.abort(); await rejection;
  assert.equal(t.requests[0].options.signal.aborted,false);
  stream.send(data.subarray(2)); stream.end(); await p2;
  assert.equal(t.requests.length,1);
  const downloads=events.filter(e=>e.phase==='downloading');
  assert.equal(downloads[0].totalBytes,4); assert.equal(downloads[0].downloadedBytes,0);
  assert.equal(downloads.at(-1).downloadedBytes,4);
});
test('last caller abort leaves durable prefix and next call resumes Range', async () => {
  const data=bytes('abcdef'), a=asset('a',data), store=new Store(), t=transport(), m=manager(store,{a:[a]},t.fetch);
  const c=new AbortController(), p=m.downloadModel('a',{signal:c.signal}), reject=assert.rejects(p,{name:'AbortError'});
  await until(()=>t.requests.length===1); const stream=t.requests[0].respond(data);
  stream.send(data.subarray(0,2)); await until(async()=>(await store.stat(a.url)).bytes===2);
  c.abort(); await reject;
  const next=m.downloadModel('a'); await until(()=>t.requests.length===2);
  assert.equal(t.requests[1].options.headers.Range,'bytes=2-');
  const resumed=t.requests[1].respond(data.subarray(2),{status:206,headers:{'Content-Range':'bytes 2-5/6'}});
  resumed.send(data.subarray(2));resumed.end();await next;
  assert.deepEqual(await readStoredAsset(store,a.url),data);
});
test('ignored Range safely resets rather than appending a full response', async () => {
  const data=bytes('abcdef'), a=asset('a',data), store=new Store();
  await store.save(emptyRecord(a.url),{...emptyRecord(a.url),bytes:2,chunks:1,sha256:a.sha256,sizeBytes:6},data.subarray(0,2));
  await manager(store,{a:[a]},automatic(data)).downloadModel('a');
  assert.deepEqual(await readStoredAsset(store,a.url),data);
});
test('bad checksum clears unusable bytes; truncated response keeps usable prefix', async () => {
  const data=bytes('abcdef'), a=asset('a',data), store=new Store();
  await assert.rejects(manager(store,{a:[a]},automatic(bytes('badbad'))).downloadModel('a'),AssetIntegrityError);
  assert.equal((await store.stat(a.url)).bytes,0);
  await assert.rejects(manager(store,{a:[a]},async()=>new Response(data.subarray(0,2),{headers:{'Content-Length':'6'}})).downloadModel('a'),/Truncated/);
  assert.equal((await store.stat(a.url)).bytes,2); assert.equal((await store.stat(a.url)).complete,false);
});
test('header mismatch and malformed Content-Range never publish', async () => {
  const data=bytes('abc'),a=asset('a',data),store=new Store();
  await assert.rejects(manager(store,{a:[a]},async()=>new Response(data,{headers:{'Content-Length':'2'}})).downloadModel('a'),AssetIntegrityError);
  await assert.rejects(manager(store,{a:[a]},async()=>new Response(data,{status:206,headers:{'Content-Length':'3','Content-Range':'bytes 1-3/4'}})).downloadModel('a'),AssetIntegrityError);
  assert.equal((await store.stat(a.url)).complete,false);
});
test('storage failure rejects and cancels transport; no memory-only success', async () => {
  const data=bytes('abc'),a=asset('a',data),store=new Store(); store.failWrite=true;
  const count={n:0}; await assert.rejects(manager(store,{a:[a]},automatic(data,count)).downloadModel('a'),AssetStorageError);
  assert.equal(count.n,0);
  await assert.rejects(new IndexedDbAssetStore().stat(a.url),AssetStorageError);
});
test('delete stops affected caller, preserves shared dependency for another model, rejects stale writer', async () => {
  const data=bytes('abc'),a=asset('a',data),b=asset('b',data),shared=asset('shared',data,true),store=new Store(),t=transport();
  const m=manager(store,{a:[a,shared],b:[b,shared]},t.fetch);
  const pa=m.downloadModel('a'), rejected=assert.rejects(pa,ModelAssetsDeletedError),pb=m.downloadModel('b');
  await until(()=>t.requests.length===3);
  const before=await store.stat(a.url);
  await m.deleteModelAssets('a'); await rejected;
  await assert.rejects(store.save(before,{...before,complete:true}),ModelAssetsDeletedError);
  for (const request of t.requests.filter(r=>r.url!==a.url)) {const s=request.respond(data);s.send(data);s.end();}
  // Let the aborted fetch settle even though it never returned headers.
  const abandoned=t.requests.find(r=>r.url===a.url); const dead=abandoned.respond(data);dead.send(data);dead.end();
  await pb;
  assert.equal((await store.stat(shared.url)).complete,true);assert.equal((await store.stat(a.url)).bytes,0);
});
test('deletion across coordinators invalidates active and queued writers', async () => {
  const data=bytes('abc'),a=asset('a',data),store=new Store(),t=transport();
  const owner=manager(store,{a:[a]},t.fetch), other=manager(store,{a:[a]},automatic(data));
  const p=owner.downloadModel('a'), rejected=assert.rejects(p,ModelAssetsDeletedError);
  await until(()=>t.requests.length===1); const stream=t.requests[0].respond(data);
  stream.send(data.subarray(0,1)); await until(async()=>(await store.stat(a.url)).bytes===1);
  await other.deleteModelAssets('a'); stream.send(data.subarray(1));stream.end(); await rejected;
  assert.equal((await store.stat(a.url)).complete,false);
  await other.downloadModel('a'); assert.deepEqual(await readStoredAsset(store,a.url),data);
});
test('unknown totals are indeterminate and cached integrity is checked during worker reads', async () => {
  const data=bytes('abcdef'),a={url:'https://example.test/a',shared:true},store=new Store(),events=[];
  await manager(store,{a:[a]},async()=>new Response(data)).downloadModel('a',{onProgress:e=>events.push(e)});
  assert.ok(events.filter(e=>e.phase==='downloading').every(e=>e.totalBytes===undefined && e.progress===undefined));
  store.chunks.get(a.url)[0][0]=0;
  await assert.rejects(readStoredAsset(store,a.url),AssetIntegrityError);
});
test('safe competing writer compare rejects rather than mixing chunks', async () => {
  const store=new Store(), before=emptyRecord('x');
  await store.save(before,{...before,bytes:1,chunks:1},bytes('a'));
  await assert.rejects(store.save(before,{...before,bytes:1,chunks:1},bytes('b')),AssetConflictError);
});
test('auto persistence recognizes mainstream Chromium and Apple WebKit, including iOS Firefox', () => {
  const appleMobile='Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)';
  const appleDesktop='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)';
  const silent=[
    'Mozilla/5.0 Chrome/123.0.0.0 Safari/537.36',
    // Brave normally uses the Chromium UA without a distinct Brave token.
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    'Chrome/123 OPR/90', 'Chrome/123 SamsungBrowser/20',
    `${appleDesktop} Version/17.6 Safari/605.1.15`,
    `${appleMobile} Version/17.6 Mobile/15E148 Safari/604.1`,
    `${appleDesktop} Version/17.6 Mobile/15E148 Safari/604.1`, // iPad desktop UA
    `${appleMobile} FxiOS/130.0 Mobile/15E148 Safari/605.1.15`,
    `${appleMobile} CriOS/129.0.0.0 Mobile/15E148 Safari/604.1`,
    `${appleMobile} EdgiOS/129.0 Mobile/15E148 Safari/605.1.15`,
  ];
  for(const ua of silent) assert.equal(canRequestSilently(ua),true,ua);
  for(const ua of [
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:130.0) Gecko/20100101 Firefox/130.0',
    'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0',
    'Chrome/123 Electron/20', 'Linux; Android 14; wv) Chrome/123',
    'UnknownBrowser/1.0', `${appleMobile} Mobile/15E148`,
    'Mozilla/5.0 (iPhone) Gecko/20100101 Firefox/130.0',
  ]) assert.equal(canRequestSilently(ua),false,ua);
});

test('load lease fences deletion after download, before runtime readiness', async () => {
  const data=bytes('abc'),a=asset('a',data),store=new Store(),m=manager(store,{a:[a]},automatic(data));
  const lease=await m.acquireModelAssetLease('a');
  await m.downloadModel('a',{signal:lease.signal});
  await m.deleteModelAssets('a');
  assert.equal(lease.signal.aborted,true);
  await assert.rejects(lease.assertCurrent(),ModelAssetsDeletedError);lease.release();lease.release();
});
test('load lease detects cross-context deletion and preserves successful instances after release', async () => {
  const data=bytes('abc'),a=asset('a',data),store=new Store(),m=manager(store,{a:[a]},automatic(data));
  const other=manager(store,{a:[a]},automatic(data));
  const lease=await m.acquireModelAssetLease('a');await m.downloadModel('a',{signal:lease.signal});
  await other.deleteModelAssets('a');await assert.rejects(lease.assertCurrent(),ModelAssetsDeletedError);lease.release();
  const ready=await m.acquireModelAssetLease('a');await m.downloadModel('a',{signal:ready.signal});
  await ready.assertCurrent();ready.release();await m.deleteModelAssets('a');assert.equal(ready.signal.aborted,false);
});
test('load lease forwards caller cancellation only while pending', async () => {
  const data=bytes('abc'),a=asset('a',data),store=new Store(),m=manager(store,{a:[a]},automatic(data));
  const c=new AbortController(),lease=await m.acquireModelAssetLease('a',{signal:c.signal});
  c.abort('custom reason');await assert.rejects(lease.assertCurrent(),{name:'AbortError'});lease.release();
  const d=new AbortController(),ready=await m.acquireModelAssetLease('a',{signal:d.signal});ready.release();d.abort();
  assert.equal(ready.signal.aborted,false);
});


test('lease deletion stays recognizable through the download signal', async () => {
  const data=bytes('abc'),a=asset('a',data),store=new Store(),t=transport(),m=manager(store,{a:[a]},t.fetch);
  const lease=await m.acquireModelAssetLease('a');const p=m.downloadModel('a',{signal:lease.signal});
  const rejected=assert.rejects(p,ModelAssetsDeletedError);
  await until(()=>t.requests.length===1);await m.deleteModelAssets('a');await rejected;lease.release();
  const stream=t.requests[0].respond(data);stream.send(data);stream.end();
});
test('persistence off/auto/request, denial memoization, and concurrent calls', async () => {
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,'navigator');
  const claim=assetStore.claimPersistence;let requests=0,claims=0,persisted=false;
  const nav={userAgent:'Firefox/123',storage:{persisted:async()=>persisted,persist:async()=>{requests++;await tick();return false;}}};
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:nav});
  assetStore.claimPersistence=async()=>{claims++;return true;};
  try {
    await requestPersistence('off');await requestPersistence('auto');assert.equal(requests,0);
    nav.userAgent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15';
    const persist=nav.storage.persist;delete nav.storage.persist;
    await requestPersistence('auto');assert.equal(claims,0); // Capability remains required.
    nav.storage.persist=persist;
    await Promise.all([requestPersistence('auto'),requestPersistence('request')]);
    assert.equal(requests,1);assert.equal(claims,1);
    await requestPersistence('request');assert.equal(requests,1);
    persisted=true;await requestPersistence('request');assert.equal(requests,1);
  } finally {Object.defineProperty(globalThis,'navigator',descriptor);assetStore.claimPersistence=claim;}
});

test('aggregate progress excludes saved prefixes and smooths only arriving bytes', async () => {
  const left=bytes('abcdef'),right=bytes('1234'),a=asset('a',left),b=asset('b',right),store=new Store(),t=transport(),events=[];
  await store.save(emptyRecord(a.url),{...emptyRecord(a.url),bytes:2,chunks:1,sha256:a.sha256,sizeBytes:6},left.subarray(0,2));
  let clock=0;const m=manager(store,{both:[a,b]},t.fetch,{now:()=>clock});
  const p=m.downloadModel('both',{onProgress:e=>events.push(e)});await until(()=>t.requests.length===2);
  const sa=t.requests.find(r=>r.url===a.url).respond(left.subarray(2),{status:206,headers:{'Content-Range':'bytes 2-5/6'}});
  const sb=t.requests.find(r=>r.url===b.url).respond(right);
  assert.equal(events.find(e=>e.phase==='downloading').totalBytes,8);
  clock=1000;sa.send(left.subarray(2,4));await until(()=>events.some(e=>e.bytesPerSecond!==undefined));
  const measured=events.find(e=>e.bytesPerSecond!==undefined);
  assert.equal(measured.downloadedBytes,2);assert.equal(measured.bytesPerSecond,2);assert.equal(measured.estimatedTimeRemainingMs,3000);
  sa.send(left.subarray(4));sa.end();sb.send(right);sb.end();await p;
  const done=events.filter(e=>e.phase==='downloading').at(-1);assert.equal(done.totalBytes,8);assert.equal(done.downloadedBytes,8);assert.equal(done.progress,1);
});
test('quota failure after checkpoint retains saved prefix and cancels response reader', async () => {
  const data=bytes('abcdef'),a=asset('a',data),store=new Store(),t=transport(),m=manager(store,{a:[a]},t.fetch);
  const p=m.downloadModel('a'),rejected=assert.rejects(p,AssetStorageError);
  await until(()=>t.requests.length===1);const stream=t.requests[0].respond(data);
  stream.send(data.subarray(0,2));await until(async()=>(await store.stat(a.url)).bytes===2);
  store.failWrite=true;stream.send(data.subarray(2));await rejected;
  assert.equal((await store.stat(a.url)).bytes,2);assert.equal((await store.stat(a.url)).complete,false);assert.equal(t.requests[0].cancelled,true);
});

test('failed call cancels deferred joins before an older aborted writer finishes', async () => {
  const data=bytes('abcdef'),a=asset('a',data),b=asset('b',data),store=new Store();
  let releaseCheckpoint;
  const checkpointGate=new Promise(resolve=>{releaseCheckpoint=resolve;});
  const save=store.save.bind(store);let checkpointHeld=false;
  store.save=async(...args)=>{
    await save(...args);
    if(args[2] && !checkpointHeld) {checkpointHeld=true;await checkpointGate;}
  };
  const requests=[];
  const fetch=async(url,options)=>{
    requests.push({url,options});
    if(url===b.url) return new Response(null,{status:500});
    const body=requests.filter(r=>r.url===a.url).length===1 ? data.subarray(0,2) : data;
    return new Response(body,{headers:{'Content-Length':String(data.length)}});
  };
  const m=manager(store,{a:[a],both:[a,b]},fetch),cancel=new AbortController();
  const first=m.downloadModel('a',{signal:cancel.signal}),cancelled=assert.rejects(first,{name:'AbortError'});
  await until(()=>checkpointHeld);cancel.abort();await cancelled;
  const failed=m.downloadModel('both');await assert.rejects(failed,/500/);
  releaseCheckpoint();
  // Drain the deferred writer/join continuations without waiting for a polling timer.
  for(let i=0;i<10;i++) await tick();
  assert.equal(requests.filter(r=>r.url===a.url).length,1,'failed operation must not start an orphan fetch');
});

test('new generation replaces stale transfer before cross-context deletion polling', async () => {
  const data=bytes('abcdef'),a=asset('a',data),store=new Store();
  let releaseOld;
  const oldResponse=new Promise(resolve=>{releaseOld=resolve;});
  let requests=0,oldSignal;
  const fetch=async(_url,options)=>{
    requests++;
    if(requests===1) {oldSignal=options.signal;return oldResponse;}
    return new Response(data,{headers:{'Content-Length':String(data.length)}});
  };
  const m=manager(store,{a:[a]},fetch),other=manager(store,{a:[a]},automatic(data));
  const first=m.downloadModel('a'),deleted=assert.rejects(first,ModelAssetsDeletedError);
  await until(()=>requests===1);
  await other.deleteModelAssets('a');
  const events=[],fresh=m.downloadModel('a',{onProgress:e=>events.push(e)});
  // Allow only microtask/immediate work: do not wait for the 250ms generation poll.
  for(let i=0;i<10 && requests<2;i++) await tick();
  releaseOld(new Response(data,{headers:{'Content-Length':String(data.length)}}));
  await deleted;
  await fresh;
  assert.equal(requests,2);assert.equal(oldSignal.aborted,true);
  assert.equal(events.find(e=>e.phase==='downloading').totalBytes,data.length);
  assert.deepEqual(await readStoredAsset(store,a.url),data);
});

test('late old-generation caller cannot abort a newer-generation writer', async () => {
  const data=bytes('abcdef'),a=asset('a',data),store=new Store(),t=transport();
  const stat=store.stat.bind(store);let releaseSnapshot,snapshotHeld=false;
  const snapshotGate=new Promise(resolve=>{releaseSnapshot=resolve;});
  store.stat=async(url)=>{
    const record=await stat(url);
    if(!snapshotHeld) {snapshotHeld=true;await snapshotGate;}
    return record;
  };
  const m=manager(store,{a:[a]},t.fetch),other=manager(store,{a:[a]},automatic(data));
  const old=m.downloadModel('a'),deleted=assert.rejects(old,ModelAssetsDeletedError);
  await until(()=>snapshotHeld);await other.deleteModelAssets('a');
  const fresh=m.downloadModel('a');await until(()=>t.requests.length===1);
  releaseSnapshot();await deleted;
  assert.equal(t.requests[0].options.signal.aborted,false);
  const stream=t.requests[0].respond(data);stream.send(data);stream.end();await fresh;
  assert.deepEqual(await readStoredAsset(store,a.url),data);
});

test('cross-context deletion while persistence is pending fences the download', async () => {
  const data=bytes('abc'),a=asset('a',data),store=new Store(),count={n:0};
  let resume,entered=false;
  const gate=new Promise(resolve=>{resume=resolve;});
  const m=manager(store,{a:[a]},automatic(data,count),{persistence:async()=>{entered=true;await gate;}});
  const other=manager(store,{a:[a]},automatic(data));
  const pending=m.downloadModel('a');
  const result=pending.then(()=> 'ready',error=>error.name);
  await until(()=>entered);await other.deleteModelAssets('a');resume();
  assert.equal(await result,'ModelAssetsDeletedError');
  assert.equal(count.n,0);assert.equal((await store.stat(a.url)).bytes,0);
});

test('replacement of incompatible saved asset does not count discarded bytes as progress', async () => {
  const old=bytes('old-long-content'),data=bytes('new'),a=asset('a',data),store=new Store(),events=[];
  await store.save(emptyRecord(a.url),{...emptyRecord(a.url),bytes:old.length,chunks:1,sizeBytes:old.length,sha256:sha(old),complete:true},old);
  await manager(store,{a:[a]},automatic(data)).downloadModel('a',{onProgress:e=>events.push(e)});
  const downloading=events.filter(e=>e.phase==='downloading');
  assert.ok(downloading.every(e=>e.downloadedBytes<=e.totalBytes),JSON.stringify(downloading));
  assert.equal(downloading.at(-1).downloadedBytes,data.length);
});

test('caller joining after persistence uses the current durable prefix for progress', async () => {
  const data=bytes('abcdef'),a=asset('a',data),store=new Store(),t=transport();
  const owner=manager(store,{a:[a]},t.fetch);let resume,entered=false;
  const gate=new Promise(resolve=>{resume=resolve;});
  const events=[],other=manager(store,{a:[a]},automatic(data),{persistence:async()=>{entered=true;await gate;}});
  const joining=other.downloadModel('a',{onProgress:e=>events.push(e)});
  await until(()=>entered);
  const first=owner.downloadModel('a');await until(()=>t.requests.length===1);
  const stream=t.requests[0].respond(data);stream.send(data.subarray(0,2));
  await until(async()=>(await store.stat(a.url)).bytes===2);
  resume();await joining;
  assert.equal(events.find(e=>e.phase==='downloading').totalBytes,4);
  // The independent writer safely replaced this partial; old owner must conflict.
  const rejected=assert.rejects(first,AssetConflictError);stream.send(data.subarray(2));stream.end();await rejected;
});

test('abort from initial download progress observes abandoned join promises', async () => {
  const data=bytes('abc'),a=asset('a',data),store=new Store(),count={n:0},c=new AbortController();
  const m=manager(store,{a:[a]},automatic(data,count));
  await assert.rejects(m.downloadModel('a',{signal:c.signal,onProgress:e=>{
    if(e.phase==='downloading') c.abort();
  }}),{name:'AbortError'});
  // node:test also fails this test on an unhandled internal join rejection.
  await tick();assert.equal(count.n,0);
});
