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
function harness(platform='ios') {
  const cache=new Map(),listeners=new Set(),requests=[];let tick;
  const appState={currentState:'active',addEventListener:(_,fn)=>{listeners.add(fn);return {remove:()=>listeners.delete(fn)};}};
  const rn={AppState:appState,Platform:{OS:platform},Text:'Text',View:'View',StyleSheet:{create:x=>x},
    NativeModules:{BenchThreads:{read:()=>new Promise(()=>{}),readCpu:()=>new Promise((resolve,reject)=>requests.push({resolve,reject}))}}};
  function load(file) {
    if(cache.has(file))return cache.get(file).exports;
    const module={exports:{}};cache.set(file,module);
    if(!compiled.has(file))compiled.set(file,transformSync(readFileSync(file,'utf8'),{filename:file,babelrc:false,configFile:false,presets:[require.resolve('@react-native/babel-preset')]}).code);
    const localRequire=name=>{
      if(name==='react-native')return rn;
      if(name==='./useMetricState')return {useMetricState:(_key,initial)=>React.useState(initial)};
      if(!name.startsWith('.'))return require(name);
      const base=resolve(dirname(file),name),target=[base,`${base}.ts`,`${base}.tsx`].find(existsSync);assert(target);return load(target);
    };
    new Function('require','module','exports','setTimeout','clearTimeout',compiled.get(file))(localRequire,module,module.exports,fn=>{tick=fn;return 1;},()=>{tick=undefined;});
    if (/\/(ThreadCpuCard|ThreadCountCard)\.tsx$/.test(file)) {
      const name = file.endsWith('ThreadCpuCard.tsx') ? 'ThreadCpuCard' : 'ThreadCountCard';
      const Component = module.exports[name];
      module.exports[name] = function SourceOwnedCard(props) {
        load(resolve(root, 'src/threadSources.ts')).useThreadSources(true);
        return React.createElement(Component, props);
      };
    }
    return module.exports;
  }
  return {load:name=>load(resolve(root,'src',name)),requests,tick:()=>{assert(tick);const fn=tick;tick=undefined;fn();},
    change:state=>{appState.currentState=state;for(const fn of listeners)fn(state);},listeners};
}
export function sample(states=[1,3],sequence=1) {
 const t=sequence*2000;
 return {platform:'ios',source:'thread_info(THREAD_BASIC_INFO,THREAD_IDENTIFIER_INFO)',
  clockSource:'NSProcessInfo.systemUptime',counterUnit:'microseconds',counterUnitsPerSecond:1000000,
  runStateSource:'thread_info(THREAD_BASIC_INFO).run_state',runStateEnvironment:'simulator',
  processId:123,sequence,osVersion:'18.0',sampledAtMs:1800000000000+t,
  queryStartedUptimeMs:t,queryFinishedUptimeMs:t+20,enumeratedThreadCount:states.length,
  threads:states.map((runState,i)=>({threadId:String(i+1),startTimeTicks:null,name:null,userTime:sequence*1000,systemTime:100,
   queryStartedUptimeMs:t+i,queryFinishedUptimeMs:t+i+.5,runState})),errors:[]};
}
const summarize=harness().load('threadStates.ts').summarizeIosThreadStates;
test('Mach enum mapping keeps unknown raw states and counts every readable thread once',()=>{
 const r=summarize(sample([1,1,2,3,4,5,0,-1,42,42]));
 assert.deepEqual(r.counts,{running:2,waiting:1,stopped:1,uninterruptible:1,halted:1,unknown:4});
 assert.deepEqual(r.unknownCodes,{'0':1,'-1':1,'42':2});assert.equal(r.observed,10);assert.equal(r.complete,true);
 assert.equal(r.unit,'threads');assert.equal(r.scanMs,20);
});
test('unreadable threads are separate from unknown states, including all-unreadable scans',()=>{
 const s=sample([0]);s.errors=[{threadId:null,reason:'THREAD_BASIC_INFO failed'}];s.enumeratedThreadCount=2;
 const r=summarize(s);assert.equal(r.unreadable,1);assert.equal(r.counts.unknown,1);assert.equal(r.complete,false);
 s.threads=[];s.enumeratedThreadCount=1;const all=summarize(s);assert.equal(all.observed,0);assert.equal(all.unreadable,1);
 assert.equal(Object.values(all.counts).reduce((a,b)=>a+b,0),0);
 assert.throws(()=>summarize({...s,enumeratedThreadCount:2}));
});
test('missing/malformed state metadata fails while historical CPU samples remain valid',()=>{
 const validate=harness().load('threadCpu.ts').validateThreadCpuSample;
 for(const patch of [{runStateSource:undefined},{runStateEnvironment:'unknown'},{runStateSource:'invented'}])assert.throws(()=>summarize({...sample(),...patch}));
 for(const runState of [undefined,null,NaN,1.5,'1',2147483648,-2147483649]) {
  const s=sample([runState]);assert.throws(()=>summarize(s));assert.equal(validate(s).threads.length,1);
 }
 const old=sample();delete old.runStateSource;delete old.runStateEnvironment;old.threads.forEach(t=>delete t.runState);
 assert.equal(validate(old).threads.length,2);assert.throws(()=>summarize(old));
 const android={...sample(),platform:'android',source:'/proc/self/task/*/stat:utime,stime,starttime',clockSource:'SystemClock.elapsedRealtimeNanos',counterUnit:'clock_ticks',counterUnitsPerSecond:100};
 android.threads.forEach(t=>t.startTimeTicks='100');assert.throws(()=>summarize(android));
});
const value=(tree,state)=>tree.root.findByProps({testID:`thread-state-${state}`}).props.children;
test('actual CPU card shares one sample, hides stale counts and recovers after errors',async()=>{
 const h=harness();const Card=h.load('ThreadCpuCard.tsx').ThreadCpuCard;let tree;
 await act(async()=>{tree=create(React.createElement(Card));});
 const respond=async s=>{assert(h.requests.length);await act(async()=>h.requests.shift().resolve(s));};
 try {
  assert.equal(h.requests.length,1);assert.equal(value(tree,'running'),'—');
  await respond(sample([1,3,3]));assert.equal(value(tree,'running'),1);assert.equal(value(tree,'waiting'),2);assert.equal(value(tree,'halted'),0);
  await act(async()=>h.tick());const old=h.requests.shift();
  await act(async()=>h.change('background'));assert.equal(value(tree,'running'),'—');assert.equal(value(tree,'status'),'Paused');
  await act(async()=>h.change('active'));await act(async()=>old.resolve(sample([1,1],2)));
  assert.equal(value(tree,'running'),'—');assert.equal(h.requests.length,0);
  await act(async()=>h.tick());await respond(sample([3],3));assert.equal(value(tree,'running'),0);
  await act(async()=>h.tick());await act(async()=>h.requests.shift().reject(new Error('read failed')));
  assert.equal(value(tree,'waiting'),'—');assert.match(value(tree,'status'),/read failed/);
  await act(async()=>h.tick());await respond(sample([42],5));assert.equal(value(tree,'unknown'),1);
  assert.match(JSON.stringify(tree.root.findByProps({testID:'thread-state-unknown-codes'}).props.children),/42/);
  await act(async()=>h.tick());await respond(sample([undefined],6));assert.equal(value(tree,'unknown'),'—');
  assert(tree.root.findByProps({testID:'thread-cpu-status'}));
 } finally {await act(async()=>tree.unmount());}
 assert.equal(h.listeners.size,0);
});
test('Android CPU card does not render iOS state rows',async()=>{
 const h=harness('android');let tree;
 await act(async()=>{tree=create(React.createElement(h.load('ThreadCpuCard.tsx').ThreadCpuCard));});
 assert.equal(tree.root.findAllByProps({testID:'thread-state-running'}).length,0);
 await act(async()=>tree.unmount());
});
