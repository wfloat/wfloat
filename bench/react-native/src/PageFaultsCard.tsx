import { useMetricState } from "./useMetricState";
import { useEffect, useRef } from "react";
import { AppState, NativeModules, Platform, StyleSheet, Text, View } from "react-native";
import { PageFaultTracker, pageFaultDefinitions, type PageFaultReading } from "./pageFaults";
import { FileFaultProbe } from "./FileFaultProbeControl";

export function PageFaultsCard({ workloadRunning, onProbeRunningChange }: {
  workloadRunning: boolean;
  onProbeRunningChange: (running: boolean) => void;
}) {
  const tracker = useRef(new PageFaultTracker());
  const [reading, setReading] = useMetricState<PageFaultReading | null>("PageFaultsCard.reading", null);
  const [error, setError] = useMetricState<string | null>("PageFaultsCard.error", null);
  const [active, setActive] = useMetricState("PageFaultsCard.active", AppState.currentState === "active");
  const expectedKind = Platform.OS === "android" ? "android_minor_major" : "ios_vm_events";

  useEffect(() => {
    let mounted = true;
    let foreground = AppState.currentState === "active";
    setActive(foreground);
    let epoch = 0;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function sample() {
      if (!mounted || !foreground || pending) return;
      pending = true;
      const generation = epoch;
      try {
        if (!NativeModules.BenchPageFaults?.read)
          throw new Error("Native page-fault collector is missing. Rebuild the app.");
        const result = await NativeModules.BenchPageFaults.read();
        if (!mounted || generation !== epoch) return;
        if (result?.kind !== expectedKind) throw new Error("Unexpected platform page-fault counters");
        setReading(tracker.current.record(result));
        setError(null);
      } catch (cause) {
        if (!mounted || generation !== epoch) return;
        tracker.current.resetWindow();
        setReading(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending = false;
        if (mounted && foreground) timer = setTimeout(() => void sample(), generation === epoch ? 2000 : 0);
      }
    }
    tracker.current.resetWindow();
    void sample();
    const subscription = AppState.addEventListener("change", state => {
      ++epoch;
      foreground = state === "active";
      if (timer !== undefined) clearTimeout(timer);
      setActive(foreground);
      tracker.current.resetWindow();
      setReading(null);
      setError(null);
      if (foreground) void sample();
    });
    return () => {
      mounted = false;
      ++epoch;
      if (timer !== undefined) clearTimeout(timer);
      subscription.remove();
      tracker.current.resetWindow();
    };
  }, [expectedKind]);

  return (
    <View style={styles.card}>
      <Text style={styles.label}>APP PAGE-FAULT ACTIVITY · {Platform.OS === "android" ? "ANDROID" : "iOS"}</Text>
      <Text style={styles.body}>Memory events handled by the OS, not app errors.</Text>
      {pageFaultDefinitions[expectedKind].map(({ key, label, detail }) => {
        const rate = !active ? "Paused" : error ? "Read failed" : reading?.window
          ? `${reading.window.perSecond[key].toFixed(1)} /s` : "Sampling…";
        return (
          <View key={key} style={styles.counter}>
            <Text style={styles.counterLabel}>{label}</Text>
            <Text testID={`page-faults-${key}-rate`} accessibilityLabel={`${label}: ${rate}`} style={styles.value}>{rate}</Text>
            <Text testID={`page-faults-${key}-total`} style={styles.body}>
              {reading ? `${reading.sample.counters[key].toLocaleString()} total since process start` : "Waiting for native counters."}
            </Text>
            <Text style={styles.note}>{detail}</Text>
          </View>
        );
      })}
      <Text testID="page-faults-window" style={styles.note}>
        {error ?? (!active ? "Sampling resumes when the app is active." : reading?.window
          ? `${pageFaultDefinitions[expectedKind].map(({ key }) => reading.window!.deltas[key]).join(" / ")} events over ${(reading.window.elapsedMs / 1000).toFixed(2)} s · ${reading.sample.pageSizeBytes / 1024} KiB system pages`
          : "Rates need two samples from the foreground app.")}
      </Text>
      <Text style={styles.note}>All app threads, including collection. Counts do not measure stall time or bytes read.</Text>
      <FileFaultProbe workloadRunning={workloadRunning} onRunningChange={onProbeRunningChange} />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#e8ecec", borderRadius: 20, padding: 20, marginTop: 12 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359", marginBottom: 8 },
  counter: { marginTop: 16 },
  counterLabel: { fontSize: 14, fontWeight: "600", color: "#143f32" },
  value: { fontSize: 30, fontWeight: "600", color: "#143f32", marginVertical: 4, fontVariant: ["tabular-nums"] },
  body: { fontSize: 13, lineHeight: 20, color: "#52665c" },
  note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6 },
});
