// Tiny real HTTP/IndexedDB/Web Locks multi-tab regressions. No model downloads.
// PLAYWRIGHT_MODULE can select an existing installation; never installs browsers.
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const bundle = await build({stdin:{contents:`
import { AssetManager } from '../manager.ts';
import { IndexedDbAssetStore, emptyRecord, readStoredAsset } from '../store.ts';
window.setup = (entry, options={}) => {
  const store = new IndexedDbAssetStore();
  window.store=store; window.entry=entry; window.events={}; window.results={}; window.controllers={};
  window.manager = new AssetManager({store,manifest:()=>[entry],privateManifest:()=>[entry],fetch:window.fetch.bind(window),
    persistence:async()=>{if(options.holdPersistence) {window.persistenceEntered=true;await new Promise(r=>window.resumePersistence=r);}},
    ...(options.noLocks?{}:{lock:(url,signal,run)=>navigator.locks.request('stress:'+url,{signal},run)})});
  window.start = key => {
    const c=controllers[key]=new AbortController();events[key]=[];
    manager.downloadModel('fixture',{signal:c.signal,onProgress:e=>{events[key].push(e);if(options.abortOnDownload && e.phase==='downloading') c.abort();}})
      .then(()=>results[key]='ready',e=>results[key]=e.name);
  };
  window.seed = async (data, metadata={}) => {
    const before=await store.stat(entry.url);
    await store.save(before,{...before,bytes:data.length,chunks:1,sha256:entry.sha256,sizeBytes:entry.sizeBytes,...metadata},new Uint8Array(data));
  };
  window.read = async () => Array.from(await readStoredAsset(store,entry.url));
};`,resolveDir:fileURLToPath(new URL('.',import.meta.url)),loader:'js'},bundle:true,write:false,format:'esm',platform:'browser'});
const data=Buffer.from('abcdefghijklmnopqrstuvwxyz012345');
const sha=value=>createHash('sha256').update(value).digest('hex');
const fixtures=new Map(); let serial=0;
const server=createServer((req,res)=>{
  if(req.url==='/test.js') {res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text);return;}
  const f=fixtures.get(req.url);
  if(!f) {res.setHeader('Content-Type','text/html');res.end('<script type="module" src="/test.js"></script>');return;}
  const offset=Number(/bytes=(\d+)-/.exec(req.headers.range??'')?.[1]??0);
  f.requests.push({offset,range:req.headers.range});
  const resumed=offset>0 && !f.ignoreRange, start=resumed?offset:0;
  const body=f.corrupt?Buffer.alloc(data.length,120):data;
  res.writeHead(resumed?206:200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store','Content-Length':body.length-start,'ETag':'"fixture-v1"',
    ...(resumed?{'Content-Range':f.badRange?'bytes 1-31/32':`bytes ${start}-${body.length-1}/${body.length}`}:{})});
  if(f.hold && !resumed) {res.write(body.subarray(0,8));f.finish.push(()=>res.end(body.subarray(8)));}
  else if(f.truncate) {res.write(body.subarray(start,start+8));setTimeout(()=>res.destroy(),30);}
  else res.end(body.subarray(start));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
