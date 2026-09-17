import assert from 'node:assert/strict';
import test from 'node:test';
import {validateNativeMallocCheck,nativeMallocStages} from '../src/memory.ts';
const counter=(kind,bytes=4096)=>({bytes,rawBytes:String(bytes),scope:'calling_process',unit:'bytes',error:null,
 source:{allocated:'Debug.getNativeHeapAllocatedSize()',free:'Debug.getNativeHeapFreeSize()',size:'Debug.getNativeHeapSize()'}[kind],
 accounting:{allocated:'native_allocator_bytes',free:'native_allocator_free_bytes',size:'native_allocator_size_bytes'}[kind]});
const row=()=>({platform:'android',apiLevel:36,osVersion:'16',processId:123,sequence:1,sampledAtMs:1800000000000,
 source:'/proc/self/smaps_rollup:Rss',rssBytes:1234,heldBytes:0,clockSource:'SystemClock.elapsedRealtimeNanos',
 monotonicMs:1001,queryStartedUptimeMs:1000,queryFinishedUptimeMs:1002,readDurationMs:2,
 nativeMallocCheck:{run:1,schemaVersion:1,stage:'completed',scope:'calling_process',error:null,maxHeldBytes:16777216,heldBytes:0,
 clockSource:'SystemClock.elapsedRealtimeNanos',queryStartedUptimeMs:10,queryFinishedUptimeMs:200,
 phases:nativeMallocStages.map((stage,i)=>({stage,heldBytes:[0,16777216,0,16777216,8388608,0,16777216,0,16777216,0][i],
 queryStartedUptimeMs:11+i*10,queryFinishedUptimeMs:12+i*10,allocated:counter('allocated'),free:counter('free'),size:counter('size')}))}});
test('completed check validates all phases without imposing allocator response or RSS equality',()=>{
 const s=row();assert.equal(validateNativeMallocCheck(s).phases.length,10);
 s.nativeMallocCheck.phases[1].allocated=counter('allocated',0);assert.doesNotThrow(()=>validateNativeMallocCheck(s));
});
test('cancelled and failed checks retain partial phases and cleanup evidence',()=>{
 for(const stage of ['cancelled','failed']){const s=row();s.nativeMallocCheck.stage=stage;s.nativeMallocCheck.error='interrupted';s.nativeMallocCheck.phases=s.nativeMallocCheck.phases.slice(0,2);assert.equal(validateNativeMallocCheck(s).stage,stage);}
});
test('rejects incomplete completion, phase swaps and false cleanup',()=>{
 for(const change of [{phases:row().nativeMallocCheck.phases.slice(0,9)},{heldBytes:4096},{maxHeldBytes:33554432},{error:'failed'},{stage:'running'},{run:0},{schemaVersion:2}]){
 const s=row();Object.assign(s.nativeMallocCheck,change);assert.throws(()=>validateNativeMallocCheck(s));}
 const s=row();s.nativeMallocCheck.phases.reverse();assert.throws(()=>validateNativeMallocCheck(s));
});
test('rejects invalid query windows and incorrect allocation holdings',()=>{
 for(const change of [{queryStartedUptimeMs:NaN},{queryFinishedUptimeMs:1001},{queryFinishedUptimeMs:9}]){
 const s=row();Object.assign(s.nativeMallocCheck,change);assert.throws(()=>validateNativeMallocCheck(s));}
 for(const change of [{heldBytes:0},{queryStartedUptimeMs:9},{queryFinishedUptimeMs:500}]){
 const s=row();Object.assign(s.nativeMallocCheck.phases[1],change);assert.throws(()=>validateNativeMallocCheck(s));}
});
test('uses existing validators for all three independent counters',()=>{
 for(const field of ['allocated','free','size']){
 const s=row();s.nativeMallocCheck.phases[1][field].rawBytes='4097';assert.throws(()=>validateNativeMallocCheck(s));
 const valid=row();Object.assign(valid.nativeMallocCheck.phases[1][field],{rawBytes:'-1',bytes:null,error:'unavailable'});assert.doesNotThrow(()=>validateNativeMallocCheck(valid));}
});
test('rejects wrong platform and incomplete cancellation explanation',()=>{
 const s=row();s.platform='ios';assert.throws(()=>validateNativeMallocCheck(s));
 for(const error of [null,'','   ']){const r=row();Object.assign(r.nativeMallocCheck,{stage:'cancelled',error});assert.throws(()=>validateNativeMallocCheck(r));}
});
