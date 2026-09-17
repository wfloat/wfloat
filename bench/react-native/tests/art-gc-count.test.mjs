import assert from 'node:assert/strict';
import test from 'node:test';
import {validateMemorySample, validateArtGcCount} from '../src/memory.ts';
const row = (count = 5) => ({
  platform:'android', osVersion:'16', apiLevel:36, processId:123, sequence:1,
  sampledAtMs:1800000000000, clockSource:'SystemClock.elapsedRealtimeNanos',
  monotonicMs:1001, queryStartedUptimeMs:1000, queryFinishedUptimeMs:1002, readDurationMs:2,
  source:'/proc/self/smaps_rollup:Rss', rssBytes:16384, heldBytes:0,
  artGcCount:{count, rawCount:String(count), source:'Debug.getRuntimeStat("art.gc.gc-count")',
    statistic:'art.gc.gc-count', runtime:'ART', scope:'process_lifetime', unit:'collections', approximate:true, error:null},
});
test('ART count preserves zero and exact cumulative values without claiming bytes', () => {
  for(const n of [0,1,50,Number.MAX_SAFE_INTEGER]) assert.equal(validateArtGcCount(row(n)).count,n);
  assert.equal(validateMemorySample(row()).rssBytes,16384);
});
test('ART unavailable, malformed and out-of-range strings retain evidence', () => {
  for(const rawCount of [null,'','-1','-0','+1','01',' 1','1\n','1.5','NaN','9007199254740992','9223372036854775808']) {
    const s=row();s.artGcCount={...s.artGcCount,count:null,rawCount,error:'query/format/range failure'};
    assert.equal(validateArtGcCount(s).rawCount,rawCount);assert.equal(validateMemorySample(s).rssBytes,16384);
  }
  const s=row();delete s.artGcCount;assert.throws(()=>validateArtGcCount(s));assert.equal(validateMemorySample(s).rssBytes,16384);
});
test('ART count rejects rounded values and contradictory availability', () => {
  for(const change of [{count:-1},{count:.5},{count:Number.MAX_SAFE_INTEGER+1},{count:NaN},
    {rawCount:'6'},{rawCount:null},{rawCount:5},{rawCount:'05'},
    {count:null,error:'failed'},{count:null,rawCount:null,error:null},{error:'failed'}]) {
    const s=row();assert.throws(()=>validateArtGcCount({...s,artGcCount:{...s.artGcCount,...change}}));
  }
});
test('ART count rejects different runtime, counter, units and scope', () => {
  for(const change of [{runtime:'Hermes'},{unit:'bytes'},{scope:'device'}, {approximate:false},
    {statistic:'art.gc.blocking-gc-count'},{source:'Debug.getRuntimeStats()'}]) {
    const s=row();assert.throws(()=>validateArtGcCount({...s,artGcCount:{...s.artGcCount,...change}}));
  }
});
test('ART count verifies Android sample identity and monotonic query window', () => {
  for(const change of [{platform:'ios'},{apiLevel:23},{processId:0},{sequence:0},{osVersion:''},
    {clockSource:'Date.now'},{queryFinishedUptimeMs:999},{queryStartedUptimeMs:NaN},{monotonicMs:999}])
    assert.throws(()=>validateArtGcCount({...row(),...change}));
  // Independent samples may belong to fresh processes; no global high-water correction.
  assert.equal(validateArtGcCount({...row(0),processId:124}).count,0);
});