let browser;let passed=0,failed=0;
async function test(name,run) {
  if(process.env.FILTER && !name.includes(process.env.FILTER)) return;
  const context=await browser.newContext();
  const f={requests:[],finish:[]}; const path=`/asset-${++serial}`;fixtures.set(path,f);
  const entry={url:origin+path,sizeBytes:data.length,sha256:sha(data),shared:false};
  const errors=[];
  const page=async(options={})=>{const p=await context.newPage();p.on('pageerror',e=>errors.push(String(e)));await p.goto(origin);await p.waitForFunction(()=>!!window.setup);await p.evaluate(({entry,options})=>setup(entry,options),{entry,options});return p;};
  try {await run({page,f,entry});assert.deepEqual(errors,[],'unhandled page errors');console.log('PASS '+name);passed++;}
  catch(e) {console.error('FAIL '+name+'\n'+e.stack, f.requests);failed++;}
  finally {await context.close();fixtures.delete(path);}
}
const start=(p,key='a')=>p.evaluate(key=>start(key),key);
const result=async(p,key='a')=>{await p.waitForFunction(key=>results[key]!==undefined,key,{timeout:5000});return p.evaluate(key=>results[key],key);};
const partial=async p=>{for(let i=0;i<250;i++){if(await p.evaluate(async()=>(await store.stat(entry.url)).bytes===8)) return;await new Promise(r=>setTimeout(r,20));}throw Error('No durable prefix');};
const verify=async p=>assert.deepEqual(await p.evaluate(()=>read()),Array.from(data));
try {
  browser=await chromium.launch({headless:true,channel:process.env.PLAYWRIGHT_CHANNEL ?? "chrome"});
  console.log('Browser '+browser.version());
  await test('cache reuse and owned reads survive deletion',async({page,f})=>{
    const p=await page();await start(p);assert.equal(await result(p),'ready');await verify(p);
    await start(p,'b');assert.equal(await result(p,'b'),'ready');assert.equal(f.requests.length,1);
    assert.deepEqual(await p.evaluate(()=>events.b.map(e=>e.phase)),['checking','ready']);
    await p.evaluate(async()=>{window.owned=await read();await manager.deleteModelAssets('fixture');});
    assert.deepEqual(await p.evaluate(()=>owned),Array.from(data));
    assert.equal(await p.evaluate(async()=>(await store.stat(entry.url)).bytes),0);
  });
  await test('same-page sharing and caller-local abort',async({page,f})=>{
    f.hold=true;const p=await page();await start(p);await partial(p);await start(p,'b');
    await p.waitForFunction(()=>events.b.some(e=>e.phase==='downloading'));await p.evaluate(()=>controllers.a.abort());
    assert.equal(await result(p),'AbortError');f.finish.forEach(fn=>fn());assert.equal(await result(p,'b'),'ready');
    assert.equal(f.requests.length,1);await verify(p);
    assert.equal(await p.evaluate(()=>events.b.find(e=>e.phase==='downloading').totalBytes),24);
  });
  await test('cancel and resume with real Range',async({page,f})=>{
    f.hold=true;const p=await page();await start(p);await partial(p);await p.evaluate(()=>controllers.a.abort());
    assert.equal(await result(p),'AbortError');await start(p,'b');assert.equal(await result(p,'b'),'ready');
    assert.equal(f.requests[1].range,'bytes=8-');await verify(p);
  });
  await test('ignored Range restarts safely',async({page,f})=>{
    f.ignoreRange=true;const p=await page();await p.evaluate(d=>seed(d),Array.from(data.subarray(0,8)));
    await start(p);assert.equal(await result(p),'ready');assert.equal(f.requests[0].offset,8);await verify(p);
  });
  await test('cross-tab Web Locks deduplicate',async({page,f})=>{
    f.hold=true;const a=await page(),b=await page();await start(a);await partial(a);await start(b);
    await b.waitForFunction(()=>events.a.some(e=>e.phase==='downloading'));f.finish.forEach(fn=>fn());
    assert.equal(await result(a),'ready');assert.equal(await result(b),'ready');assert.equal(f.requests.length,1);await verify(b);
  });
  await test('closed owner tab leaves checkpoint for takeover',async({page,f})=>{
    f.hold=true;const a=await page(),b=await page();await start(a);await partial(a);await start(b);await a.close();
    assert.equal(await result(b),'ready');assert.equal(f.requests[1].offset,8);await verify(b);
  });
  await test('cross-tab deletion fences active and queued writers',async({page,f})=>{
    f.hold=true;const a=await page(),b=await page(),c=await page();await start(a);await partial(a);await start(b);
    await b.waitForFunction(()=>events.a.some(e=>e.phase==='downloading'));await c.evaluate(()=>manager.deleteModelAssets('fixture'));
    assert.equal(await result(a),'ModelAssetsDeletedError');assert.equal(await result(b),'ModelAssetsDeletedError');
    f.hold=false;f.finish.forEach(fn=>fn());await start(c);assert.equal(await result(c),'ready');await verify(c);
  });
  await test('without Web Locks writers cannot mix chunks',async({page,f})=>{
    f.hold=true;const a=await page({noLocks:true}),b=await page({noLocks:true});await start(a);await partial(a);
    await start(b);assert.equal(await result(b),'ready');f.finish.forEach(fn=>fn());
    assert.equal(await result(a),'AssetConflictError');await verify(b);
  });
  await test('corrupt HTTP body is rejected and discarded',async({page,f})=>{
    f.corrupt=true;const p=await page();await start(p);assert.equal(await result(p),'AssetIntegrityError');
    assert.equal(await p.evaluate(async()=>(await store.stat(entry.url)).bytes),0);
    f.corrupt=false;await start(p,'b');assert.equal(await result(p,'b'),'ready');await verify(p);
  });
  await test('broken HTTP connection retains prefix and resumes',async({page,f})=>{
    f.truncate=true;const p=await page();await start(p);assert.notEqual(await result(p),'ready');await partial(p);
    f.truncate=false;await start(p,'b');assert.equal(await result(p,'b'),'ready');assert.equal(f.requests[1].offset,8);await verify(p);
  });
  await test('malformed Content-Range does not publish',async({page,f})=>{
    f.badRange=true;const p=await page();await p.evaluate(d=>seed(d),Array.from(data.subarray(0,8)));
    await start(p);assert.equal(await result(p),'AssetIntegrityError');assert.equal(await p.evaluate(async()=>(await store.stat(entry.url)).bytes),8);
  });
  await test('quota error inside real IDB transaction rejects and preserves checkpoint',async({page,f})=>{
    f.hold=true;const p=await page();await start(p);await partial(p);
    await p.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){
      if(this.name==='chunks') throw new DOMException('Injected quota exhausted','QuotaExceededError');return put.apply(this,args);
    };window.restore=()=>IDBObjectStore.prototype.put=put;});
    f.finish.forEach(fn=>fn());assert.equal(await result(p),'QuotaExceededError');
    assert.equal(await p.evaluate(async()=>(await store.stat(entry.url)).bytes),8);
    await p.evaluate(()=>restore());await start(p,'b');assert.equal(await result(p,'b'),'ready');await verify(p);
  });
  await test('aborting a queued tab leaves the owner transfer running',async({page,f})=>{
    f.hold=true;const a=await page(),b=await page();await start(a);await partial(a);await start(b);
    await b.waitForFunction(()=>events.a.some(e=>e.phase==='downloading'));await b.evaluate(()=>controllers.a.abort());
    assert.equal(await result(b),'AbortError');f.finish.forEach(fn=>fn());
    assert.equal(await result(a),'ready');assert.equal(f.requests.length,1);await verify(a);
  });
  await test('runtime resume refuses changed ETag without a registry hash',async({page,entry})=>{
    delete entry.sha256;const p=await page();
    await p.evaluate(d=>seed(d,{validator:'"old-version"'}),Array.from(data.subarray(0,8)));
    await start(p);assert.equal(await result(p),'AssetIntegrityError');
    assert.equal(await p.evaluate(async()=>(await store.stat(entry.url)).bytes),8);
  });
  await test('transaction abort rolls back a chunk and reports storage failure',async({page,f})=>{
    f.hold=true;const p=await page();await start(p);await partial(p);
    await p.evaluate(()=>{const put=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(...args){
      const request=put.apply(this,args);
      if(this.name==='chunks') request.addEventListener('success',()=>this.transaction.abort());return request;
    };window.restore=()=>IDBObjectStore.prototype.put=put;});
    f.finish.forEach(fn=>fn());assert.equal(await result(p),'AssetStorageError');
    assert.equal(await p.evaluate(async()=>(await store.stat(entry.url)).bytes),8);
    await p.evaluate(()=>restore());await start(p,'b');assert.equal(await result(p,'b'),'ready');await verify(p);
  });
  await test('stored corruption is rejected by the owned-byte reader',async({page})=>{
    const p=await page();await start(p);assert.equal(await result(p),'ready');
    const error=await p.evaluate(async()=>{
      const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('wfloat-assets-v1',1);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
      await new Promise((resolve,reject)=>{const tx=db.transaction('chunks','readwrite');tx.objectStore('chunks').put(new Uint8Array(32),[entry.url,0]);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
      try {await read();return 'ready';}catch(e){return e.name;}
    });assert.equal(error,'AssetIntegrityError');
  });
  await test('12 cancel/resume/delete cycles do not leak stale writers',async({page,f})=>{
    f.hold=true;const p=await page();
    for(let i=0;i<12;i++) {
      await start(p,'cancel'+i);await partial(p);await p.evaluate(key=>controllers[key].abort(),'cancel'+i);
      assert.equal(await result(p,'cancel'+i),'AbortError');await start(p,'resume'+i);
      assert.equal(await result(p,'resume'+i),'ready');await verify(p);
      await p.evaluate(()=>manager.deleteModelAssets('fixture'));
      assert.equal(await p.evaluate(async()=>(await store.stat(entry.url)).bytes),0);
    }
    assert.equal(f.requests.length,24);assert.ok(f.requests.filter((_,i)=>i%2).every(r=>r.offset===8));
  });
  await test('abort from the first download notification has no unhandled rejection',async({page,f})=>{
    const p=await page({abortOnDownload:true});await start(p);assert.equal(await result(p),'AbortError');
    await p.evaluate(()=>new Promise(r=>setTimeout(r,30)));assert.equal(f.requests.length,0);
  });
  await test('deletion rejects even when persistence remains unresolved',async({page,f})=>{
    const a=await page({holdPersistence:true}),b=await page();await start(a);
    await a.waitForFunction(()=>window.persistenceEntered);await b.evaluate(()=>manager.deleteModelAssets('fixture'));
    assert.equal(await result(a),'ModelAssetsDeletedError');assert.equal(f.requests.length,0);
    await a.evaluate(()=>resumePersistence());
  });
  await test('permission-wait joiner uses current cache and skips a finished transfer',async({page,f})=>{
    const a=await page({holdPersistence:true}),b=await page();await start(a);await a.waitForFunction(()=>window.persistenceEntered);
    await start(b);assert.equal(await result(b),'ready');await a.evaluate(()=>resumePersistence());
    assert.equal(await result(a),'ready');assert.equal(f.requests.length,1);
    assert.deepEqual(await a.evaluate(()=>events.a.map(e=>e.phase)),['checking','ready']);
  });
  await test('deletion during pending persistence cannot resurrect model',async({page,f})=>{
    const a=await page({holdPersistence:true}),b=await page();await start(a);
    await a.waitForFunction(()=>window.persistenceEntered);await b.evaluate(()=>manager.deleteModelAssets('fixture'));
    await a.evaluate(()=>resumePersistence());assert.equal(await result(a),'ModelAssetsDeletedError');assert.equal(f.requests.length,0);
  });
  await test('incompatible cache replacement has bounded byte progress',async({page})=>{
    const p=await page();await p.evaluate(()=>seed(Array(64).fill(1),{sha256:'old',sizeBytes:64,complete:true}));
    await start(p);assert.equal(await result(p),'ready');await verify(p);
    const events=await p.evaluate(()=>window.events.a.filter(e=>e.phase==='downloading'));
    assert.ok(events.every(e=>e.downloadedBytes<=e.totalBytes),JSON.stringify(events));
  });
} finally {await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
console.log(`${passed} passed, ${failed} failed`);process.exitCode=failed?1:0;
