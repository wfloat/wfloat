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
function harness(platform='android') {
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
function sample(states=['R','S'],sequence=1) {
 const t=sequence*2000;
 return {platform:'android',source:'/proc/self/task/*/stat:utime,stime,starttime',
  clockSource:'SystemClock.elapsedRealtimeNanos',counterUnit:'clock_ticks',counterUnitsPerSecond:100,
  runStateSource:'/proc/self/task/*/stat:state',processId:123,sequence,osVersion:'16',apiLevel:36,
  sampledAtMs:1800000000000+t,queryStartedUptimeMs:t,queryFinishedUptimeMs:t+20,enumeratedThreadCount:states.length,
  threads:states.map((runState,i)=>({threadId:String(i+1),startTimeTicks:'100',name:'worker',userTime:sequence*100,systemTime:10,
   queryStartedUptimeMs:t+i,queryFinishedUptimeMs:t+i+.5,runState})),errors:[]};
}
const summarize=harness().load('threadStates.ts').summarizeAndroidThreadStates;
test('Linux states preserve case and retain unknowns separately from unreadable threads',()=>{
 const r=summarize(sample(['R','R','S','D','T','t','X','Z','P','I','?','?','x']));
 assert.deepEqual(r.counts,{running:2,sleeping:1,uninterruptible:1,stopped:1,tracing:1,dead:1,zombie:1,parked:1,idle:1,unknown:3});
 assert.deepEqual(r.unknownCodes,{'?':2,x:1});assert.equal(r.observed,13);assert.equal(r.complete,true);
 assert.equal(r.unit,'threads');assert.equal(r.scanMs,20);
});
test('partial and all-unreadable scans preserve accounting, and missing rows fail',()=>{
 const s=sample(['?']);s.errors=[{threadId:'2',reason:'read_failed:IOException'}];s.enumeratedThreadCount=2;
 const r=summarize(s);assert.equal(r.unreadable,1);assert.equal(r.counts.unknown,1);assert.equal(r.complete,false);
 s.threads=[];s.enumeratedThreadCount=1;const all=summarize(s);assert.equal(all.observed,0);assert.equal(all.unreadable,1);
 assert.equal(Object.values(all.counts).reduce((a,b)=>a+b,0),0);assert.throws(()=>summarize({...s,enumeratedThreadCount:2}));
});
test('malformed or old state records cannot fabricate counts or break usable CPU counters',()=>{
 const validate=harness().load('threadCpu.ts').validateThreadCpuSample;
 for(const runState of [undefined,null,1,'','RR',' ','é','\n','\u007f']) {
  const s=sample([runState]);assert.throws(()=>summarize(s));assert.equal(validate(s).threads.length,1);
 }
 for(const runStateSource of [undefined,'thread_info(THREAD_BASIC_INFO).run_state','wrong'])assert.throws(()=>summarize({...sample(),runStateSource}));
 const old=sample();delete old.runStateSource;old.threads.forEach(t=>delete t.runState);
 assert.equal(validate(old).threads.length,2);assert.throws(()=>summarize(old));
 const ios={...sample(),platform:'ios',source:'thread_info(THREAD_BASIC_INFO,THREAD_IDENTIFIER_INFO)',clockSource:'NSProcessInfo.systemUptime',counterUnit:'microseconds',counterUnitsPerSecond:1000000};
 ios.threads.forEach(t=>t.startTimeTicks=null);assert.throws(()=>summarize(ios));
});
const value=(tree,state)=>tree.root.findByProps({testID:`android-thread-state-${state}`}).props.children;
test('actual Android CPU card shares its read, clears stale values and shows partial/error states',async()=>{
 const h=harness();const Card=h.load('ThreadCpuCard.tsx').ThreadCpuCard;let tree;
 await act(async()=>{tree=create(React.createElement(Card));});
 const respond=async s=>{assert(h.requests.length);await act(async()=>h.requests.shift().resolve(s));};
 try {
  assert.equal(h.requests.length,1);assert.equal(value(tree,'running'),'—');
  await respond(sample(['R','S','S']));assert.equal(value(tree,'running'),1);assert.equal(value(tree,'sleeping'),2);assert.equal(value(tree,'zombie'),0);
  assert.equal(tree.root.findAllByProps({testID:'thread-state-running'}).length,0);
  await act(async()=>h.tick());const old=h.requests.shift();
  await act(async()=>h.change('background'));assert.equal(value(tree,'running'),'—');assert.equal(value(tree,'status'),'Paused');
  await act(async()=>h.change('active'));await act(async()=>old.resolve(sample(['R','R'],2)));
  assert.equal(value(tree,'running'),'—');assert.equal(h.requests.length,0);
  await act(async()=>h.tick());await respond(sample(['S'],3));assert.equal(value(tree,'running'),0);
  await act(async()=>h.tick());await act(async()=>h.requests.shift().reject(new Error('read failed')));
  assert.equal(value(tree,'sleeping'),'—');assert.match(value(tree,'status'),/read failed/);
  await act(async()=>h.tick());const partial=sample(['?'],5);partial.errors=[{threadId:'2',reason:'gone'}];partial.enumeratedThreadCount=2;
  await respond(partial);assert.equal(value(tree,'unknown'),1);assert.match(value(tree,'status'),/1 unreadable.*Partial/);
  assert.match(JSON.stringify(tree.root.findByProps({testID:'android-thread-state-unknown-codes'}).props.children),/\?/);
  await act(async()=>h.tick());await respond(sample([undefined],6));assert.equal(value(tree,'unknown'),'—');
  assert(tree.root.findByProps({testID:'thread-cpu-usage-0'}));
 } finally {await act(async()=>tree.unmount());}
 assert.equal(h.listeners.size,0);
});
