import assert from 'node:assert/strict';
import test from 'node:test';
import {deriveJavaHeapFree,validateJavaHeapUsed,validateMemorySample} from '../src/memory.ts';
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
test('free heap promotes the actual freeMemory input with source and provenance',()=>{
  const s=row();s.javaHeapLimit={bytes:201326592};
  const c=deriveJavaHeapFree(s);
  assert.equal(c.bytes,8192);assert.equal(c.rawBytes,'8192');assert.equal(c.error,null);
  assert.equal(c.source,'Runtime.freeMemory()');assert.equal(c.scope,'calling_process');
  assert.equal(c.unit,'bytes');assert.equal(c.accounting,'managed_heap_free_bytes');
  assert.equal(c.input,'javaHeapUsed.rawFreeBytes');
});
test('free heap permits zero, rise, fall and exact integer boundary',()=>{
  for(const n of [0,1048576,8192,Number.MAX_SAFE_INTEGER])
    assert.equal(deriveJavaHeapFree(row(String(n),String(n))).bytes,n);
});
test('free heap remains an independent reading when a resize invalidates used bytes',()=>{
  for(const after of ['16384','4096',null]) {
    const s=row();Object.assign(s.javaHeapUsed,{rawTotalAfterBytes:after,bytes:null,rawBytes:null,error:'Resize or final query failure'});
    assert.equal(validateJavaHeapUsed(s).bytes,null);assert.equal(deriveJavaHeapFree(s).bytes,8192);
  }
});
test('free heap never rounds unsafe raw input even when used bytes are small and exact',()=>{
  for(const free of ['9007199254740992','9223372036854775806']) {
    const s=row((BigInt(free)+1n).toString(),free),c=deriveJavaHeapFree(s);
    assert.equal(validateJavaHeapUsed(s).bytes,1);assert.equal(c.rawBytes,free);
    assert.equal(c.bytes,null);assert.match(c.error,/exact JavaScript integer range/);
  }
});
test('missing or negative free reading stays unavailable and preserves other metrics',()=>{
  for(const rawFreeBytes of [null,'-1']) {
    const s=row();Object.assign(s.javaHeapUsed,{rawFreeBytes,bytes:null,rawBytes:null,error:'Read failed'});
    const c=deriveJavaHeapFree(s);assert.equal(c.bytes,null);assert.equal(c.rawBytes,rawFreeBytes);
    assert(c.error);assert.equal(validateMemorySample(s).rssBytes,16384);
  }
});
test('free heap rejects corrupt evidence, wrong source and invalid sample provenance',()=>{
  for(const rawFreeBytes of ['08192','-0',8192,undefined,'9223372036854775808']) {
    const s=row();s.javaHeapUsed.rawFreeBytes=rawFreeBytes;assert.throws(()=>deriveJavaHeapFree(s));
  }
  for(const change of [{platform:'ios'},{processId:0},{sequence:0},{clockSource:'Date.now'},{queryFinishedUptimeMs:999}])
    assert.throws(()=>deriveJavaHeapFree({...row(),...change}));
  for(const change of [{source:'Runtime.maxMemory()'},{scope:'device'},{unit:'KiB'}]) {
    const s=row();Object.assign(s.javaHeapUsed,change);assert.throws(()=>deriveJavaHeapFree(s));
  }
  const s=row();delete s.javaHeapUsed;assert.throws(()=>deriveJavaHeapFree(s));
});
