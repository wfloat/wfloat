import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import React from 'react';
import {create,act} from 'react-test-renderer';
import {transformSync} from '@babel/core';
const require=createRequire(import.meta.url), root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const compiled=new Map();
function harness() {
  const cache=new Map(), listeners=new Set(), requests=[]; let tick;
  const appState={currentState:'active',addEventListener:(_,fn)=>{listeners.add(fn);return {remove:()=>listeners.delete(fn)};}};
  const rn={AppState:appState,Platform:{OS:'ios'},Text:'Text',View:'View',Pressable:'Pressable',StyleSheet:{create:x=>x},
    NativeModules:{BenchMemory:{read:()=>new Promise((resolve,reject)=>requests.push({resolve,reject})),release:()=>Promise.resolve()}}};
  function load(file) {
    if (cache.has(file)) return cache.get(file).exports;
    const module={exports:{}};cache.set(file,module);
    if (!compiled.has(file)) compiled.set(file,transformSync(readFileSync(file,'utf8'),{filename:file,babelrc:false,configFile:false,
      presets:[require.resolve('@react-native/babel-preset')]}).code);
    const localRequire=name=>{
      if(name==='react-native')return rn;
      if(name==='./useMetricState')return {useMetricState:(_key,initial)=>React.useState(initial)};
      if(!name.startsWith('.'))return require(name);
      const base=resolve(dirname(file),name),target=[base,`${base}.ts`,`${base}.tsx`].find(existsSync);
      assert(target);return load(target);
    };
    new Function('require','module','exports','setInterval','clearInterval','__DEV__',compiled.get(file))(
      localRequire,module,module.exports,fn=>{tick=fn;return 1;},()=>{},false);
    return module.exports;
  }
  return {component:load(resolve(root,'src/MemoryUsageCard.tsx')).MemoryUsageCard,requests,
    tick:()=>tick(),change:state=>{appState.currentState=state;for(const fn of listeners)fn(state);},listeners};
}
const row=(total,sequence)=>({platform:'ios',osVersion:'18.0',processId:123,sequence,
  sampledAtMs:1800000000000+sequence*2000,clockSource:'NSProcessInfo.systemUptime',
  monotonicMs:sequence*2000+1,queryStartedUptimeMs:sequence*2000,queryFinishedUptimeMs:sequence*2000+2,readDurationMs:2,
  source:'task_info(MACH_TASK_BASIC_INFO).resident_size',rssBytes:16384,heldBytes:0,
  cumulativeCompressed:{bytes:total,rawBytes:String(total),source:'task_info(TASK_VM_INFO).compressed_lifetime',scope:'process_lifetime',
    unit:'bytes',accounting:'internal_compressed_ledger_credit_bytes',environment:'simulator',error:null}});
const value=tree=>tree.root.findByProps({testID:'process-compression-rate'}).props.children;
test('actual memory card derives rates and discards intervals across resume and native failures',async()=>{
  const h=harness();let tree;
  await act(async()=>{tree=create(React.createElement(h.component,{workloadRunning:false}));});
  const respond=async sample=>{assert(h.requests.length);await act(async()=>h.requests.shift().resolve(sample));};
  try{
    await respond(row(0,1));assert.equal(value(tree),'Measuring…');
    await act(async()=>h.tick());await respond(row(40*1048576,2));assert.equal(value(tree),'20.00 MiB/s');
    assert.match(tree.root.findByProps({testID:'process-compression-window'}).props.children,/samples 1–2/);
    await act(async()=>h.change('background'));assert.equal(value(tree),'Paused');
    await act(async()=>h.change('active'));await respond(row(100*1048576,3));assert.equal(value(tree),'Measuring…');
    await act(async()=>h.tick());await respond(row(102*1048576,4));assert.equal(value(tree),'1.00 MiB/s');
    await act(async()=>h.tick());await act(async()=>h.requests.shift().reject(new Error('native read failed')));
    assert.equal(value(tree),'Unavailable');
    await act(async()=>h.tick());await respond(row(120*1048576,6));assert.equal(value(tree),'Measuring…');
    await act(async()=>h.tick());await respond(row(120*1048576,7));assert.equal(value(tree),'0.00 MiB/s');
    await act(async()=>h.tick());await respond(row(120*1048576+1,8));assert.equal(value(tree),'<0.01 MiB/s');
  }finally{await act(async()=>tree.unmount());}
  assert.equal(h.listeners.size,0);
});
test('late pre-background native response cannot create a rate after resuming',async()=>{
  const h=harness();let tree;
  await act(async()=>{tree=create(React.createElement(h.component,{workloadRunning:false}));});
  try{
    await act(async()=>h.requests.shift().resolve(row(0,1)));
    await act(async()=>h.tick());const old=h.requests.shift();
    await act(async()=>h.change('background'));await act(async()=>h.change('active'));
    await act(async()=>old.resolve(row(1048576,2)));
    assert.equal(value(tree),'Measuring…');assert.equal(h.requests.length,0);
    // Resume reuses the pending read; after its stale result is discarded,
    // the existing poll loop requests the fresh baseline.
    await act(async()=>h.tick());assert.equal(h.requests.length,1);
    await act(async()=>h.requests.shift().resolve(row(100*1048576,3)));
    assert.equal(value(tree),'Measuring…');
    await act(async()=>h.tick());await act(async()=>h.requests.shift().resolve(row(102*1048576,4)));
    assert.equal(value(tree),'1.00 MiB/s');
  }finally{await act(async()=>tree.unmount());}
});
