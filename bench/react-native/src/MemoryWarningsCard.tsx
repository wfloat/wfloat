import { useMetricState } from "./useMetricState";
import {useEffect, useRef} from "react";
import {AppState, NativeEventEmitter, NativeModules, StyleSheet, Text, View} from "react-native";
import {MemoryWarningTracker, type MemoryWarningSnapshot} from "./memoryWarnings";

const time = (ms: number) => new Date(ms).toLocaleTimeString([], {hour12: false});

export function MemoryWarningsCard() {
  const tracker = useRef(new MemoryWarningTracker());
  const [snapshot, setSnapshot] = useMetricState<MemoryWarningSnapshot | null>("MemoryWarningsCard.snapshot", null);
  const [error, setError] = useMetricState<string | null>("MemoryWarningsCard.error", null);
  useEffect(() => {
    let mounted = true, accepted = 0;
    function accept(value: unknown) {
      if (!mounted) return;
      try {
        const next = tracker.current.record(value);
        ++accepted; setSnapshot(next); setError(null);
      } catch (cause) {
        setSnapshot(null); setError(cause instanceof Error ? cause.message : String(cause));
      }
    }
    try {
      const native = NativeModules.BenchMemoryWarnings;
      if (!native?.read) throw new Error("Native memory-warning observer is missing. Rebuild the app.");
      const emitter = new NativeEventEmitter(native);
      const events = emitter.addListener("WfloatMemoryWarning", accept);
      async function refresh() {
        const version = accepted;
        try { accept(await native.read()); }
        catch (cause) {
          if (mounted && version === accepted) {
            setSnapshot(null); setError(cause instanceof Error ? cause.message : String(cause));
          }
        }
      }
      const appState = AppState.addEventListener("change", state => { if (state === "active") void refresh(); });
      void refresh();
      return () => { mounted = false; events.remove(); appState.remove(); };
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return () => { mounted = false; };
    }
  }, []);
  const value = error ? "Unavailable" : snapshot ? String(snapshot.warningCount) : "Connecting…";
  return <View style={styles.card}>
    <Text style={styles.label}>MEMORY WARNINGS RECEIVED · iOS</Text>
    <Text testID="memory-warning-count" accessibilityLabel={`Memory warnings received: ${value}`} style={styles.value}>{value}</Text>
    <Text style={styles.body}>Warnings delivered to this app by iOS.</Text>
    <Text testID="memory-warning-last" style={styles.note}>{snapshot?.lastWarning
      ? `Last received at ${time(snapshot.lastWarning.receivedAtMs)} · app ${snapshot.lastWarning.applicationState}`
      : snapshot ? "No warnings observed." : "Waiting for the native observer."}</Text>
    {snapshot && <Text testID="memory-warning-observation" style={styles.note}>Observed since {time(snapshot.observationStartedAtMs)} · this app launch</Text>}
    <Text style={styles.note}>A count of zero does not establish that memory pressure is absent. Warnings do not include a numeric threshold or an all-clear event.</Text>
    <Text style={styles.note}>Updates when a warning arrives. Count survives background/resume and resets on app relaunch.</Text>
    {snapshot?.environment === "simulator" && <Text style={styles.note}>Simulator · warnings can be triggered by the simulator’s test controls.</Text>}
    {error && <Text testID="memory-warning-error" style={styles.note}>{error}</Text>}
  </View>;
}

const styles = StyleSheet.create({
  card: {backgroundColor: "#e9eee8", borderRadius: 20, padding: 20, marginTop: 12},
  label: {fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359"},
  value: {fontSize: 38, fontWeight: "600", letterSpacing: -1, color: "#143f32", marginVertical: 10, fontVariant: ["tabular-nums"]},
  body: {fontSize: 13, lineHeight: 20, color: "#52665c"},
  note: {fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6},
});
