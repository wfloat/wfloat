import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
const require = createRequire(new URL('../../../../../wfloat-web/package.json', import.meta.url));
const {build} = require('esbuild');
const id = 'nvidia/parakeet-tdt-0.6b-v3';
const hash = 'a'.repeat(64);
const file = path => ({path, sha256: hash, sizeBytes: 2});
const registry = {[id]: {family: 'parakeet-tdt', encoder: {parts: [file('/p1'), file('/p2')], sha256: hash, sizeBytes: 4, filename: 'encoder.int8.onnx'}, decoder: file('/decoder'), joiner: file('/joiner'), tokens: file('/tokens')}};
globalThis.__parakeetRegistry = registry;
let calls = [], respond;
globalThis.__parakeetRequest = (command, options) => {calls.push(command); return respond(command, options);};
const result = await build({entryPoints:[new URL('../index.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'fixtures',setup(b){
  b.onResolve({filter:/generatedModelUrls$/},()=>({path:'registry',namespace:'fixture'}));
  b.onResolve({filter:/platform\/bridge$/},()=>({path:'bridge',namespace:'fixture'}));
  b.onResolve({filter:/^react-native$/},()=>({path:'rn',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path==='registry'?`export const MODEL_ASSETS=globalThis.__parakeetRegistry; export const REGISTRY_ORIGIN='https://test'; export const SHARED_ASSETS={};`:path==='rn'?`export const Platform={OS:'ios'};`:`export const request=(...args)=>globalThis.__parakeetRequest(...args); export function checkAbort(s){if(s?.aborted)throw s.reason??Error('aborted');} export const notify=(fn,e)=>fn?.(e);`}));
}}]});
const assets = await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
const tick = async () => { for(let i=0;i<30;i++)await Promise.resolve(); };
test('all parts precede native assembly; returned paths remain ordinary',async()=>{
  calls=[]; respond=async c=>c.op==='assetStat'?null:{path:`/${c.key}`};
  const lease=await assets.loadAssets(id,'stt'); lease.release();
  assert.deepEqual(Object.keys(lease.paths),['encoder','decoder','joiner','tokens']);
  const i=calls.findIndex(c=>c.op==='assetAssemble'); assert.equal(i,8);
  assert.deepEqual(calls.slice(6,i).map(c=>c.url),['https://test/p1','https://test/p2']);
  assert.equal(calls[i].parts.length,2); assert.equal(calls[i].url,undefined); assert.equal(calls[i].sizeBytes,4);
});
test('verified whole cache bypasses part downloads and assembly',async()=>{
  calls=[]; respond=async c=>({path:`/${c.key}`,sizeBytes:c.sizeBytes});
  await assets.downloadModel(id);
  assert.equal(calls.length,4); assert.ok(calls.every(c=>c.op==='assetStat'));
});
test('delete cancels and waits for native assembly then removes whole plus parts',async()=>{
  calls=[]; let finish, nativeSignal;
  respond=(c,o)=>{
    if(c.op==='assetStat')return Promise.resolve(null);
    if(c.op==='assetAssemble'){nativeSignal=o.signal; return new Promise(resolve=>{finish=resolve;});}
    return Promise.resolve({path:`/${c.key}`});
  };
  const pending=assets.downloadModel(id); const rejected=assert.rejects(pending);
  await tick(); assert.ok(finish);
  const deleting=assets.deleteModelAssets(id); await tick();
  assert.equal(nativeSignal.aborted,true); assert.equal(calls.filter(c=>c.op==='assetDelete').length,0);
  finish({path:'/encoder'}); await rejected; await deleting;
  const removed=calls.filter(c=>c.op==='assetDelete').map(c=>c.key);
  assert.equal(removed.length,6); assert.equal(new Set(removed).size,6);
});
test('assembly failure never emits ready',async()=>{
  calls=[]; const phases=[];
  respond=async c=>{if(c.op==='assetStat')return null;if(c.op==='assetAssemble')throw Error('integrity');return {path:`/${c.key}`};};
  await assert.rejects(assets.downloadModel(id,{onProgress:e=>phases.push(e.phase)}),/integrity/);
  assert.ok(!phases.includes('ready'));
});
const capBuild=await build({entryPoints:[new URL('../../stt-next/capabilities.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node'});
const caps=await import('data:text/javascript;base64,'+Buffer.from(capBuild.outputFiles[0].text).toString('base64'));
test('Parakeet accepts automatic transcription and rejects forced language/translation/hotwords',()=>{
  assert.equal(caps.sttCapabilities(id).kind,'offline');
  caps.validateRecognitionOptions(id,{}); caps.validateRecognitionOptions(id,{task:'transcribe'});
  for(const options of [{language:'en'},{task:'translate'},{hotwords:[]}])assert.throws(()=>caps.validateRecognitionOptions(id,options));
});

test('cancelling one caller preserves the shared assembly for another',async()=>{
  calls=[]; let finish, nativeSignal;
  respond=(c,o)=>{
    if(c.op==='assetStat')return Promise.resolve(null);
    if(c.op==='assetAssemble'){nativeSignal=o.signal;return new Promise(resolve=>{finish=resolve;});}
    return Promise.resolve({path:`/${c.key}`});
  };
  const controller=new AbortController();
  const first=assets.downloadModel(id,{signal:controller.signal}); const rejected=assert.rejects(first);
  const second=assets.downloadModel(id);
  await tick(); assert.ok(finish);
  controller.abort(); await tick(); assert.equal(nativeSignal.aborted,false);
  finish({path:'/encoder'}); await rejected; await second;
  assert.equal(calls.filter(c=>c.op==='assetAssemble').length,1);
});

test('cached first part contributes initial bytes and whole-size total',async()=>{
  calls=[]; const events=[];
  const manifest=assets.modelManifest(id), encoder=manifest.assets[0];
  respond=async(c,o)=>{
    if(c.op==='assetStat')return c.key===encoder.key || c.key===encoder.parts[1].key ? null : {path:`/${c.key}`,sizeBytes:c.sizeBytes};
    if(c.op==='assetDownload')o.onEvent({type:'download',downloadedBytes:c.sizeBytes});
    return {path:`/${c.key}`};
  };
  await assets.downloadModel(id,{onProgress:e=>events.push(e)});
  const first=events.find(e=>e.phase==='downloading');
  assert.equal(first.downloadedBytes,8); assert.equal(first.totalBytes,10); assert.equal(first.progress,.8);
  assert.deepEqual(calls.filter(c=>c.op==='assetDownload').map(c=>c.url),['https://test/p2']);
});
test('assembly-only work never emits downloading or invokes assetDownload',async()=>{
  calls=[]; const events=[], encoder=assets.modelManifest(id).assets[0];
  respond=async c=>c.op==='assetStat' ? (c.key===encoder.key?null:{path:`/${c.key}`,sizeBytes:c.sizeBytes}):{path:`/${c.key}`};
  await assets.downloadModel(id,{onProgress:e=>events.push(e.phase)});
  assert.deepEqual(events,['checking','ready']);
  assert.ok(calls.some(c=>c.op==='assetAssemble')); assert.ok(!calls.some(c=>c.op==='assetDownload'));
});
test('composites accept safe generic filenames but reject traversal, duplicate paths and missing whole hash',()=>{
  const original=registry[id].encoder;
  try {
    for(const filename of ['model.onnx','weights-0001.ort']) {registry[id].encoder={...original,filename};assets.modelManifest(id);}
    for(const filename of ['../encoder','a/b','a\\b','.','..','']) {
      registry[id].encoder={...original,filename}; assert.throws(()=>assets.modelManifest(id),/Invalid composite/);
    }
    registry[id].encoder={...original,parts:[original.parts[0],original.parts[0]]};
    assert.throws(()=>assets.modelManifest(id),/Invalid composite/);
    registry[id].encoder={...original,sha256:undefined}; assert.throws(()=>assets.modelManifest(id),/Invalid composite/);
  } finally { registry[id].encoder=original; }
});
