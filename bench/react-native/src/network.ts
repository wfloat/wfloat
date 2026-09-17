export const networkDirections = ['received', 'sent'] as const;
export type NetworkDirection = typeof networkDirections[number];
export type NetworkCounter = {
  rawBytes: string | null;
  availability: 'available' | 'unsupported' | 'error';
  reason: string | null;
  queryStartedUptimeMs: number;
  queryFinishedUptimeMs: number;
};
export type NetworkPacketCounter = Omit<NetworkCounter, 'rawBytes'> & { rawPackets: string | null };
export type NetworkPackets = {
  source: 'TrafficStats.getUidRxPackets/getUidTxPackets';
  received: NetworkPacketCounter; sent: NetworkPacketCounter;
};
export type NetworkSample = {
  platform: 'android'; source: 'TrafficStats.getUidRxBytes/getUidTxBytes';
  scope: 'calling_uid_since_boot'; uid: number; processId: number; observationId: string; sequence: number;
  osVersion: string; apiLevel: number; buildFingerprint: string; debugBuild: boolean;
  clockSource: 'SystemClock.elapsedRealtimeNanos'; sourceSampledAtMs: null; sampledAtMs: number;
  received: NetworkCounter; sent: NetworkCounter;
  packets?: NetworkPackets;
};
export type NetworkWindow = { deltaBytes: string; elapsedMs: number; bytesPerSecond: number };
export type NetworkReading = { sample: NetworkSample; windows: Record<NetworkDirection, NetworkWindow | null>;
  resets: Record<NetworkDirection, boolean> };

function validateCounter(counter: Omit<NetworkCounter, 'rawBytes'>, rawValue: string | null) {
  if (!counter || ![counter.queryStartedUptimeMs, counter.queryFinishedUptimeMs].every(n => Number.isFinite(n) && n >= 0) ||
      counter.queryFinishedUptimeMs < counter.queryStartedUptimeMs)
    throw new Error('Invalid network query timing');
  if (rawValue !== null && (typeof rawValue !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(rawValue) ||
      BigInt(rawValue) < -9223372036854775808n || BigInt(rawValue) > 9223372036854775807n))
    throw new Error('Invalid native network integer');
  const raw = rawValue === null ? null : BigInt(rawValue);
  if (counter.availability === 'available' ? raw === null || raw < 0n || counter.reason !== null
    : counter.availability === 'unsupported' ? raw !== -1n || counter.reason !== 'api_returned_unsupported'
    : counter.availability === 'error' ? (raw !== null && raw >= -1n) || typeof counter.reason !== 'string' || !counter.reason.trim()
    : true) throw new Error('Invalid network availability');
}
export function validateNetworkSample(value: unknown): NetworkSample {
  const s = value as NetworkSample;
  if (!s || s.platform !== 'android' || s.source !== 'TrafficStats.getUidRxBytes/getUidTxBytes' ||
      s.scope !== 'calling_uid_since_boot' || s.clockSource !== 'SystemClock.elapsedRealtimeNanos' || s.sourceSampledAtMs !== null ||
      ![s.uid, s.processId, s.sequence, s.apiLevel].every(n => Number.isSafeInteger(n) && n > 0) || s.apiLevel < 24 ||
      ![s.observationId, s.osVersion, s.buildFingerprint].every(v => typeof v === 'string' && v.trim()) ||
      typeof s.debugBuild !== 'boolean' || !Number.isFinite(s.sampledAtMs) || s.sampledAtMs <= 0)
    throw new Error('Invalid network source or sample identity');
  for (const direction of networkDirections) validateCounter(s[direction], s[direction]?.rawBytes);
  if (s.sent.queryStartedUptimeMs < s.received.queryFinishedUptimeMs) throw new Error('Invalid network query order');
  return s;
}
const midpoint = (c: Omit<NetworkCounter, 'rawBytes'>) => c.queryStartedUptimeMs + (c.queryFinishedUptimeMs - c.queryStartedUptimeMs) / 2;
const sameIdentity = (a: NetworkSample, b: NetworkSample) => a.observationId === b.observationId && a.uid === b.uid &&
  a.processId === b.processId && a.buildFingerprint === b.buildFingerprint && a.apiLevel === b.apiLevel &&
  a.osVersion === b.osVersion && a.debugBuild === b.debugBuild;
