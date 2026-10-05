import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import test from 'node:test';
const require=createRequire(new URL('../../../../../wfloat-web/package.json',import.meta.url));
const {build}=require('esbuild');
// Exercise real manifest, acquisition and extraction dispatch together. Only the
// platform storage boundary is mocked; archive paths are deliberately not dirs.
const result=await build({entryPoints:[new URL('../index.ts',import.meta.url).pathname],bundle:true,write:false,format:'esm',platform:'node',plugins:[{name:'fixture',setup(b){
  b.onResolve({filter:/generatedModelUrls$/},()=>({path:'registry',namespace:'fixture'}));
  b.onResolve({filter:/platform\/bridge$/},()=>({path:'bridge',namespace:'fixture'}));
  b.onResolve({filter:/^react-native$/},()=>({path:'rn',namespace:'fixture'}));
  b.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({contents:path==='registry'?`export const MODEL_ASSETS=globalThis.__ttsExtraction.registry;export const REGISTRY_ORIGIN='https://fixture.invalid';export const SHARED_ASSETS=globalThis.__ttsExtraction.shared;`:path==='rn'?`export const Platform={get OS(){return globalThis.__ttsExtraction.os;}};`:
    `export const request=(c,o)=>globalThis.__ttsExtraction.request(c,o);export function checkAbort(s){if(s?.aborted)throw s.reason;}export const notify=(fn,e)=>fn?.(e);`}));
}}]});
const file=path=>({path,sha256:'a'.repeat(64),sizeBytes:2});
const registry=Object.fromEntries(['wfloat','piper','kokoro','kitten','pocket'].map(family=>[family,{family,model_onnx:file('/'+family+'.onnx')}]));
Object.assign(registry.kokoro,Object.fromEntries(['model_tokens','model_voices','lexicon_zh','rule_date_zh','rule_number_zh','rule_phone_zh'].map(k=>[k,file('/kokoro/fp32/'+k)])));
registry.kokoro.model_onnx=file('/kokoro/fp32/model.onnx');
registry.piper.model_config=file('/piper/model.onnx.json');
const shared={espeak_ng_data_zip:file('/espeak.zip'),espeak_ng_data_aar:file('/espeak.aar')};
globalThis.__ttsExtraction={registry,shared};
const assets=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text+'\n//# sourceURL=tts-extraction.mjs').toString('base64'));
for(const os of ['ios','android'])test(os+' extracts eSpeak for all dependent families before handing paths to native',async()=>{
  for(const family of Object.keys(registry)){
    const calls=[];Object.assign(globalThis.__ttsExtraction,{os,request:async c=>{
      calls.push(c);
      if(c.op==='assetStat')return {path:'/cache/'+c.key+'.archive',sizeBytes:c.sizeBytes};
      if(c.op==='prepareEspeak')return {path:'/cache/extracted/espeak-ng-data'};
      throw Error('Unexpected '+c.op);
    }});
    const lease=await assets.loadAssets(family,'tts');
    const prepared=calls.filter(c=>c.op==='prepareEspeak');
    if(family==='pocket'){assert.equal(prepared.length,0);assert.equal(lease.paths.espeak_data,undefined);}
    else{
      assert.equal(prepared.length,1);assert.equal(prepared[0].format,os==='ios'?'aar':'zip');
      const sharedAsset=assets.modelManifest(family).assets.find(a=>a.name==='espeak_data');
      assert.equal(prepared[0].key,sharedAsset.key);assert.equal(prepared[0].path,'/cache/'+sharedAsset.key+'.archive');
      assert.equal(lease.paths.espeak_data,'/cache/extracted/espeak-ng-data');
      assert.ok(calls.findIndex(c=>c.op==='prepareEspeak')>calls.findIndex(c=>c.key===sharedAsset.key));
    }
    lease.release();
  }
});
test('extraction failure cannot return an archive as native data_dir',async()=>{
  Object.assign(globalThis.__ttsExtraction,{os:'android',request:async c=>{if(c.op==='prepareEspeak')throw Error('extraction failed');return {path:'/cache/archive',sizeBytes:c.sizeBytes};}});
  await assert.rejects(assets.loadAssets('piper','tts'),/extraction failed/);
});

test('cached Kokoro reload retains every model/voice/lexicon/FST path and reuses shared extraction identity',async()=>{
  for(const os of ['ios','android']){
    const calls=[];Object.assign(globalThis.__ttsExtraction,{os,request:async c=>{
      calls.push(c);
      if(c.op==='assetStat')return {path:'/verified/'+c.key,sizeBytes:c.sizeBytes};
      if(c.op==='prepareEspeak')return {path:'/extracted/'+c.key+'/espeak-ng-data'};
      throw Error('Cached load attempted '+c.op);
    }});
    let prior;
    for(let pass=0;pass<2;pass++){
      const lease=await assets.loadAssets('kokoro','tts');
      try{
        if(prior)assert.deepEqual(lease.paths,prior);
        for(const a of assets.modelManifest('kokoro').assets)assert.equal(lease.paths[a.name],a.shared?'/extracted/'+a.key+'/espeak-ng-data':'/verified/'+a.key);
        prior={...lease.paths};
      }finally{lease.release();}
    }
    const prepared=calls.filter(c=>c.op==='prepareEspeak');assert.equal(prepared.length,2);assert.equal(prepared[0].key,prepared[1].key);
    for(const c of calls.filter(c=>c.op==='assetStat')){assert.equal(c.sha256,'a'.repeat(64));assert.equal(c.sizeBytes,2);}
  }
});
