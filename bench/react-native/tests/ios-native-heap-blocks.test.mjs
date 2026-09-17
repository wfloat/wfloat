import assert from 'node:assert/strict';
import test from 'node:test';
import {validateIosNativeHeapBlocks,validateMemorySample} from '../src/memory.ts';
const row=(count=64)=>({platform:'ios',osVersion:'18.0',processId:123,sequence:1,sampledAtMs:1800000000000,
 clockSource:'NSProcessInfo.systemUptime',monotonicMs:1001,queryStartedUptimeMs:1000,queryFinishedUptimeMs:1002,readDurationMs:2,
 source:'task_info(MACH_TASK_BASIC_INFO).resident_size',rssBytes:16384,heldBytes:0,
 physicalFootprint:{bytes:24576,source:'task_info(TASK_VM_INFO).phys_footprint',error:null},
 nativeHeapBlocks:{count,rawCount:String(count),source:'malloc_zone_statistics(NULL).blocks_in_use',scope:'calling_process',unit:'blocks',aggregation:'gauge',
 accounting:'malloc_zone_blocks_in_use',zones:'registered_malloc_zones',nativeWidthBits:32,environment:'simulator',error:null}});
const change=c=>({...row(),nativeHeapBlocks:{...row().nativeHeapBlocks,...c}});
test('heap blocks is an independent gauge, including zero, decreases and full unsigned range',()=>{
 for(const count of [0,64,32,4294967295])assert.equal(validateIosNativeHeapBlocks(row(count)).count,count);
 assert.equal(validateIosNativeHeapBlocks(change({environment:'device'})).environment,'device');
});
test('missing or unavailable block count leaves RSS usable',()=>{
 const r=change({count:null,rawCount:null,error:'Unavailable'});assert.equal(validateIosNativeHeapBlocks(r).count,null);assert.equal(validateMemorySample(r).rssBytes,16384);
 delete r.nativeHeapBlocks;assert.throws(()=>validateIosNativeHeapBlocks(r));assert.equal(validateMemorySample(r).rssBytes,16384);
});
test('heap block count rejects fractional, overflow, mismatched and noncanonical raw values',()=>{
 for(const c of [{count:-1},{count:.5},{count:4294967296,rawCount:'4294967296'},{count:NaN},{count:null},{rawCount:'65'},
 {rawCount:'064'},{rawCount:'-1'},{rawCount:'64.0'},{rawCount:'4e1'},{rawCount:null},{error:'failed'},
 {count:null,rawCount:null,error:null},{count:null,rawCount:null,error:''}]) assert.throws(()=>validateIosNativeHeapBlocks(change(c)));
});
test('heap blocks validates API identity, accounting, unit, native width and environment',()=>{
 for(const c of [{source:'malloc_zone_statistics(NULL).size_in_use'},{scope:'device'},{unit:'bytes'},{aggregation:'cumulative'},
 {accounting:'malloc_zone_reserved_bytes'},{zones:'default_zone_only'},{nativeWidthBits:64},{environment:'unknown'}])assert.throws(()=>validateIosNativeHeapBlocks(change(c)));
});
test('heap blocks validates platform, clock and native sample identity/timing',()=>{
 for(const c of [{platform:'android'},{clockSource:'Date.now'},{sequence:0},{processId:0},{osVersion:''},
 {queryStartedUptimeMs:NaN},{queryFinishedUptimeMs:999},{monotonicMs:999}])assert.throws(()=>validateIosNativeHeapBlocks({...row(),...c}));
});