export class NetworkTracker {
  private previous: NetworkSample | null = null;
  reset() { this.previous = null; }
  record(value: unknown): NetworkReading {
    try {
      const sample = validateNetworkSample(value), previous = this.previous;
      const windows: NetworkReading['windows'] = { received: null, sent: null };
      const resets = { received: false, sent: false };
      if (previous && sameIdentity(previous, sample)) {
        if (sample.sequence <= previous.sequence || sample.received.queryStartedUptimeMs < previous.sent.queryFinishedUptimeMs)
          throw new Error('Network samples are out of order');
        for (const direction of networkDirections) {
          const before = previous[direction], after = sample[direction];
          if (before.availability !== 'available' || after.availability !== 'available') continue;
          // Subtract native integers before conversion, preserving small changes in large totals.
          const delta = BigInt(after.rawBytes!) - BigInt(before.rawBytes!);
          if (delta < 0n) { resets[direction] = true; continue; }
          const elapsedMs = midpoint(after) - midpoint(before);
          const bytesPerSecond = Number(delta) * 1000 / elapsedMs;
          if (delta > BigInt(Number.MAX_SAFE_INTEGER) || elapsedMs <= 0 || !Number.isFinite(bytesPerSecond))
            throw new Error('Network interval cannot be represented reliably');
          windows[direction] = { deltaBytes: delta.toString(), elapsedMs, bytesPerSecond };
        }
      }
      this.previous = sample;
      return { sample, windows, resets };
    } catch (error) { this.reset(); throw error; }
  }
}

export type NetworkPacketWindow = { deltaPackets: string; elapsedMs: number; packetsPerSecond: number };
export type NetworkPacketReading = { counters: NetworkPackets; windows: Record<NetworkDirection, NetworkPacketWindow | null>;
  resets: Record<NetworkDirection, boolean> };
// Additive validation: old rows and packet-only failures leave byte accounting usable.
export function validateNetworkPackets(sample: NetworkSample): NetworkPackets {
  validateNetworkSample(sample);
  const packets = sample.packets;
  if (!packets || packets.source !== 'TrafficStats.getUidRxPackets/getUidTxPackets')
    throw new Error('Packet counters are missing or have an invalid source. Rebuild the app if needed.');
  for (const direction of networkDirections) validateCounter(packets[direction], packets[direction]?.rawPackets);
  if (packets.received.queryStartedUptimeMs < sample.sent.queryFinishedUptimeMs ||
      packets.sent.queryStartedUptimeMs < packets.received.queryFinishedUptimeMs)
    throw new Error('Invalid packet query order');
  return packets;
}
export class NetworkPacketTracker {
  private previous: NetworkSample | null = null;
  reset() { this.previous = null; }
  record(value: unknown): NetworkPacketReading {
    try {
      const sample = validateNetworkSample(value), packets = validateNetworkPackets(sample), previous = this.previous;
      const windows: NetworkPacketReading['windows'] = { received: null, sent: null };
      const resets = { received: false, sent: false };
      if (previous && sameIdentity(previous, sample)) {
        if (sample.sequence <= previous.sequence || sample.received.queryStartedUptimeMs < previous.packets!.sent.queryFinishedUptimeMs)
          throw new Error('Packet samples are out of order');
        for (const direction of networkDirections) {
          const before = previous.packets![direction], after = packets[direction];
          if (before.availability !== 'available' || after.availability !== 'available') continue;
          const delta = BigInt(after.rawPackets!) - BigInt(before.rawPackets!);
          if (delta < 0n) { resets[direction] = true; continue; }
          const elapsedMs = midpoint(after) - midpoint(before);
          const packetsPerSecond = Number(delta) * 1000 / elapsedMs;
          if (delta > BigInt(Number.MAX_SAFE_INTEGER) || elapsedMs <= 0 || !Number.isFinite(packetsPerSecond))
            throw new Error('Packet interval cannot be represented reliably');
          windows[direction] = { deltaPackets: delta.toString(), elapsedMs, packetsPerSecond };
        }
      }
      this.previous = sample;
      return { counters: packets, windows, resets };
    } catch (error) { this.reset(); throw error; }
  }
}
// Preserve integer precision when formatting even an unusually large OS total.
export function networkMiB(raw: string): string {
  const hundredths = (BigInt(raw) * 100n + 524288n) / 1048576n;
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, '0')}`;
}
