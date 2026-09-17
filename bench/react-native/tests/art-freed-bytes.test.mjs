import assert from 'node:assert/strict';
import test from 'node:test';
import {validateMemorySample, validateArtFreedBytes, formatArtFreedBytes} from '../src/memory.ts';
const row = (bytes = 5) => ({
  platform:'android', osVersion:'16', apiLevel:36, processId:123, sequence:1,
  sampledAtMs:1800000000000, clockSource:'SystemClock.elapsedRealtimeNanos',
  monotonicMs:1001, queryStartedUptimeMs:1000, queryFinishedUptimeMs:1002, readDurationMs:2,
  source:'/proc/self/smaps_rollup:Rss', rssBytes:16384, heldBytes:0,
  artFreedBytes:{bytes, rawBytes:String(bytes), source:'Debug.getRuntimeStat("art.gc.bytes-freed")',
    statistic:'art.gc.bytes-freed', runtime:'ART', signed:true, monotonic:false, accounting:'art_managed_bytes_freed_net', scope:'process_lifetime', unit:'bytes', approximate:true, error:null},
});
test('ART reclaimed-byte accounting preserves zero and exact cumulative byte values without claiming current heap usage', () => {
  for(const n of [0,1,-1,-50,Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER]) assert.equal(validateArtFreedBytes(row(n)).bytes,n);
  assert.equal(validateMemorySample(row()).rssBytes,16384);
});
test('ART unavailable, malformed and out-of-range strings retain evidence', () => {
  for(const rawBytes of [null,'','-01','-0','+1','01',' 1','1\n','1.5','NaN','-9007199254740992','-9223372036854775809','9007199254740992','9223372036854775808']) {
    const s=row();s.artFreedBytes={...s.artFreedBytes,bytes:null,rawBytes,error:'query/format/range failure'};
    assert.equal(validateArtFreedBytes(s).rawBytes,rawBytes);assert.equal(validateMemorySample(s).rssBytes,16384);
  }
  const s=row();delete s.artFreedBytes;assert.throws(()=>validateArtFreedBytes(s));assert.equal(validateMemorySample(s).rssBytes,16384);
});
test('ART reclaimed-byte accounting rejects rounded values and contradictory availability', () => {
  for(const change of [{bytes:-0},{bytes:Number.MIN_SAFE_INTEGER-1},{bytes:.5},{bytes:Number.MAX_SAFE_INTEGER+1},{bytes:NaN},
    {bytes:0,rawBytes:'-0'},{rawBytes:'6'},{rawBytes:'5\n'},{rawBytes:null},{rawBytes:5},{rawBytes:'05'},
    {bytes:null,error:'failed'},{bytes:null,rawBytes:null,error:null},{error:'failed'}]) {
    const s=row();assert.throws(()=>validateArtFreedBytes({...s,artFreedBytes:{...s.artFreedBytes,...change}}));
  }
});
test('ART reclaimed-byte accounting rejects different runtime, counter, units and scope', () => {
  for(const change of [{signed:false},{monotonic:true},{accounting:'current_heap_used'},{accounting:'native_malloc'},{runtime:'Hermes'},{unit:'milliseconds'},{scope:'device'}, {approximate:false},
    {statistic:'art.gc.gc-count'},{statistic:'art.gc.bytes-allocated'},{source:'Debug.getRuntimeStats()'}]) {
    const s=row();assert.throws(()=>validateArtFreedBytes({...s,artFreedBytes:{...s.artFreedBytes,...change}}));
  }
});
test('ART reclaimed-byte accounting verifies Android sample identity and monotonic query window', () => {
  for(const change of [{platform:'ios'},{apiLevel:23},{processId:0},{sequence:0},{osVersion:''},
    {clockSource:'Date.now'},{queryFinishedUptimeMs:999},{queryStartedUptimeMs:NaN},{monotonicMs:999}])
    assert.throws(()=>validateArtFreedBytes({...row(),...change}));
  // Independent samples may belong to fresh processes; no global high-water correction.
  assert.equal(validateArtFreedBytes({...row(0),processId:124}).bytes,0);
});

test('ART reclaimed-byte accounting is independent of current heap/RSS gauges and GC counts', () => {
  const s=row(104857600);s.javaHeapUsed={bytes:1048576};s.artGcCount={count:0};
  assert.equal(validateArtFreedBytes(s).bytes,104857600);
  const missing={...s,artFreedBytes:{...s.artFreedBytes,bytes:null,rawBytes:null,error:'unavailable'}};
  assert.equal(validateMemorySample(missing).rssBytes,16384);
});

test('ART reclaimed-byte adjustments can decrease and cross zero without correction', () => {
  assert.deepEqual([100,75,-32,0,-1].map(n=>validateArtFreedBytes(row(n)).bytes),[100,75,-32,0,-1]);
});
test('small negative reclaimed values retain a visible sign', () => {
  assert.equal(formatArtFreedBytes(-1),'-1 B');assert.equal(formatArtFreedBytes(0),'0 B');
  assert.equal(formatArtFreedBytes(-1048576),'-1.0 MiB');assert.equal(formatArtFreedBytes(1048576),'1.0 MiB');
});
