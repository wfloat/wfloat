import { useMetricState } from "./useMetricState";
import { useEffect, useRef } from "react";
import { AppState, NativeModules, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { ContextSwitchTracker, type ContextSwitchSample, type ContextSwitchRate } from "./contextSwitches";

export function ContextSwitchCard({ workloadRunning, onProbeRunningChange }: {
  workloadRunning: boolean; onProbeRunningChange: (running: boolean) => void;
}) {
  const tracker = useRef(new ContextSwitchTracker());
  const [sample, setSample] = useMetricState<ContextSwitchSample | null>("ContextSwitchCard.sample", null);
  const [rate, setRate] = useMetricState<ContextSwitchRate | null>("ContextSwitchCard.rate", null);
  const [error, setError] = useMetricState<string | null>("ContextSwitchCard.error", null);
  const [probeError, setProbeError] = useMetricState<string | null>("ContextSwitchCard.probeError", null);
  const [probeRunning, setProbeRunning] = useMetricState("ContextSwitchCard.probeRunning", false);
  const [changingProbe, setChangingProbe] = useMetricState("ContextSwitchCard.changingProbe", false);
  const [active, setActive] = useMetricState("ContextSwitchCard.active", AppState.currentState === "active");
  const refresh = useRef<() => void>(() => {});
  const lifecycle = useRef({ mounted: true, epoch: 0 });
  useEffect(() => {
    let mounted = true, foreground = AppState.currentState === "active", pending = false, epoch = 0;
    setActive(foreground);
    let timer: ReturnType<typeof setTimeout> | undefined;
    lifecycle.current.mounted = true;
    async function read() {
      if (!mounted || !foreground || pending) return;
      if (timer !== undefined) clearTimeout(timer);
      pending = true;
      const generation = epoch;
      try {
        if (!NativeModules.BenchContextSwitches?.read) throw new Error("Native context-switch collector is missing. Rebuild the app.");
        const raw = await NativeModules.BenchContextSwitches.read();
        if (!mounted || generation !== epoch) return;
        if (raw?.platform !== Platform.OS) throw new Error("Unexpected context-switch platform");
        const result = tracker.current.record(raw);
        setSample(result.sample); setRate(result.rate); setError(null);
        setProbeRunning(result.sample.probe.running); onProbeRunningChange(result.sample.probe.running);
      } catch (cause) {
        if (!mounted || generation !== epoch) return;
        tracker.current.resetWindow(); setSample(null); setRate(null);
        setError(cause instanceof Error ? cause.message : String(cause));
        // A failed reading must not strand the optional diagnostic worker.
        void NativeModules.BenchContextSwitches?.stopProbe?.().catch(() => {});
        setProbeRunning(false); onProbeRunningChange(false);
      } finally {
        pending = false;
        if (mounted && foreground) timer = setTimeout(() => void read(), generation === epoch ? 2000 : 0);
      }
    }
    refresh.current = () => void read();
    tracker.current.resetWindow(); void read();
    const subscription = AppState.addEventListener("change", state => {
      ++epoch; ++lifecycle.current.epoch; foreground = state === "active";
      if (timer !== undefined) clearTimeout(timer);
      tracker.current.resetWindow(); setSample(null); setRate(null); setError(null);
      setActive(foreground); setProbeRunning(false); onProbeRunningChange(false);
      if (foreground) void read();
    });
    return () => {
      mounted = false; ++epoch; lifecycle.current.mounted = false; ++lifecycle.current.epoch;
      if (timer !== undefined) clearTimeout(timer);
      subscription.remove(); tracker.current.resetWindow();
      void NativeModules.BenchContextSwitches?.stopProbe?.().catch(() => {});
      onProbeRunningChange(false);
    };
  }, [onProbeRunningChange]);

  async function toggleProbe() {
    const generation = lifecycle.current.epoch;
    setChangingProbe(true); setProbeError(null);
    try {
      if (probeRunning) await NativeModules.BenchContextSwitches.stopProbe();
      else await NativeModules.BenchContextSwitches.startProbe();
      if (!lifecycle.current.mounted || generation !== lifecycle.current.epoch) return;
      if (!probeRunning) { setProbeRunning(true); onProbeRunningChange(true); }
      refresh.current();
    } catch (cause) {
      if (lifecycle.current.mounted && generation === lifecycle.current.epoch)
        setProbeError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (lifecycle.current.mounted) setChangingProbe(false); }
  }
  const value = !active ? "Paused" : error ? "Read failed" : rate ? `${rate.perSecond.toFixed(1)} /s` : "Sampling…";
  return <View style={styles.card}>
    <Text style={styles.label}>APP CONTEXT SWITCHES</Text>
    <Text testID="context-switch-rate" accessibilityLabel={`App context switches: ${value}`} style={styles.value}>{value}</Text>
    <Text style={styles.body}>Scheduling events across all app threads.</Text>
    <Text testID="context-switch-total" style={styles.note}>{sample ? `${sample.counters.total.toLocaleString()} total since process start` : "Waiting for a native reading."}</Text>
    {Platform.OS === "android" ? <>
      <View style={styles.row}><Text style={styles.part}>Voluntary</Text><Text testID="context-switch-voluntary" style={styles.part}>{rate ? `${rate.voluntaryPerSecond!.toFixed(1)} /s` : "—"}</Text></View>
      <Text style={styles.note}>Usually gives up the CPU to wait for a resource.</Text>
      <View style={styles.row}><Text style={styles.part}>Involuntary</Text><Text testID="context-switch-involuntary" style={styles.part}>{rate ? `${rate.involuntaryPerSecond!.toFixed(1)} /s` : "—"}</Text></View>
      <Text style={styles.note}>Preempted, for example when its time slice expires.</Text>
    </> : <Text style={styles.note}>iOS total. Android’s separate categories are not shown here.</Text>}
    <Text style={styles.note}>Counts events, not time waiting or the cost of switching. A high rate alone does not establish a problem.</Text>
    <Text testID="context-switch-window" style={styles.note}>{error ?? (!active ? "Sampling resumes when the app is active." : rate
      ? `${rate.delta.toLocaleString()} events / ${(rate.elapsedMs / 1000).toFixed(2)} s · read at ${new Date(rate.current.sampledAtMs).toLocaleTimeString([], { hour12: false })}`
      : "Waiting for two native samples.")} · refreshes every 2 seconds</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={probeRunning ? "Stop wait/wake check" : "Run 10 second wait/wake check"}
      testID="context-switch-probe" disabled={!active || changingProbe || (!probeRunning && (workloadRunning || !!error || !sample))}
      onPress={() => void toggleProbe()} style={({ pressed }) => [styles.button, { opacity: pressed ? 0.6 : !active || changingProbe || (!probeRunning && (workloadRunning || !!error || !sample)) ? 0.4 : 1 }]}>
      <Text style={styles.part}>{probeRunning ? "Stop wait/wake check" : "Run 10 s wait/wake check"}</Text>
    </Pressable>
    <Text testID="context-switch-probe-state" style={styles.note}>{probeError ?? (probeRunning ? "Running" : sample?.probe.runSequence ? "Finished" : "Ready")}
      {sample?.probe.runSequence ? ` · ${sample.probe.wakes.toLocaleString()} completed waits · ${(sample.probe.elapsedMs / 1000).toFixed(1)} s` : ""}</Text>
    <Text style={styles.note}>One native worker repeatedly sleeps for at least 1 ms. Stops after 10 seconds, on Stop, or when backgrounded. Wait count is separate from context-switch count.</Text>
  </View>;
}
const styles = StyleSheet.create({
  card: { backgroundColor: "#e9eee8", borderRadius: 20, padding: 20, marginTop: 12 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359" },
  value: { fontSize: 38, fontWeight: "600", letterSpacing: -1, color: "#143f32", marginVertical: 10, fontVariant: ["tabular-nums"] },
  body: { fontSize: 13, lineHeight: 20, color: "#52665c" },
  note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6 },
  part: { fontSize: 14, fontWeight: "600", color: "#143f32", fontVariant: ["tabular-nums"] },
  row: { flexDirection: "row", justifyContent: "space-between", marginTop: 12 },
  button: { borderWidth: 1, borderColor: "#9bb7ac", borderRadius: 10, padding: 14, alignItems: "center", marginTop: 16 },
});
