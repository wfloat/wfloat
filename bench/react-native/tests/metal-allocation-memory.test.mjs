import assert from 'node:assert/strict';
import test from 'node:test';
import {validateMetalAllocation, validateMemorySample} from '../src/memory.ts';
const row = (bytes=65536) => ({platform:'ios', osVersion:'18.0', processId:123, sequence:1,
 sampledAtMs:1800000000000, clockSource:'NSProcessInfo.systemUptime', monotonicMs:1001,
 queryStartedUptimeMs:1000, queryFinishedUptimeMs:1002, readDurationMs:2,
 source:'task_info(MACH_TASK_BASIC_INFO).resident_size',rssBytes:16384,heldBytes:0,
 physicalFootprint:{bytes:24576,source:'task_info(TASK_VM_INFO).phys_footprint',error:null},
 metalAllocation:{bytes,rawBytes:String(bytes),source:'MTLDevice.currentAllocatedSize',unit:'bytes',
 scope:'calling_process_default_mtl_device',accounting:'metal_resource_allocation_bytes',deviceName:'Apple A15 GPU',
 environment:'device',queryStartedUptimeMs:1003,queryFinishedUptimeMs:1004,
 initializationAttemptedThisSample:false,initializationDurationMs:8,error:null}});
const changed = change => ({...row(),metalAllocation:{...row().metalAllocation,...change}});
test('Metal allocation accepts zero and allocation/release independently of resident memory',()=>{
 for(const bytes of [0,65536,16842752,65536]) {
  const s=row(bytes);assert.equal(validateMetalAllocation(s).bytes,bytes);assert.equal(validateMemorySample(s).rssBytes,16384);
 }
 assert.equal(validateMetalAllocation(changed({environment:'simulator'})).environment,'simulator');
});
test('Metal unavailable state does not hide other memory counters',()=>{
 const s=changed({bytes:null,rawBytes:null,deviceName:null,error:'No Metal device available'});
 assert.equal(validateMetalAllocation(s).bytes,null);assert.equal(validateMemorySample(s).rssBytes,16384);
 delete s.metalAllocation;assert.throws(()=>validateMetalAllocation(s));assert.equal(validateMemorySample(s).rssBytes,16384);
});
test('Metal allocation retains unsigned 64-bit precision and rejects hidden or rounded values',()=>{
 for(const rawBytes of ['9007199254740992','18446744073709551615'])
  assert.equal(validateMetalAllocation(changed({bytes:null,rawBytes,error:'Exceeds exact JS range'})).rawBytes,rawBytes);
 for(const change of [{bytes:-1},{bytes:.5},{rawBytes:'65537'},{rawBytes:'065536'},{rawBytes:'-1'},
  {rawBytes:'18446744073709551616',bytes:null,error:'overflow'},{rawBytes:null},
  {bytes:null,error:'failed'},{error:'failed'},{deviceName:''}]) assert.throws(()=>validateMetalAllocation(changed(change)));
});
test('Metal query timing separates first initialization from subsequent reads',()=>{
 assert.equal(validateMetalAllocation(changed({initializationAttemptedThisSample:true,initializationDurationMs:.5})).initializationDurationMs,.5);
 for(const change of [{queryStartedUptimeMs:1001},{queryFinishedUptimeMs:1002},{queryStartedUptimeMs:NaN},
  {initializationDurationMs:-1},{initializationDurationMs:NaN},{initializationAttemptedThisSample:true},
  {initializationAttemptedThisSample:undefined}]) assert.throws(()=>validateMetalAllocation(changed(change)));
});
test('Metal allocation rejects wrong API, scope, units, environment and identity',()=>{
 for(const change of [{source:'task_info(TASK_VM_INFO).ledger_tag_graphics_footprint'}, {scope:'system'},
  {accounting:'resident_bytes'},{unit:'pages'},{environment:'unknown'}]) assert.throws(()=>validateMetalAllocation(changed(change)));
 for(const change of [{platform:'android'},{clockSource:'Date.now'},{processId:0},{sequence:0},{osVersion:''}])
  assert.throws(()=>validateMetalAllocation({...row(),...change}));
});
