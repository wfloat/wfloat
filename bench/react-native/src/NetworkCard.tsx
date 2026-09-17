import { useEffect, useRef } from 'react';
import { AppState, NativeModules, StyleSheet, Text, View } from 'react-native';
import { useMetricState } from './useMetricState';
import { NetworkTracker, NetworkPacketTracker, networkDirections, networkMiB, type NetworkReading, type NetworkPacketReading } from './network';

export function NetworkCard() {
  const tracker = useRef(new NetworkTracker());
  const packetTracker = useRef(new NetworkPacketTracker());
  const [reading, setReading] = useMetricState<NetworkReading | null>('NetworkCard.reading', null);
  const [error, setError] = useMetricState<string | null>('NetworkCard.error', null);
  const [packets, setPackets] = useMetricState<NetworkPacketReading | null>('NetworkCard.packets', null);
  const [packetError, setPacketError] = useMetricState<string | null>('NetworkCard.packetError', null);
  const [active, setActive] = useMetricState('NetworkCard.active', AppState.currentState === 'active');
  useEffect(() => {
    let mounted = true, foreground = AppState.currentState === 'active', pending = false, epoch = 0;
    setActive(foreground);
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function sample() {
      if (!mounted || !foreground || pending) return;
      pending = true;
      const generation = epoch;
      try {
        if (!NativeModules.BenchNetwork?.read) throw new Error('Native network collector is missing. Rebuild the app.');
        const result = JSON.parse(await NativeModules.BenchNetwork.read());
        if (!mounted || generation !== epoch) return;
        setReading(tracker.current.record(result)); setError(null);
        try { setPackets(packetTracker.current.record(result)); setPacketError(null); }
        catch (cause) {
          packetTracker.current.reset(); setPackets(null);
          setPacketError(cause instanceof Error ? cause.message : String(cause));
        }
      } catch (cause) {
        if (!mounted || generation !== epoch) return;
        tracker.current.reset(); setReading(null);
        packetTracker.current.reset(); setPackets(null); setPacketError(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending = false;
        if (mounted && foreground) timer = setTimeout(() => void sample(), generation === epoch ? 2000 : 0);
      }
    }
    tracker.current.reset(); packetTracker.current.reset(); void sample();
    const subscription = AppState.addEventListener('change', state => {
      ++epoch; foreground = state === 'active';
      if (timer !== undefined) clearTimeout(timer);
      setActive(foreground); setReading(null); setError(null); tracker.current.reset();
      setPackets(null); setPacketError(null); packetTracker.current.reset();
      if (foreground) void sample();
    });
    return () => {
      mounted = false; ++epoch;
      if (timer !== undefined) clearTimeout(timer);
      subscription.remove(); tracker.current.reset(); packetTracker.current.reset();
    };
  }, []);
  return <View style={styles.card}>
    <Text style={styles.label}>APP NETWORK TRAFFIC · ANDROID</Text>
    <Text style={styles.body}>Bytes and packets charged to this app’s Android UID, across interfaces and app processes.</Text>
    {networkDirections.map(direction => {
      const counter = reading?.sample[direction], window = reading?.windows[direction];
      const packet = packets?.counters[direction], packetWindow = packets?.windows[direction];
      const label = direction === 'received' ? 'Received' : 'Sent';
      const value = !active ? 'Paused' : error ? 'Read failed' : counter?.availability === 'unsupported' ? 'Unsupported'
        : counter?.availability === 'error' ? 'Read failed' : window ? `${(window.bytesPerSecond / 1024).toFixed(2)} KiB/s` : 'Sampling…';
      const packetValue = !active ? 'Paused' : error || packetError ? 'Unavailable' : packet?.availability === 'unsupported' ? 'Unsupported'
        : packet?.availability === 'error' ? 'Read failed' : packetWindow ? `${packetWindow.packetsPerSecond.toFixed(2)} packets/s` : 'Sampling…';
      return <View key={direction} style={styles.counter}>
        <Text style={styles.counterLabel}>{label}</Text>
        <Text testID={`network-${direction}-rate`} accessibilityLabel={`Network ${label}: ${value}`} style={styles.value}>{value}</Text>
        <Text testID={`network-${direction}-total`} style={styles.body}>{counter?.availability === 'available'
          ? `${networkMiB(counter.rawBytes!)} MiB · UID total since device boot` : counter?.reason ?? 'Waiting for native counters.'}</Text>
        <Text style={styles.note}>{reading?.resets[direction] ? 'Counter decreased; starting a fresh interval.' : window
          ? `Average over ${(window.elapsedMs / 1000).toFixed(2)} s` : 'Rate needs two available foreground readings.'}</Text>
        <Text testID={`network-${direction}-packet-rate`} accessibilityLabel={`Network ${label} packets: ${packetValue}`} style={styles.packetValue}>{packetValue}</Text>
        <Text testID={`network-${direction}-packet-total`} style={styles.body}>{packet?.availability === 'available'
          ? `${packet.rawPackets!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')} packets · UID total since device boot`
          : packetError ?? packet?.reason ?? 'Waiting for packet counters.'}</Text>
        <Text style={styles.note}>{packets?.resets[direction] ? 'Packet counter decreased; starting a fresh interval.' : packetWindow
          ? `Packet average over ${(packetWindow.elapsedMs / 1000).toFixed(2)} s` : 'Packet rate needs two available foreground readings.'}</Text>
      </View>;
    })}
    <Text style={styles.note}>Includes protocol overhead and other traffic charged to this UID. Downloaded file sizes can differ. Cached downloads may add no traffic.</Text>
    <Text style={styles.note}>Packets are OS network accounting units, not requests or socket writes. Packet and byte reads have separate timing.</Text>
    <Text style={styles.note}>These rates show observed app traffic, not connection capacity. OS accounting may lag; refreshing does not guarantee new data.</Text>
    {__DEV__ && <Text style={styles.note}>Development build: Metro and debugging traffic can contribute.</Text>}
    <Text testID="network-status" style={styles.note}>{error ?? (!active ? 'Sampling resumes when the app is active.'
      : reading ? `UID ${reading.sample.uid} · refreshes about every 2 seconds` : 'Waiting for a native reading.')}</Text>
  </View>;
}
const styles = StyleSheet.create({
  card: { backgroundColor: '#e9eee8', borderRadius: 20, padding: 20, marginTop: 12 },
  label: { fontSize: 11, fontWeight: '700', letterSpacing: 1.2, color: '#496359', marginBottom: 8 },
  counter: { marginTop: 14 }, counterLabel: { fontSize: 14, fontWeight: '600', color: '#143f32' },
  value: { fontSize: 30, fontWeight: '600', color: '#143f32', marginVertical: 4, fontVariant: ['tabular-nums'] },
  packetValue: { fontSize: 22, fontWeight: '600', color: '#143f32', marginTop: 12, marginBottom: 4, fontVariant: ['tabular-nums'] },
  body: { fontSize: 13, lineHeight: 20, color: '#52665c' }, note: { fontSize: 12, lineHeight: 18, color: '#52665c', marginTop: 6 },
});
