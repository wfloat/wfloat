import assert from 'node:assert/strict';
import test from 'node:test';
import {validateMemorySample, validateArtBlockingGcTime} from '../src/memory.ts';
const row = (milliseconds = 5) => ({
  platform:'android', osVersion:'16', apiLevel:36, processId:123, sequence:1,
  sampledAtMs:1800000000000, clockSource:'SystemClock.elapsedRealtimeNanos',
  monotonicMs:1001, queryStartedUptimeMs:1000, queryFinishedUptimeMs:1002, readDurationMs:2,
  source:'/proc/self/smaps_rollup:Rss', rssBytes:16384, heldBytes:0,
  artBlockingGcTime:{milliseconds, rawMilliseconds:String(milliseconds), source:'Debug.getRuntimeStat("art.gc.blocking-gc-time")',
    statistic:'art.gc.blocking-gc-time', classification:'art_blocking_collection', runtime:'ART', accounting:'art_blocking_gc_run_duration', scope:'process_lifetime', unit:'milliseconds', approximate:true, error:null},
});
test('ART blocking GC time preserves zero and exact cumulative millisecond values without claiming pause time', () => {
  for(const n of [0,1,50,Number.MAX_SAFE_INTEGER]) assert.equal(validateArtBlockingGcTime(row(n)).milliseconds,n);
  assert.equal(validateMemorySample(row()).rssBytes,16384);
});
test('ART unavailable, malformed and out-of-range strings retain evidence', () => {
  for(const rawMilliseconds of [null,'','-1','-0','+1','01',' 1','1\n','1.5','NaN','9007199254740992','9223372036854775808']) {
    const s=row();s.artBlockingGcTime={...s.artBlockingGcTime,milliseconds:null,rawMilliseconds,error:'query/format/range failure'};
    assert.equal(validateArtBlockingGcTime(s).rawMilliseconds,rawMilliseconds);assert.equal(validateMemorySample(s).rssBytes,16384);
  }
  const s=row();delete s.artBlockingGcTime;assert.throws(()=>validateArtBlockingGcTime(s));assert.equal(validateMemorySample(s).rssBytes,16384);
});
test('ART blocking GC time rejects rounded values and contradictory availability', () => {
  for(const change of [{milliseconds:-1},{milliseconds:.5},{milliseconds:Number.MAX_SAFE_INTEGER+1},{milliseconds:NaN},
    {rawMilliseconds:'6'},{rawMilliseconds:'5\n'},{rawMilliseconds:null},{rawMilliseconds:5},{rawMilliseconds:'05'},
    {milliseconds:null,error:'failed'},{milliseconds:null,rawMilliseconds:null,error:null},{error:'failed'}]) {
    const s=row();assert.throws(()=>validateArtBlockingGcTime({...s,artBlockingGcTime:{...s.artBlockingGcTime,...change}}));
  }
});
test('ART blocking GC time rejects different runtime, counter, units and scope', () => {
  for(const change of [{accounting:'cpu_time'},{accounting:'art_gc_run_duration'},{classification:'all_pauses'},{runtime:'Hermes'},{unit:'bytes'},{scope:'device'}, {approximate:false},
    {statistic:'art.gc.gc-count'},{statistic:'art.gc.gc-time'},{source:'Debug.getRuntimeStats()'}]) {
    const s=row();assert.throws(()=>validateArtBlockingGcTime({...s,artBlockingGcTime:{...s.artBlockingGcTime,...change}}));
  }
});
test('ART blocking GC time verifies Android sample identity and monotonic query window', () => {
  for(const change of [{platform:'ios'},{apiLevel:23},{processId:0},{sequence:0},{osVersion:''},
    {clockSource:'Date.now'},{queryFinishedUptimeMs:999},{queryStartedUptimeMs:NaN},{monotonicMs:999}])
    assert.throws(()=>validateArtBlockingGcTime({...row(),...change}));
  // Independent samples may belong to fresh processes; no global high-water correction.
  assert.equal(validateArtBlockingGcTime({...row(0),processId:124}).milliseconds,0);
});

test('blocking duration is preserved without clamping to separately queried GC time or count', () => {
  const s=row(5);s.artGcTime={milliseconds:1};s.artBlockingGcCount={count:0};
  assert.equal(validateArtBlockingGcTime(s).milliseconds,5);
});
