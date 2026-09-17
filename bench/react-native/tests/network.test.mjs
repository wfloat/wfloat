import test from 'node:test';
import assert from 'node:assert/strict';
import { NetworkTracker, validateNetworkSample, networkMiB } from '../src/network.ts';
const counter = (raw, start) => ({rawBytes: raw, availability: 'available', reason: null,
  queryStartedUptimeMs: start, queryFinishedUptimeMs: start + 1});
const sample = (sequence = 1, rx = '1000', tx = '2000') => ({
  platform: 'android', source: 'TrafficStats.getUidRxBytes/getUidTxBytes', scope: 'calling_uid_since_boot',
  uid: 10234, processId: 2345, observationId: 'test-observation', sequence, osVersion: '16', apiLevel: 36,
  buildFingerprint: 'test-firmware', debugBuild: false, clockSource: 'SystemClock.elapsedRealtimeNanos',
  sourceSampledAtMs: null, sampledAtMs: 100000 + sequence * 2000,
  received: counter(rx, sequence * 2000), sent: counter(tx, sequence * 2000 + 2),
});
test('zero remains a valid total and rate; RX/TX have independent deltas', () => {
  const tracker = new NetworkTracker();
  assert.equal(tracker.record(sample(1, '0', '0')).windows.received, null);
  const result = tracker.record(sample(2, '4096', '0'));
  assert.deepEqual(result.windows.received, {deltaBytes: '4096', elapsedMs: 2000, bytesPerSecond: 2048});
  assert.equal(result.windows.sent.bytesPerSecond, 0);
});
test('native integers survive above the JS precision limit before subtraction', () => {
  const tracker = new NetworkTracker();
  tracker.record(sample(1, '9223372036854700000'));
  const row = tracker.record(sample(2, '9223372036854700001'));
  assert.equal(row.windows.received.deltaBytes, '1');
  assert.equal(row.windows.received.bytesPerSecond, 0.5);
  assert.equal(networkMiB('1048576'), '1.00');
  assert.equal(networkMiB('9223372036854775807'), '8796093022208.00');
});
test('unavailable RX retains valid TX and cannot bridge a missing interval', () => {
  const tracker = new NetworkTracker(); tracker.record(sample());
  const unavailable = sample(2); unavailable.received = {...unavailable.received,
    rawBytes: '-1', availability: 'unsupported', reason: 'api_returned_unsupported'};
  const row = tracker.record(unavailable);
  assert.equal(row.windows.received, null); assert.equal(row.windows.sent.bytesPerSecond, 0);
  assert.equal(tracker.record(sample(3)).windows.received, null);
  assert.equal(tracker.record(sample(4)).windows.received.bytesPerSecond, 0);
});
test('counter rollback uses current value as fresh baseline without hiding the total', () => {
  const tracker = new NetworkTracker(); tracker.record(sample());
  const row = tracker.record(sample(2, '5', '2500'));
  assert.equal(row.sample.received.rawBytes, '5'); assert.equal(row.resets.received, true);
  assert.equal(row.windows.received, null); assert.equal(row.windows.sent.bytesPerSecond, 250);
  assert.equal(tracker.record(sample(3, '15', '2500')).windows.received.deltaBytes, '10');
});
test('pause, new process, UID, reader identity and firmware require new baselines', () => {
  for (const changes of [{processId: 3456}, {uid: 10456}, {observationId: 'new-reader'}, {buildFingerprint: 'new-build'}]) {
    const tracker = new NetworkTracker(); tracker.record(sample());
    assert.equal(tracker.record({...sample(2), ...changes}).windows.received, null);
  }
  const tracker = new NetworkTracker(); tracker.record(sample()); tracker.reset();
  assert.equal(tracker.record(sample(2)).windows.received, null);
});
test('invalid sample order rejects the sample and clears its averaging baseline', () => {
  const tracker = new NetworkTracker(); tracker.record(sample());
  assert.throws(() => tracker.record(sample()), /out of order/);
  assert.equal(tracker.record(sample(2)).windows.received, null);
});
test('sentinel, malformed data and wrong scope cannot masquerade as usable measurements', () => {
  for (const rawBytes of ['-1', '-2', '01', '-0', '1.5', '9223372036854775808', 10, null]) {
    const row = sample(); row.received.rawBytes = rawBytes;
    assert.throws(() => validateNetworkSample(row));
  }
  for (const changes of [{scope: 'process'}, {uid: 0}, {sourceSampledAtMs: 123}, {sampledAtMs: NaN}, {apiLevel: 23}])
    assert.throws(() => validateNetworkSample({...sample(), ...changes}));
  const row = sample(); row.received = {...row.received, rawBytes: null, availability: 'error', reason: 'SecurityException'};
  assert.equal(validateNetworkSample(row).received.rawBytes, null);
  row.received.rawBytes = '-1'; assert.throws(() => validateNetworkSample(row));
});
test('query timing, not wall-clock adjustment, defines the rate interval', () => {
  const tracker = new NetworkTracker(); tracker.record(sample());
  const row = tracker.record({...sample(2, '3000'), sampledAtMs: 1});
  assert.equal(row.windows.received.bytesPerSecond, 1000);
  const bad = sample(); bad.sent.queryStartedUptimeMs = bad.received.queryStartedUptimeMs;
  assert.throws(() => validateNetworkSample(bad), /query order/);
});

