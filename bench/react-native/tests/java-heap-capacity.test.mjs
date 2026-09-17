import assert from 'node:assert/strict';
import test from 'node:test';
import {deriveJavaHeapCapacity,validateJavaHeapUsed,validateMemorySample} from '../src/memory.ts';
const row = (total = '12288', free = '8192') => {
  const used=BigInt(total)-BigInt(free),safe=used>=0n&&used<=BigInt(Number.MAX_SAFE_INTEGER);
  return {platform:'android',osVersion:'16',apiLevel:36,processId:123,sequence:1,
    sampledAtMs:1800000000000,clockSource:'SystemClock.elapsedRealtimeNanos',monotonicMs:1001,
    queryStartedUptimeMs:1000,queryFinishedUptimeMs:1002,readDurationMs:2,
    source:'/proc/self/smaps_rollup:Rss',rssBytes:16384,heldBytes:0,
    javaHeapUsed:{bytes:safe?Number(used):null,rawBytes:String(used),error:safe?null:'Out of numeric range',
      source:'Runtime.totalMemory() - Runtime.freeMemory()',scope:'calling_process',unit:'bytes',
      accounting:'managed_heap_used_bytes',consistency:'total_before_equals_total_after',
      rawTotalBeforeBytes:total,rawFreeBytes:free,rawTotalAfterBytes:total}};
};
test('capacity uses total, not used, free, RSS or maximum limit; preserves provenance',()=>{
  const s=row();s.javaHeapLimit={bytes:201326592};
  const c=deriveJavaHeapCapacity(s);
  assert.equal(c.bytes,12288);assert.equal(c.rawBytes,'12288');assert.equal(c.error,null);
  assert.equal(c.source,'Runtime.totalMemory()');assert.equal(c.scope,'calling_process');
  assert.equal(c.unit,'bytes');assert.equal(c.accounting,'managed_heap_current_capacity_bytes');
  assert.equal(c.input,'javaHeapUsed.rawTotalAfterBytes');
});
test('capacity permits zero, growth, shrinkage and exact integer boundary',()=>{
  for(const n of [0,1048576,8192,Number.MAX_SAFE_INTEGER])
    assert.equal(deriveJavaHeapCapacity(row(String(n),'0')).bytes,n);
});
test('capacity retains final read when resizing invalidates used estimate',()=>{
  for(const after of ['16384','4096']) {
    const s=row();Object.assign(s.javaHeapUsed,{rawTotalAfterBytes:after,bytes:null,rawBytes:null,error:'Heap resized'});
    assert.equal(validateJavaHeapUsed(s).bytes,null);assert.equal(deriveJavaHeapCapacity(s).bytes,Number(after));
  }
});
test('capacity keeps raw unsafe values even when used difference remains exact',()=>{
  for(const total of ['9007199254740992','9223372036854775807']) {
    const s=row(total,(BigInt(total)-7n).toString()),c=deriveJavaHeapCapacity(s);
    assert.equal(validateJavaHeapUsed(s).bytes,7);assert.equal(c.rawBytes,total);
    assert.equal(c.bytes,null);assert.match(c.error,/exact JavaScript integer range/);
  }
});
test('capacity does not substitute the earlier total when final query is missing or negative',()=>{
  for(const rawTotalAfterBytes of [null,'-1']) {
    const s=row();Object.assign(s.javaHeapUsed,{rawTotalAfterBytes,bytes:null,rawBytes:null,error:'Read failed'});
    const c=deriveJavaHeapCapacity(s);assert.equal(c.bytes,null);assert.equal(c.rawBytes,rawTotalAfterBytes);
    assert(c.error);assert.equal(validateMemorySample(s).rssBytes,16384);
  }
});
test('capacity rejects corrupted evidence and invalid sample provenance',()=>{
  for(const rawTotalAfterBytes of ['012288','-0',12288,undefined,'9223372036854775808']) {
    const s=row();s.javaHeapUsed.rawTotalAfterBytes=rawTotalAfterBytes;assert.throws(()=>deriveJavaHeapCapacity(s));
  }
  for(const change of [{platform:'ios'},{processId:0},{sequence:0},{clockSource:'Date.now'},{queryFinishedUptimeMs:999}])
    assert.throws(()=>deriveJavaHeapCapacity({...row(),...change}));
  const s=row();delete s.javaHeapUsed;assert.throws(()=>deriveJavaHeapCapacity(s));
});
