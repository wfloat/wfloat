import test from 'node:test';
import assert from 'node:assert/strict';
import { energyWindow, compareEnergyWindows } from '../src/energyComparison.ts';

function sample(sequence, timestamp, energy, age = 15) {
  const callback = timestamp + age;
  return {source:'SystemHealthManager.powerMonitors',status:'ready',reason:null,queryStage:'readings',inventoryId:'i',
    pid:3,uid:10001,sequence,apiLevel:35,fingerprint:'fixture',scope:'device_subsystems',finePermissionGranted:false,
    collectionMode:'comparison',queryStartedUptimeMs:callback-1,queryFinishedUptimeMs:callback+1,queryDurationMs:2,
    recordedAtMs:10000000+callback,monitorCount:1,monitors:[{id:'i:0',index:0,name:'CPU',typeRaw:1,type:'rail',
      availability:'available',reason:null,rawEnergyUws:energy,rawSnapshotUptimeMs:String(timestamp),
      joules:Number(energy)/1e6,snapshotAgeAtReadMs:age,callbackUptimeMs:callback}]};
}
test('energy interval uses source snapshots, independent of query spacing and wall time',()=>{
  const a=sample(1,40000,'1000000'),b=sample(2,75000,'71000000',1500); b.recordedAtMs=1;
  const interval=energyWindow('idle',a,b,100).intervals[0];
  assert.equal(interval.elapsedMs,35000);assert.equal(interval.joules,70);assert.equal(interval.averageWatts,2);
});
test('raw counter subtraction preserves a tiny delta at the 64-bit limit',()=>{
  const w=energyWindow('idle',sample(1,40000,'9223372036854775800'),sample(2,75000,'9223372036854775807'),100);
  assert.equal(w.intervals[0].rawDeltaUws,'7');assert.equal(w.intervals[0].joules,0.000007);
});
test('cached, backwards, unsettled and short snapshots do not become watts',()=>{
  for (const [timestamp,age,eligible] of [[40000,36000,100],[39999,36000,100],[75000,15,40001],[50000,15,100]]) {
    const w=energyWindow('idle',sample(1,40000,'1000000'),sample(2,timestamp,'2000000',age),eligible);
    assert.ok(w.intervals[0].reason);assert.equal(w.intervals[0].averageWatts,null);
  }
});
test('decreasing and missing energy are flagged; unchanged energy yields valid zero',()=>{
  const a=sample(1,40000,'1000000');
  assert.equal(energyWindow('idle',a,sample(2,75000,'999999'),100).intervals[0].averageWatts,null);
  assert.equal(energyWindow('idle',a,sample(2,75000,'1000000'),100).intervals[0].averageWatts,0);
  const b=sample(2,75000,'0'); Object.assign(b.monitors[0],{availability:'unavailable',reason:'energy_unavailable',rawEnergyUws:'-1',joules:null,snapshotAgeAtReadMs:null});
  assert.equal(energyWindow('idle',a,b,100).intervals[0].averageWatts,null);
});
test('device, access, identity and order changes invalidate the comparison',()=>{
  const a=sample(1,40000,'0');
  for (const changes of [{pid:4},{finePermissionGranted:true},{inventoryId:'other'},{fingerprint:'other'},{sequence:1}])
    assert.throws(()=>energyWindow('idle',a,{...sample(2,75000,'35000000'),...changes},100));
});
test('comparison retains negative differences and does not sum duplicate consumers',()=>{
  const idle=energyWindow('idle',sample(1,40000,'0'),sample(2,75000,'70000000'),100);
  const cpu=energyWindow('cpu',sample(3,120000,'80000000'),sample(4,155000,'115000000'),100000);
  assert.equal(compareEnergyWindows(idle,cpu)[0].differenceWatts,-1);
  assert.throws(()=>compareEnergyWindows(cpu,idle));
});
