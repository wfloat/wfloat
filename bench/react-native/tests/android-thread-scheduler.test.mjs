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
  schedulerSource:'/proc/self/task/*/stat:policy,rt_priority',policyUnit:'linux_sched_policy',rtPriorityUnit:'linux_rt_priority',prioritySource:'/proc/self/task/*/stat:priority,nice',priorityUnit:'kernel_priority',niceUnit:'linux_nice',runStateSource:'/proc/self/task/*/stat:state',processId:123,sequence,osVersion:'16',apiLevel:36,
  sampledAtMs:1800000000000+t,queryStartedUptimeMs:t,queryFinishedUptimeMs:t+20,enumeratedThreadCount:states.length,
  threads:states.map((runState,i)=>({threadId:String(i+1),startTimeTicks:'100',name:'worker',userTime:sequence*100,systemTime:10,
   queryStartedUptimeMs:t+i,queryFinishedUptimeMs:t+i+.5,runState,policy:0,rtPriority:0,priority:20,nice:0})),errors:[]};
}
const validate=harness().load('threadScheduler.ts').validateAndroidThreadSchedulers;
test('known Linux policy labels and real-time priorities are distinct from nice and raw priority',()=>{
 for(const [policy,name,rtPriority] of [[0,'Normal',0],[1,'FIFO',1],[1,'FIFO',99],[2,'Round robin',42],[3,'Batch',0],[5,'Idle',0],[6,'Deadline',0],[7,'Extensible',0]]) {
  const s=sample();Object.assign(s.threads[0],{policy,rtPriority});const r=validate(s).threads[0];
  assert.equal(r.policyName,name);assert.equal(r.policy,policy);assert.equal(r.rtPriority,rtPriority);assert.equal(r.note,null);
 }
});
test('unknown unsigned policies and unusual pairs remain raw with an explicit note',()=>{
 for(const policy of [4,99,1073741824,4294967295]) {
  const s=sample();Object.assign(s.threads[0],{policy,rtPriority:4294967295});const r=validate(s).threads[0];
  assert.equal(r.policy,policy);assert.equal(r.policyName,'Unknown');assert.equal(r.rtPriority,4294967295);assert.match(r.note,/Unknown/);
 }
 for(const [policy,rtPriority] of [[0,1],[1,0],[2,100],[6,10]]) {
  const s=sample();Object.assign(s.threads[0],{policy,rtPriority});assert.match(validate(s).threads[0].note,/Unexpected/);
 }
});
test('malformed and old scheduler records leave CPU and nice data usable',()=>{
 const cpu=harness().load('threadCpu.ts').validateThreadCpuSample,priority=harness().load('threadPriority.ts').validateAndroidThreadPriorities;
 for(const patch of [{policy:undefined},{policy:null},{policy:-1},{policy:1.5},{policy:'0'},{policy:4294967296},{rtPriority:-1},{rtPriority:undefined},{rtPriority:NaN},{rtPriority:4294967296}]) {
  const s=sample();Object.assign(s.threads[0],patch);assert.throws(()=>validate(s));assert.equal(cpu(s).threads.length,2);assert.equal(priority(s).observed,2);
 }
 for(const patch of [{schedulerSource:undefined},{schedulerSource:'wrong'},{policyUnit:'nice'},{rtPriorityUnit:'kernel_priority'}])assert.throws(()=>validate({...sample(),...patch}));
});
test('partial and all-unreadable scheduler scans retain accounting',()=>{
 const s=sample(['R']);s.errors=[{threadId:'2',reason:'gone'}];s.enumeratedThreadCount=2;
 assert.equal(validate(s).unreadable,1);s.threads=[];s.enumeratedThreadCount=1;assert.equal(validate(s).observed,0);assert.throws(()=>validate({...s,enumeratedThreadCount:2}));
});
const value=(tree,index=0)=>tree.root.findByProps({testID:`thread-scheduler-${index}`}).props.children;
test('actual card keeps scheduler values on their ranked thread identity and rejects stale responses',async()=>{
 const h=harness();let tree;await act(async()=>{tree=create(React.createElement(h.load('ThreadCpuCard.tsx').ThreadCpuCard));});
 const respond=async s=>{assert(h.requests.length);await act(async()=>h.requests.shift().resolve(s));};
 try {
  await respond(sample());assert.equal(value(tree),'Policy Normal (0) · RT priority 0');
  await act(async()=>h.tick());const next=sample(['R','S'],2);Object.assign(next.threads[1],{userTime:500,policy:2,rtPriority:42});await respond(next);
  assert.equal(value(tree),'Policy Round robin (2) · RT priority 42');assert.equal(value(tree,1),'Policy Normal (0) · RT priority 0');
  await act(async()=>h.tick());const old=h.requests.shift();await act(async()=>h.change('background'));
  assert.equal(tree.root.findAllByProps({testID:'thread-scheduler-0'}).length,0);
  await act(async()=>h.change('active'));await act(async()=>old.resolve(sample(['R'],3)));assert.equal(tree.root.findAllByProps({testID:'thread-scheduler-0'}).length,0);
  await act(async()=>h.tick());await respond(sample(['R'],4));assert.equal(value(tree),'Policy Normal (0) · RT priority 0');
  await act(async()=>h.tick());const bad=sample(['R'],5);delete bad.threads[0].policy;await respond(bad);
  assert.equal(value(tree),'Policy / RT priority unavailable');assert(tree.root.findByProps({testID:'thread-cpu-usage-0'}));assert.match(tree.root.findByProps({testID:'thread-priority-0'}).props.children,/Nice 0/);
  await act(async()=>h.tick());const unknown=sample(['R'],6);unknown.threads[0].policy=4;await respond(unknown);assert.match(value(tree),/Unknown \(4\).*Unknown policy/);
  await act(async()=>h.tick());await act(async()=>h.requests.shift().reject(new Error('native failed')));assert.equal(tree.root.findAllByProps({testID:'thread-scheduler-0'}).length,0);
  await act(async()=>h.tick());await respond(sample(['R'],8));assert.equal(value(tree),'Policy Normal (0) · RT priority 0');
 }finally{await act(async()=>tree.unmount());}assert.equal(h.listeners.size,0);
});
test('iOS does not display Android scheduling-policy UI',async()=>{
 const h=harness('ios');let tree;await act(async()=>{tree=create(React.createElement(h.load('ThreadCpuCard.tsx').ThreadCpuCard));});
 assert.equal(tree.root.findAllByProps({testID:'thread-scheduler-status'}).length,0);await act(async()=>tree.unmount());
});
test('unfamiliar policies outside the displayed five are surfaced in the coverage footer',async()=>{
 const h=harness();let tree;await act(async()=>{tree=create(React.createElement(h.load('ThreadCpuCard.tsx').ThreadCpuCard));});
 try {
  const s=sample(Array(7).fill('S'));s.threads[6].policy=99;
  await act(async()=>h.requests.shift().resolve(s));
  assert.match(tree.root.findByProps({testID:'thread-scheduler-status'}).props.children,/1 unfamiliar or unexpected pairs/);
  assert.equal(tree.root.findAllByProps({testID:'thread-scheduler-5'}).length,0);
  assert.equal(value(tree),'Policy Normal (0) · RT priority 0');
 }finally{await act(async()=>tree.unmount());}
});
