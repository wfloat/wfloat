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
  prioritySource:'/proc/self/task/*/stat:priority,nice',priorityUnit:'kernel_priority',niceUnit:'linux_nice',runStateSource:'/proc/self/task/*/stat:state',processId:123,sequence,osVersion:'16',apiLevel:36,
  sampledAtMs:1800000000000+t,queryStartedUptimeMs:t,queryFinishedUptimeMs:t+20,enumeratedThreadCount:states.length,
  threads:states.map((runState,i)=>({threadId:String(i+1),startTimeTicks:'100',name:'worker',userTime:sequence*100,systemTime:10,
   queryStartedUptimeMs:t+i,queryFinishedUptimeMs:t+i+.5,runState,priority:20,nice:0})),errors:[]};
}
const validate=harness().load('threadPriority.ts').validateAndroidThreadPriorities;
test('priority and nice retain signed values independently, including deadline and inherited cases',()=>{
 for(const [priority,nice] of [[20,0],[30,10],[39,19],[0,-20],[-100,0],[-101,0],[12,5],[-2147483648,0],[2147483647,0]]) {
  const s=sample();Object.assign(s.threads[0],{priority,nice});const r=validate(s);
  assert.equal(r.threads[0].priority,priority);assert.equal(r.threads[0].nice,nice);assert.equal(r.observed,2);
 }
});
test('invalid or historical priority data leaves CPU readings usable',()=>{
 const cpu=harness().load('threadCpu.ts').validateThreadCpuSample;
 for(const patch of [{priority:undefined},{nice:undefined},{priority:1.5},{priority:'20'},{priority:2147483648},{priority:-2147483649},{nice:-21},{nice:20},{nice:NaN},{nice:null}]) {
  const s=sample();Object.assign(s.threads[0],patch);assert.throws(()=>validate(s));assert.equal(cpu(s).threads.length,2);
 }
 for(const patch of [{prioritySource:undefined},{prioritySource:'wrong'},{priorityUnit:'nice'},{niceUnit:'kernel_priority'}])assert.throws(()=>validate({...sample(),...patch}));
 const old=sample();delete old.prioritySource;old.threads.forEach(t=>{delete t.priority;delete t.nice;});assert.equal(cpu(old).threads.length,2);assert.throws(()=>validate(old));
});
test('priority snapshots account for partial and all-unreadable scans',()=>{
 const s=sample(['R']);s.errors=[{threadId:'2',reason:'gone'}];s.enumeratedThreadCount=2;
 assert.equal(validate(s).unreadable,1);s.threads=[];s.enumeratedThreadCount=1;assert.equal(validate(s).observed,0);
 assert.throws(()=>validate({...s,enumeratedThreadCount:2}));
});
const value=(tree,index=0)=>tree.root.findByProps({testID:`thread-priority-${index}`}).props.children;
test('actual CPU card attaches priorities to the correct ranked identity and refreshes across lifecycle',async()=>{
 const h=harness();let tree;await act(async()=>{tree=create(React.createElement(h.load('ThreadCpuCard.tsx').ThreadCpuCard));});
 const respond=async s=>{assert(h.requests.length);await act(async()=>h.requests.shift().resolve(s));};
 try {
  const s=sample();s.threads[1].nice=10;s.threads[1].priority=30;await respond(s);
  assert.equal(value(tree),'Kernel priority 20 · Nice 0');
  await act(async()=>h.tick());const next=sample(['R','S'],2);Object.assign(next.threads[1],{userTime:500,nice:19,priority:39});await respond(next);
  assert.equal(value(tree),'Kernel priority 39 · Nice 19');assert.equal(value(tree,1),'Kernel priority 20 · Nice 0');
  await act(async()=>h.tick());const old=h.requests.shift();await act(async()=>h.change('background'));
  assert.equal(tree.root.findAllByProps({testID:'thread-priority-0'}).length,0);
  await act(async()=>h.change('active'));await act(async()=>old.resolve(sample(['R'],3)));
  assert.equal(tree.root.findAllByProps({testID:'thread-priority-0'}).length,0);
  await act(async()=>h.tick());await respond(sample(['R'],4));assert.equal(value(tree),'Kernel priority 20 · Nice 0');
  await act(async()=>h.tick());const bad=sample(['R'],5);delete bad.threads[0].nice;await respond(bad);
  assert.equal(value(tree),'Priority / nice unavailable');assert(tree.root.findByProps({testID:'thread-cpu-usage-0'}));
  await act(async()=>h.tick());await act(async()=>h.requests.shift().reject(new Error('native failed')));
  assert.equal(tree.root.findAllByProps({testID:'thread-priority-0'}).length,0);
  await act(async()=>h.tick());await respond(sample(['R'],7));assert.equal(value(tree),'Kernel priority 20 · Nice 0');
 } finally {await act(async()=>tree.unmount());}assert.equal(h.listeners.size,0);
});
test('iOS CPU card does not show Android priority labels',async()=>{
 const h=harness('ios');let tree;await act(async()=>{tree=create(React.createElement(h.load('ThreadCpuCard.tsx').ThreadCpuCard));});
 assert.equal(tree.root.findAllByProps({testID:'thread-priority-status'}).length,0);await act(async()=>tree.unmount());
});
