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
  lastCpuSource:'/proc/self/task/*/stat:processor',lastCpuUnit:'logical_cpu_id',schedulerSource:'/proc/self/task/*/stat:policy,rt_priority',policyUnit:'linux_sched_policy',rtPriorityUnit:'linux_rt_priority',prioritySource:'/proc/self/task/*/stat:priority,nice',priorityUnit:'kernel_priority',niceUnit:'linux_nice',runStateSource:'/proc/self/task/*/stat:state',processId:123,sequence,osVersion:'16',apiLevel:36,
  sampledAtMs:1800000000000+t,queryStartedUptimeMs:t,queryFinishedUptimeMs:t+20,enumeratedThreadCount:states.length,
  threads:states.map((runState,i)=>({threadId:String(i+1),startTimeTicks:'100',name:'worker',userTime:sequence*100,systemTime:10,
   queryStartedUptimeMs:t+i,queryFinishedUptimeMs:t+i+.5,runState,lastCpu:i,policy:0,rtPriority:0,priority:20,nice:0})),errors:[]};
}
const validate=harness().load('threadPlacement.ts').validateAndroidThreadPlacement;
test('CPU zero and sparse IDs are recorded independently of scheduling settings',()=>{
 for(const lastCpu of [0,3,128,2147483647]) {
  const s=sample();s.threads[0].lastCpu=lastCpu;
  assert.equal(validate(s).threads[0].lastCpu,lastCpu);
 }
});
test('old and malformed placement records keep CPU and scheduler data usable',()=>{
 const cpu=harness().load('threadCpu.ts').validateThreadCpuSample;
 const scheduler=harness().load('threadScheduler.ts').validateAndroidThreadSchedulers;
 for(const lastCpu of [undefined,null,-1,1.5,'0',NaN,Infinity,2147483648]) {
  const s=sample();s.threads[0].lastCpu=lastCpu;assert.throws(()=>validate(s));
  assert.equal(cpu(s).threads.length,2);assert.equal(scheduler(s).observed,2);
 }
 for(const patch of [{lastCpuSource:undefined},{lastCpuSource:'wrong'},{lastCpuUnit:'count'}])assert.throws(()=>validate({...sample(),...patch}));
});
test('partial and empty placement scans preserve coverage',()=>{
 const s=sample(['R']);s.errors=[{threadId:'2',reason:'gone'}];s.enumeratedThreadCount=2;
 assert.equal(validate(s).unreadable,1);s.threads=[];s.enumeratedThreadCount=1;
 assert.equal(validate(s).observed,0);assert.throws(()=>validate({...s,enumeratedThreadCount:2}));
});
const value=(tree,index=0)=>tree.root.findByProps({testID:`thread-last-cpu-${index}`}).props.children;
test('actual card follows CPU movement, ranked identity, errors and foreground generations',async()=>{
 const h=harness();let tree;await act(async()=>{tree=create(React.createElement(h.load('ThreadCpuCard.tsx').ThreadCpuCard));});
 const respond=async s=>{assert(h.requests.length);await act(async()=>h.requests.shift().resolve(s));};
 try {
  await respond(sample());assert.equal(value(tree),'Last logical CPU 0');
  await act(async()=>h.tick());const next=sample(['R','S'],2);Object.assign(next.threads[1],{userTime:500,lastCpu:3});await respond(next);
  assert.equal(value(tree),'Last logical CPU 3');assert.equal(value(tree,1),'Last logical CPU 0');
  await act(async()=>h.tick());const old=h.requests.shift();await act(async()=>h.change('background'));
  assert.equal(tree.root.findAllByProps({testID:'thread-last-cpu-0'}).length,0);
  assert.equal(tree.root.findByProps({testID:'thread-last-cpu-status'}).props.children,'Last logical CPU paused');
  await act(async()=>h.change('active'));await act(async()=>old.resolve(sample(['R'],3)));
  assert.equal(tree.root.findAllByProps({testID:'thread-last-cpu-0'}).length,0);
  await act(async()=>h.tick());await respond(sample(['R'],4));assert.equal(value(tree),'Last logical CPU 0');
  await act(async()=>h.tick());const bad=sample(['R'],5);delete bad.threads[0].lastCpu;await respond(bad);
  assert.equal(value(tree),'Last logical CPU unavailable');assert(tree.root.findByProps({testID:'thread-cpu-usage-0'}));
  assert.match(tree.root.findByProps({testID:'thread-scheduler-0'}).props.children,/Normal/);
  await act(async()=>h.tick());await act(async()=>h.requests.shift().reject(new Error('native failed')));
  assert.equal(tree.root.findAllByProps({testID:'thread-last-cpu-0'}).length,0);
  await act(async()=>h.tick());await respond(sample(['R'],7));assert.equal(value(tree),'Last logical CPU 0');
 }finally{await act(async()=>tree.unmount());}assert.equal(h.listeners.size,0);
});
test('all readable placements count even outside five displayed rows',async()=>{
 const h=harness();let tree;await act(async()=>{tree=create(React.createElement(h.load('ThreadCpuCard.tsx').ThreadCpuCard));});
 try {
  await act(async()=>h.requests.shift().resolve(sample(Array(7).fill('S'))));
  assert.match(tree.root.findByProps({testID:'thread-last-cpu-status'}).props.children,/7 read/);
  assert.equal(tree.root.findAllByProps({testID:'thread-last-cpu-5'}).length,0);
 }finally{await act(async()=>tree.unmount());}
});
test('iOS does not show Android CPU placement',async()=>{
 const h=harness('ios');let tree;await act(async()=>{tree=create(React.createElement(h.load('ThreadCpuCard.tsx').ThreadCpuCard));});
 assert.equal(tree.root.findAllByProps({testID:'thread-last-cpu-status'}).length,0);await act(async()=>tree.unmount());
});
