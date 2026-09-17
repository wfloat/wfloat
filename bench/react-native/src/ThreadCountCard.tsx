import { threadCountSource } from "./threadSources";
import { useMetricState } from "./useMetricState";
import { useEffect, useRef } from "react";
import { AppState, Platform, StyleSheet, Text, View } from "react-native";
import { ThreadTracker, type ThreadSample } from "./processThreads";

export function ThreadCountCard() {
  const tracker = useRef(new ThreadTracker());
  const [reading, setReading] = useMetricState<ThreadSample | null>("ThreadCountCard.reading", null);
  const [error, setError] = useMetricState<string | null>("ThreadCountCard.error", null);
  const [active, setActive] = useMetricState("ThreadCountCard.active", AppState.currentState === "active");
  useEffect(() => {
    tracker.current.reset();
    const unsubscribe = threadCountSource.subscribe(event => {
      setActive(event.active);
      if (!event.active || event.value === null) {
        tracker.current.reset(); setReading(null); setError(event.error); return;
      }
      try { setReading(tracker.current.record(event.value)); setError(null); }
      catch (cause) { tracker.current.reset(); setReading(null); setError(cause instanceof Error ? cause.message : String(cause)); }
    });
    return () => { unsubscribe(); tracker.current.reset(); };
  }, []);
  const value = !active ? "Paused" : error ? "Read failed" : reading ? reading.threadCount.toLocaleString() : "Reading…";
  return <View style={styles.card}>
    <Text style={styles.label}>APP THREAD COUNT</Text>
    <Text testID="process-thread-count" accessibilityLabel={`App thread count: ${value}`} style={styles.value}>{value}</Text>
    <Text style={styles.body}>Live threads, including idle and waiting threads.</Text>
    <Text style={styles.note}>Includes the UI, runtime, native workers and collectors. This count does not show how many threads are using the CPU.</Text>
    <Text testID="process-thread-status" style={styles.note}>{error ?? (!active
      ? "Sampling resumes when the app is active." : reading
        ? `Read at ${new Date(reading.sampledAtMs).toLocaleTimeString([], { hour12: false })} · refreshes every 2 seconds`
        : "Waiting for a native reading.")}</Text>
  </View>;
}
const styles = StyleSheet.create({
  card: { backgroundColor: "#e9eee8", borderRadius: 20, padding: 20, marginTop: 12 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359" },
  value: { fontSize: 38, fontWeight: "600", letterSpacing: -1, color: "#143f32", marginVertical: 10, fontVariant: ["tabular-nums"] },
  body: { fontSize: 13, lineHeight: 20, color: "#52665c" },
  note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6 },
});
