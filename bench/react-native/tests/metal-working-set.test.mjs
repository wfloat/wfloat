import assert from 'node:assert/strict';
import test from 'node:test';
import {validateMetalWorkingSet,validateMemorySample} from '../src/memory.ts';
const row = (bytes=65536) => ({platform:'ios', osVersion:'18.0', processId:123, sequence:1,
 sampledAtMs:1800000000000, clockSource:'NSProcessInfo.systemUptime', monotonicMs:1001,
 queryStartedUptimeMs:1000, queryFinishedUptimeMs:1002, readDurationMs:2,
 source:'task_info(MACH_TASK_BASIC_INFO).resident_size',rssBytes:16384,heldBytes:0,
 physicalFootprint:{bytes:24576,source:'task_info(TASK_VM_INFO).phys_footprint',error:null},
 metalWorkingSet:{bytes,rawBytes:String(bytes),source:'MTLDevice.recommendedMaxWorkingSetSize',unit:'bytes',
 scope:'calling_process_default_mtl_device',accounting:'metal_recommended_working_set_bytes',deviceName:'Apple A15 GPU',
 environment:'device',queryStartedUptimeMs:1003,queryFinishedUptimeMs:1004,
 error:null}});
const changed = change => ({...row(),metalWorkingSet:{...row().metalWorkingSet,...change}});

test('Metal recommendation is an independent gauge, including zero and values larger than RSS',()=>{
 for(const bytes of [0,65536,4294967296,2147483648]) assert.equal(validateMetalWorkingSet(row(bytes)).bytes,bytes);
 assert.equal(validateMetalWorkingSet(changed({environment:'simulator'})).environment,'simulator');
});
test('iOS 15 keeps other memory usable and preserves explicit recommendation unavailability',()=>{
 const s={...changed({bytes:null,rawBytes:null,error:'Requires iOS 16 or later'}),osVersion:'15.7'};
 assert.equal(validateMetalWorkingSet(s).bytes,null);assert.equal(validateMemorySample(s).rssBytes,16384);
 assert.throws(()=>validateMetalWorkingSet({...row(),osVersion:'15.7'}));
 assert.equal(validateMetalWorkingSet({...row(),osVersion:'16.0'}).bytes,65536);
 const noDevice=changed({bytes:null,rawBytes:null,deviceName:null,error:'No Metal device available'});
 assert.equal(validateMetalWorkingSet(noDevice).bytes,null);
 delete noDevice.metalWorkingSet;assert.throws(()=>validateMetalWorkingSet(noDevice));assert.equal(validateMemorySample(noDevice).rssBytes,16384);
});
test('Metal recommendation preserves unsigned precision and rejects rounded, hidden or malformed values',()=>{
 for(const rawBytes of ['9007199254740992','18446744073709551615'])
  assert.equal(validateMetalWorkingSet(changed({bytes:null,rawBytes,error:'Exceeds exact JS range'})).rawBytes,rawBytes);
 for(const change of [{bytes:-1},{bytes:.5},{rawBytes:'65537'},{rawBytes:'065536'},{rawBytes:'-1'},
  {rawBytes:'18446744073709551616',bytes:null,error:'overflow'},{rawBytes:null},{bytes:null,error:'failed'},{error:'failed'},{deviceName:''}])
  assert.throws(()=>validateMetalWorkingSet(changed(change)));
});
test('Metal recommendation requires its own API, accounting, scope, timing and identity',()=>{
 for(const change of [{source:'MTLDevice.currentAllocatedSize'},{scope:'system'},{accounting:'metal_resource_allocation_bytes'},
  {unit:'pages'},{environment:'unknown'},{queryStartedUptimeMs:1001},{queryFinishedUptimeMs:1002},{queryStartedUptimeMs:NaN}])
  assert.throws(()=>validateMetalWorkingSet(changed(change)));
 for(const change of [{platform:'android'},{clockSource:'Date.now'},{processId:0},{sequence:0},{osVersion:''},{osVersion:'unknown'}])
  assert.throws(()=>validateMetalWorkingSet({...row(),...change}));
});
