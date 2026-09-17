import { useMetricState } from "./useMetricState";
import { useEffect, useRef } from "react";
import { AppState, NativeModules, Platform, StyleSheet, Text, View } from "react-native";
import { ProcessCpuTracker, type ProcessCpuSample, type ProcessCpuUsage } from "./processCpu";

export function CpuUsageCard() {
  const tracker = useRef(new ProcessCpuTracker());
  const [usage, setUsage] = useMetricState<ProcessCpuUsage | null>("CpuUsageCard.usage", null);
  const [error, setError] = useMetricState<string | null>("CpuUsageCard.error", null);
  const [active, setActive] = useMetricState("CpuUsageCard.active", AppState.currentState === "active");

  useEffect(() => {
    let mounted = true;
    let foreground = AppState.currentState === "active";
    setActive(foreground);
    let epoch = 0;
    let pending = false;

    async function sample() {
      if (!mounted || !foreground || pending) return;
      pending = true;
      const generation = epoch;
      try {
        if (!NativeModules.BenchProcessCpu?.read)
          throw new Error("Native CPU collector is missing. Rebuild the app.");
        const next: ProcessCpuSample = await NativeModules.BenchProcessCpu.read();
        // A delayed bridge response from before backgrounding must not seed
        // the next foreground interval or revive an unmounted component.
        if (!mounted || generation !== epoch) return;
        if (next?.platform !== Platform.OS) throw new Error("Unexpected CPU sample platform");
        setUsage(tracker.current.record(next));
        setError(null);
      } catch (cause) {
        if (!mounted || generation !== epoch) return;
        tracker.current.resetWindow();
        setUsage(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending = false;
      }
    }

    tracker.current.resetWindow();
    void sample();
    const timer = setInterval(() => void sample(), 1000);
    const subscription = AppState.addEventListener("change", (state) => {
      epoch += 1;
      foreground = state === "active";
      setActive(foreground);
      tracker.current.resetWindow();
      setUsage(null);
      setError(null);
      if (foreground) void sample();
    });
    return () => {
      mounted = false;
      epoch += 1;
      clearInterval(timer);
      subscription.remove();
      tracker.current.resetWindow();
    };
  }, []);

  const value = !active ? "Paused" : error ? "Read failed" : usage ? `${usage.percent.toFixed(1)}%` : "Sampling…";
  return (
    <View style={styles.card}>
      <Text style={styles.label}>APP CPU USAGE</Text>
      <Text testID="process-cpu-usage" accessibilityLabel={`App CPU usage: ${value}`} style={styles.value}>
        {value}
      </Text>
      <Text style={styles.body}>100% = one fully occupied core</Text>
      {[
        { key: "user", label: "User", detail: "App and native code", percent: usage?.userPercent },
        { key: "system", label: "Kernel", detail: "OS work charged to this app", percent: usage?.systemPercent },
      ].map(part => <View key={part.key} style={styles.part}>
        <View style={styles.partRow}>
          <Text style={styles.partLabel}>{part.label}</Text>
          <Text testID={`process-cpu-${part.key}-usage`}
            accessibilityLabel={`${part.label} CPU usage: ${usage && active && !error ? `${part.percent!.toFixed(1)}%` : value}`}
            style={styles.partValue}>{usage && active && !error ? `${part.percent!.toFixed(1)}%` : "—"}</Text>
        </View>
        <Text style={styles.body}>{part.detail}</Text>
      </View>)}
      <Text style={styles.note}>All app threads, including the UI and workload.</Text>
      <Text testID="process-cpu-breakdown-window" style={styles.note}>
        {usage && active && !error ? `${usage.userDeltaMs.toFixed(1)} ms user + ${usage.systemDeltaMs.toFixed(1)} ms kernel in this interval.` : ""}
      </Text>
      <Text testID="process-cpu-window" style={styles.note}>
        {error ?? (usage
          ? `${usage.cpuDeltaMs.toFixed(0)} ms CPU / ${(usage.elapsedMs / 1000).toFixed(2)} s elapsed · read at ${new Date(usage.current.sampledAtMs).toLocaleTimeString([], { hour12: false })}`
          : active ? "Waiting for two native samples." : "Sampling resumes when the app is active.")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#e9eee8", borderRadius: 20, padding: 20, marginTop: 12 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359" },
  value: { fontSize: 38, fontWeight: "600", letterSpacing: -1, color: "#143f32", marginVertical: 10 },
  body: { fontSize: 13, lineHeight: 20, color: "#52665c" },
  part: { marginTop: 14 },
  partRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  partLabel: { fontSize: 14, fontWeight: "600", color: "#143f32" },
  partValue: { fontSize: 22, fontWeight: "600", color: "#143f32", fontVariant: ["tabular-nums"] },
  note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6 },
});
