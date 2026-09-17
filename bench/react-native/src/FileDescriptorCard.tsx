import { useMetricState } from "./useMetricState";
import { useEffect, useRef } from "react";
import { AppState, NativeModules, StyleSheet, Text, View } from "react-native";
import { FileDescriptorTracker, type FileDescriptorSample } from "./fileDescriptors";

export function FileDescriptorCard() {
  const tracker = useRef(new FileDescriptorTracker());
  const [reading, setReading] = useMetricState<FileDescriptorSample | null>("FileDescriptorCard.reading", null);
  const [error, setError] = useMetricState<string | null>("FileDescriptorCard.error", null);
  const [active, setActive] = useMetricState("FileDescriptorCard.active", AppState.currentState === "active");
  useEffect(() => {
    let mounted = true, foreground = AppState.currentState === "active", pending = false, epoch = 0;
    setActive(foreground);
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function sample() {
      if (!mounted || !foreground || pending) return;
      pending = true;
      const generation = epoch;
      try {
        if (!NativeModules.BenchFileDescriptors?.read) throw new Error("Native file-descriptor collector is missing. Rebuild the app.");
        const result = await NativeModules.BenchFileDescriptors.read();
        if (!mounted || generation !== epoch) return;
        setReading(tracker.current.record(JSON.parse(result)));
        setError(null);
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
  const value = !active ? "Paused" : error || reading?.availability === "error" ? "Read failed" : reading ? reading.count!.toLocaleString() : "Reading…";
  return <View style={styles.card}>
    <Text style={styles.label}>APP OPEN FILE DESCRIPTORS</Text>
    <Text testID="process-file-descriptor-count" accessibilityLabel={`App open file descriptors: ${value}`} style={styles.value}>{value}</Text>
    <Text style={styles.body}>Open handles for files, sockets, pipes and other resources.</Text>
    <Text style={styles.note}>Counts this process, including the runtime and collectors. Excludes the temporary handle used for this reading.</Text>
    <Text style={styles.note}>Handles can change while counted. Persistent growth across repeated runs can help identify leaks.</Text>
    <Text testID="process-file-descriptor-status" style={styles.note}>{error ?? reading?.reason ?? (!active
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
