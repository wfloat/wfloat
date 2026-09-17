import assert from 'node:assert/strict';
import test from 'node:test';
import {validateJavaHeapLimit,validateMemorySample} from '../src/memory.ts';
const row = (bytes = 67108864) => ({
  platform:'android', osVersion:'16', apiLevel:36, processId:123, sequence:1,
  sampledAtMs:1800000000000, clockSource:'SystemClock.elapsedRealtimeNanos',
  monotonicMs:1001, queryStartedUptimeMs:1000, queryFinishedUptimeMs:1002, readDurationMs:2,
  source:'/proc/self/smaps_rollup:Rss', rssBytes:16384, heldBytes:0,
  javaHeapLimit:{bytes,rawBytes:String(bytes),source:'Runtime.maxMemory()',scope:'calling_process',unit:'bytes',
    accounting:'managed_heap_limit_bytes',limitKind:'finite',error:null},
});
const change = c => ({...row(), javaHeapLimit:{...row().javaHeapLimit,...c}});
test('Java heap limit reads finite limits and preserves raw values beyond safe numeric range',()=>{
  for(const n of [0,67108864,134217728,Number.MAX_SAFE_INTEGER]) assert.equal(validateJavaHeapLimit(row(n)).bytes,n);
  for(const rawBytes of ['9007199254740992','9223372036854775806'])
    assert.equal(validateJavaHeapLimit(change({rawBytes,bytes:null,error:'Out of numeric range'})).rawBytes,rawBytes);
});
test('Java heap no-inherent-limit marker is neither numeric nor a query failure',()=>{
  const c={rawBytes:'9223372036854775807',bytes:null,limitKind:'no_inherent_limit',error:null};
  assert.equal(validateJavaHeapLimit(change(c)).limitKind,'no_inherent_limit');
  for(const invalid of [{limitKind:'finite'},{rawBytes:'67108864'},{bytes:Number.MAX_SAFE_INTEGER},{error:'failed'}])
    assert.throws(()=>validateJavaHeapLimit(change({...c,...invalid})));
});
test('Java heap limit preserves unavailable evidence without erasing RSS',()=>{
  for(const rawBytes of [null,'-1','-9223372036854775808']) {
    const s=change({rawBytes,bytes:null,limitKind:'unavailable',error:'failed'});
    assert.equal(validateJavaHeapLimit(s).bytes,null); assert.equal(validateMemorySample(s).rssBytes,16384);
  }
  const s=row();delete s.javaHeapLimit;assert.throws(()=>validateJavaHeapLimit(s));assert.equal(validateMemorySample(s).rssBytes,16384);
});
test('Java heap limit rejects contradictions, malformed raw values and wrong interpretation',()=>{
  for(const c of [{rawBytes:null},{rawBytes:'067108864'},{rawBytes:'-0'},{rawBytes:67108864},{rawBytes:'9223372036854775808'},
    {rawBytes:'-9223372036854775809'},{bytes:0},{bytes:NaN},{bytes:null,error:'failed'},
    {limitKind:'unavailable',bytes:null,error:'failed'},{limitKind:'unknown'},{error:'failed'},
    {scope:'device'},{unit:'MiB'},{accounting:'free_ram'},{source:'Runtime.totalMemory()'}])
    assert.throws(()=>validateJavaHeapLimit(change(c)));
});
test('Java heap limit requires Android identity and a monotonic query interval',()=>{
  for(const c of [{platform:'ios'},{apiLevel:0},{sequence:0},{processId:0},{clockSource:'Date.now'},
    {queryStartedUptimeMs:NaN},{queryFinishedUptimeMs:999},{monotonicMs:999},{osVersion:''}])
    assert.throws(()=>validateJavaHeapLimit({...row(),...c}));
});
