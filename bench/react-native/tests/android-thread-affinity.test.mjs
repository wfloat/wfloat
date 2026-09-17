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
  affinitySource:'/proc/self/task/*/status:Cpus_allowed_list',affinityUnit:'logical_cpu_list',affinityIdentityCheck:'stat_starttime_before_after',lastCpuSource:'/proc/self/task/*/stat:processor',lastCpuUnit:'logical_cpu_id',schedulerSource:'/proc/self/task/*/stat:policy,rt_priority',policyUnit:'linux_sched_policy',rtPriorityUnit:'linux_rt_priority',prioritySource:'/proc/self/task/*/stat:priority,nice',priorityUnit:'kernel_priority',niceUnit:'linux_nice',runStateSource:'/proc/self/task/*/stat:state',processId:123,sequence,osVersion:'16',apiLevel:36,
  sampledAtMs:1800000000000+t,queryStartedUptimeMs:t,queryFinishedUptimeMs:t+20,enumeratedThreadCount:states.length,
  threads:states.map((runState,i)=>({threadId:String(i+1),startTimeTicks:'100',name:'worker',userTime:sequence*100,systemTime:10,
   queryStartedUptimeMs:t+i,queryFinishedUptimeMs:t+i+.5,runState,affinity:{available:true,cpuList:"0-3",cpuCount:4,reason:null,queryStartedUptimeMs:t+i+.5,queryFinishedUptimeMs:t+i+.8},lastCpu:i,policy:0,rtPriority:0,priority:20,nice:0})),errors:[]};
}
const h0=harness(), mod=h0.load('threadAffinity.ts'), validate=mod.validateAndroidThreadAffinity;
test('CPU list preserves sparse IDs, zero and range counts without expansion',()=>{
 for(const [list,count] of [['0',1],['0-7',8],['0,2-4,128',5],['0-2147483647',2147483648]])assert.equal(mod.countAffinityCpus(list),count);
 for(const list of ['', '-1','1-0','0,0','0-3,3','1,0','01','0,','1.5','0 - 2','2147483648','0,'.repeat(600)])assert.throws(()=>mod.countAffinityCpus(list));
});
test('affinity errors do not invalidate CPU or last-CPU data',()=>{
 const s=sample();s.threads[0].affinity={...s.threads[0].affinity,available:false,cpuList:null,cpuCount:null,reason:'identity_changed'};
 assert.equal(validate(s).observed,1);assert.equal(validate(s).unavailable,1);
 assert.equal(h0.load('threadPlacement.ts').validateAndroidThreadPlacement(s).observed,2);
 delete s.threads[0].affinity;assert.throws(()=>validate(s));assert.equal(h0.load('threadCpu.ts').validateThreadCpuSample(s).threads.length,2);
});
test('validates source, counts, unavailable shape and separate query bounds',()=>{
 for(const patch of [{affinitySource:undefined},{affinityUnit:'count'},{affinityIdentityCheck:'none'}])assert.throws(()=>validate({...sample(),...patch}));
 for(const patch of [{cpuCount:3},{cpuList:'3,0'},{reason:'unexpected'},{queryStartedUptimeMs:2000},{queryFinishedUptimeMs:9000},{queryStartedUptimeMs:NaN},{available:false},{available:'yes'}]) {
  const s=sample();Object.assign(s.threads[0].affinity,patch);assert.throws(()=>validate(s));
 }
});
test('coverage includes CPU-read failures and all-unavailable scans',()=>{
 const s=sample(['R']);s.errors=[{threadId:'2',reason:'gone'}];s.enumeratedThreadCount=2;
 assert.equal(validate(s).unavailable,1);s.threads=[];s.enumeratedThreadCount=1;assert.equal(validate(s).observed,0);assert.equal(validate(s).unavailable,1);
});
const value=(tree,index=0)=>tree.root.findByProps({testID:`thread-affinity-${index}`}).props.children;
test('actual card follows ranked identities and clears affinity across foreground generations',async()=>{
 const h=harness();let tree;await act(async()=>{tree=create(React.createElement(h.load('ThreadCpuCard.tsx').ThreadCpuCard));});
 const respond=async s=>{await act(async()=>h.requests.shift().resolve(s));};
 try {
  await respond(sample());assert.equal(value(tree),'Reported CPU allowance 0-3 · 4 logical CPUs');
  await act(async()=>h.tick());const next=sample(['R','S'],2);next.threads[1].userTime=500;Object.assign(next.threads[1].affinity,{cpuList:'2',cpuCount:1});await respond(next);
  assert.equal(value(tree),'Reported CPU allowance 2 · 1 logical CPU');
  await act(async()=>h.tick());const old=h.requests.shift();await act(async()=>h.change('background'));assert.equal(tree.root.findAllByProps({testID:'thread-affinity-0'}).length,0);
  await act(async()=>h.change('active'));await act(async()=>old.resolve(sample(['R'],3)));assert.equal(tree.root.findAllByProps({testID:'thread-affinity-0'}).length,0);
  await act(async()=>h.tick());await respond(sample(['R'],4));assert.match(value(tree),/0-3/);
  await act(async()=>h.tick());const bad=sample(['R'],5);Object.assign(bad.threads[0].affinity,{available:false,cpuList:null,cpuCount:null,reason:'identity_changed'});await respond(bad);
  assert.match(value(tree),/unavailable.*identity_changed/);assert.match(tree.root.findByProps({testID:'thread-last-cpu-0'}).props.children,/Last logical CPU 0/);
  await act(async()=>h.tick());await act(async()=>h.requests.shift().reject(new Error('native failed')));assert.equal(tree.root.findAllByProps({testID:'thread-affinity-0'}).length,0);
  await act(async()=>h.tick());await respond(sample(['R'],7));assert.match(value(tree),/0-3/);
 }finally{await act(async()=>tree.unmount());}assert.equal(h.listeners.size,0);
});
test('iOS does not display Android affinity',async()=>{
 const h=harness('ios');let tree;await act(async()=>{tree=create(React.createElement(h.load('ThreadCpuCard.tsx').ThreadCpuCard));});
 assert.equal(tree.root.findAllByProps({testID:'thread-affinity-status'}).length,0);await act(async()=>tree.unmount());
});
