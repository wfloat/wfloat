import { useMetricState } from "./useMetricState";
import { useEffect, useRef } from "react";
import { AppState, NativeModules, StyleSheet, Text, View } from "react-native";
import { mebibytes } from "./memory";
import { SystemMemoryTracker, validateSystemLowMemory, validateSystemLowMemoryThreshold,
  type SystemMemorySample, type SystemLowMemoryState, type SystemLowMemoryThreshold } from "./systemMemory";

export function SystemMemoryCard() {
  const tracker = useRef(new SystemMemoryTracker());
  const [reading, setReading] = useMetricState<SystemMemorySample | null>("SystemMemoryCard.reading", null);
  const [error, setError] = useMetricState<string | null>("SystemMemoryCard.error", null);
  const [active, setActive] = useMetricState("SystemMemoryCard.active", AppState.currentState === "active");
  useEffect(() => {
    let mounted = true, foreground = AppState.currentState === "active", pending = false, epoch = 0;
    setActive(foreground);
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function sample() {
      if (!mounted || !foreground || pending) return;
      pending = true;
      const generation = epoch;
      try {
        if (!NativeModules.BenchSystemMemory?.read) throw new Error("Native system memory collector is missing. Rebuild the app.");
        const result = await NativeModules.BenchSystemMemory.read();
        if (!mounted || generation !== epoch) return;
        const next = tracker.current.record(result);
        setReading(next); setError(next.error);
      } catch (cause) {
        if (!mounted || generation !== epoch) return;
        tracker.current.reset(); setReading(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending = false;
        if (mounted && foreground) timer = setTimeout(() => void sample(), generation === epoch ? 2000 : 0);
      }
    }
    tracker.current.reset();
    void sample();
    const subscription = AppState.addEventListener("change", state => {
      ++epoch; foreground = state === "active";
      if (timer !== undefined) clearTimeout(timer);
      setActive(foreground); setReading(null); setError(null); tracker.current.reset();
      if (foreground) void sample();
    });
    return () => {
      mounted = false; ++epoch;
      if (timer !== undefined) clearTimeout(timer);
      subscription.remove(); tracker.current.reset();
    };
  }, []);
  const value = !active ? "Paused" : error ? "Unavailable" : reading?.availableBytes != null
    ? `${mebibytes(reading.availableBytes)} MiB` : "Reading…";
  let low: SystemLowMemoryState | null = null, threshold: SystemLowMemoryThreshold | null = null;
  let lowError = error, thresholdError = error;
  if (reading) {
    try { low = validateSystemLowMemory(reading); lowError = low.error; }
    catch (cause) { lowError = cause instanceof Error ? cause.message : String(cause); }
    try { threshold = validateSystemLowMemoryThreshold(reading); thresholdError = threshold.error; }
    catch (cause) { thresholdError = cause instanceof Error ? cause.message : String(cause); }
  }
  const lowValue = !active ? "Paused" : lowError ? "Unavailable" : low?.value === true
    ? "Low memory" : low?.value === false ? "Not low" : "Reading…";
  const thresholdValue = !active ? "Paused" : thresholdError ? "Unavailable" : threshold?.bytes != null
    ? `${mebibytes(threshold.bytes)} MiB` : "Reading…";
  return <View style={styles.card}>
    <Text style={styles.label}>SYSTEM AVAILABLE MEMORY · ANDROID</Text>
    <Text testID="system-available-memory" accessibilityLabel={`System available memory: ${value}`} style={styles.value}>{value}</Text>
    <Text style={styles.body}>Android’s estimate of available RAM across the whole system.</Text>
    <Text style={styles.note}>Includes reclaimable memory. Other apps and system activity can change this reading.</Text>
    <Text style={styles.note}>This is not an allowance for this app or a guarantee that an allocation will succeed.</Text>
    <View style={styles.additional}>
      <Text style={styles.label}>OS LOW-MEMORY STATE</Text>
      <Text testID="system-low-memory" accessibilityLabel={`OS low-memory state: ${lowValue}`}
        style={[styles.state, low?.value === true && styles.low]}>{lowValue}</Text>
      <Text style={styles.body}>Whether Android currently considers system memory low.</Text>
      {lowError && <Text testID="system-low-memory-error" style={styles.note}>{lowError}</Text>}
      <Text testID="system-low-memory-threshold" style={styles.threshold}>Reported threshold: {thresholdValue}</Text>
      <Text style={styles.note}>OS policy reference · the reported state can switch before this threshold is reached.</Text>
      {thresholdError && <Text testID="system-low-memory-threshold-error" style={styles.note}>{thresholdError}</Text>}
    </View>
    <Text testID="system-memory-status" style={styles.note}>{error ?? (!active
      ? "Sampling resumes when the app is active." : reading
        ? `Read at ${new Date(reading.sampledAtMs).toLocaleTimeString([], { hour12: false })} · refreshes every 2 seconds`
        : "Waiting for a native reading.")}</Text>
  </View>;
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#e9eee8", borderRadius: 20, padding: 20, marginTop: 12 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359" },
  value: { fontSize: 38, fontWeight: "600", letterSpacing: -1, color: "#143f32", marginVertical: 10, fontVariant: ["tabular-nums"] },
  additional: { borderTopWidth: 1, borderTopColor: "#cbd7d2", marginTop: 16, paddingTop: 16, marginBottom: 8 },
  state: { fontSize: 27, fontWeight: "600", color: "#143f32", marginVertical: 8 },
  low: { color: "#9a401e" },
  threshold: { fontSize: 14, fontWeight: "600", color: "#24533f", marginTop: 12, fontVariant: ["tabular-nums"] },
  body: { fontSize: 13, lineHeight: 20, color: "#52665c" },
  note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6 },
});