const packetSample = (sequence = 1, rx = '100', tx = '200') => ({...sample(sequence), packets: {
  source: 'TrafficStats.getUidRxPackets/getUidTxPackets',
  received: {rawPackets: rx, availability: 'available', reason: null,
    queryStartedUptimeMs: sequence * 2000 + 4, queryFinishedUptimeMs: sequence * 2000 + 5},
  sent: {rawPackets: tx, availability: 'available', reason: null,
    queryStartedUptimeMs: sequence * 2000 + 6, queryFinishedUptimeMs: sequence * 2000 + 7},
}});
const { NetworkPacketTracker, validateNetworkPackets } = await import('../src/network.ts');

test('packet rates preserve zero and subtract large integers before conversion', () => {
  const tracker = new NetworkPacketTracker(); tracker.record(packetSample(1, '9223372036854775800', '0'));
  const row = tracker.record(packetSample(2, '9223372036854775801', '0'));
  assert.deepEqual(row.windows.received, {deltaPackets:'1',elapsedMs:2000,packetsPerSecond:.5});
  assert.equal(row.windows.sent.packetsPerSecond, 0);
});
test('packet failure, missing fields or wrong units do not break byte accounting', () => {
  for (const change of [undefined, {source:'wrong'}, {...packetSample().packets,
      received:{...packetSample().packets.received,rawPackets:undefined,rawBytes:'100'}}]) {
    const s = {...sample(), packets: change};
    assert.ok(new NetworkTracker().record(s));
    assert.throws(() => new NetworkPacketTracker().record(s));
  }
  const s = packetSample(); s.packets.received = {...s.packets.received,rawPackets:'-1',availability:'unsupported',reason:'api_returned_unsupported'};
  const packets = new NetworkPacketTracker(); packets.record(s);
  assert.equal(packets.record(packetSample(2)).windows.received, null);
  assert.equal(packets.record(packetSample(3)).windows.received.packetsPerSecond, 0);
});
test('packet rollback affects only its own interval and uses the new baseline', () => {
  const tracker = new NetworkPacketTracker(); tracker.record(packetSample());
  const row = tracker.record(packetSample(2, '5', '220'));
  assert.equal(row.resets.received,true); assert.equal(row.windows.received,null);
  assert.equal(row.windows.sent.packetsPerSecond,10);
  assert.equal(tracker.record(packetSample(3, '9', '220')).windows.received.deltaPackets,'4');
});
test('packet windows reset after pause, identity change and invalid order', () => {
  const tracker = new NetworkPacketTracker(); tracker.record(packetSample()); tracker.reset();
  assert.equal(tracker.record(packetSample(2)).windows.sent,null);
  assert.throws(() => tracker.record(packetSample(2)),/out of order/);
  assert.equal(tracker.record(packetSample(3)).windows.sent,null);
  assert.equal(tracker.record({...packetSample(4),observationId:'other'}).windows.sent,null);
});
test('packet query bounds independently define the packet rate', () => {
  const tracker = new NetworkPacketTracker(); tracker.record(packetSample());
  const next = packetSample(2,'104','208');
  next.packets.received.queryStartedUptimeMs += 10; next.packets.received.queryFinishedUptimeMs += 10;
  next.packets.sent.queryStartedUptimeMs += 12; next.packets.sent.queryFinishedUptimeMs += 12;
  const row = tracker.record(next);
  assert.equal(row.windows.received.elapsedMs,2010); assert.equal(row.windows.sent.elapsedMs,2012);
  assert.equal(row.windows.received.packetsPerSecond,4000/2010);
  const bad = packetSample(); bad.packets.received.queryStartedUptimeMs = bad.sent.queryStartedUptimeMs;
  assert.throws(() => validateNetworkPackets(bad),/query order/);
});
test('packet native sentinels and invalid integers retain explicit meaning', () => {
  for (const rawPackets of ['-1','-2','01','1.2','9223372036854775808',1,null]) {
    const s=packetSample(); s.packets.sent.rawPackets=rawPackets;
    assert.throws(() => validateNetworkPackets(s));
  }
  const s=packetSample(); s.packets.sent={...s.packets.sent,rawPackets:null,availability:'error',reason:'SecurityException'};
  assert.equal(validateNetworkPackets(s).sent.availability,'error');
});
