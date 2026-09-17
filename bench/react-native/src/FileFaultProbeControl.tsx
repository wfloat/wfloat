import { useMetricState } from "./useMetricState";
import { useEffect, useRef } from "react";
import { AppState, NativeModules, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { fileFaultDeltas, validateFileFaultResult, type FileFaultResult } from "./fileFaultProbe";
import { pageFaultDefinitions } from "./pageFaults";

export function FileFaultProbe({ workloadRunning, onRunningChange }: {
  workloadRunning: boolean;
  onRunningChange: (running: boolean) => void;
}) {
  const [active, setActive] = useMetricState("FileFaultProbeControl.active", AppState.currentState === "active");
  const [running, setRunning] = useMetricState("FileFaultProbeControl.running", false);
  const [stopping, setStopping] = useMetricState("FileFaultProbeControl.stopping", false);
  const [result, setResult] = useMetricState<FileFaultResult | null>("FileFaultProbeControl.result", null);
  const [error, setError] = useMetricState<string | null>("FileFaultProbeControl.error", null);
  const mounted = useRef(true), busy = useRef(false), cancelled = useRef(false);
  const kind = Platform.OS === "android" ? "android_minor_major" : "ios_vm_events";
  useEffect(() => {
    mounted.current = true;
    setActive(AppState.currentState === "active");
    const subscription = AppState.addEventListener("change", state => {
      setActive(state === "active");
      if (state !== "active" && busy.current) {
        cancelled.current = true;
        setStopping(true);
        void NativeModules.BenchFileFaultProbe?.cancel?.().catch(() => {});
      }
    });
    return () => {
      mounted.current = false;
      cancelled.current = true;
      subscription.remove();
      void NativeModules.BenchFileFaultProbe?.cancel?.().catch(() => {});
    };
  }, []);

  async function run() {
    if (busy.current || workloadRunning || AppState.currentState !== "active") return;
    busy.current = true; cancelled.current = false;
    setRunning(true); setStopping(false); setResult(null); setError(null);
    onRunningChange(true);
    try {
      if (!NativeModules.BenchFileFaultProbe?.run) throw new Error("Native file probe is missing. Rebuild the app.");
      const memory = await NativeModules.BenchMemory.read();
      if (memory.heldBytes > 0) throw new Error("Release the memory check before starting the file probe.");
      if (cancelled.current || AppState.currentState !== "active") throw new Error("File probe cancelled before starting.");
      const value = await NativeModules.BenchFileFaultProbe.run();
      const report = validateFileFaultResult(JSON.parse(value), kind);
      if (mounted.current) setResult(report);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      busy.current = false;
      onRunningChange(false);
      if (mounted.current) { setRunning(false); setStopping(false); }
    }
  }
  async function stop() {
    cancelled.current = true; setStopping(true);
    try { await NativeModules.BenchFileFaultProbe.cancel(); }
    catch (cause) { if (mounted.current) setError(String(cause)); }
  }
  const status = running ? stopping ? "Stopping…" : "Preparing file and reading…" : error ? "Read failed" :
    result?.status === "completed" ? "Completed" : result?.status === "cancelled" ? "Stopped" :
    result?.status === "deadline" ? "Time limit reached" : result?.status === "failed" ? "Read failed" : "Ready";
  return (
    <View style={styles.probe}>
      <Text style={styles.heading}>FILE-BACKED MEMORY CHECK</Text>
      <Text style={styles.body}>Create a 32 MiB temporary file, then read one byte from every page twice.</Text>
      <Pressable accessibilityRole="button" testID="file-fault-probe"
        accessibilityLabel={running ? "Stop file memory check" : "Start file memory check"}
        disabled={stopping || !active || (!running && workloadRunning)}
        onPress={() => void (running ? stop() : run())}
        style={({ pressed }) => [styles.button, (pressed || stopping || !active || (!running && workloadRunning)) && styles.dim]}>
        <Text style={styles.buttonText}>{running ? stopping ? "Stopping…" : "Stop check" : "Run 32 MiB file check"}</Text>
      </Pressable>
      <Text testID="file-fault-probe-status" style={styles.status}>{status}</Text>
      {(error || result?.error) && <Text style={styles.note}>{error ?? result?.error}</Text>}
      {result?.passes.map(pass => {
        const deltas = fileFaultDeltas(pass);
        return <View key={pass.name} style={styles.pass}>
          <Text style={styles.passTitle}>{pass.name === "first_read" ? "First mapped read" : "Immediate reread"}</Text>
          {pageFaultDefinitions[kind].map(({ key, label }) => <Text key={key}
            testID={`file-probe-${pass.name}-${key}`} style={styles.body}>{label}: +{deltas[key].toLocaleString()}</Text>)}
          <Text style={styles.note} testID={`file-probe-${pass.name}-residency`}>
            {pass.residentPagesBefore < 0 ? "Page residency unavailable before this pass." :
              `${pass.residentPagesBefore.toLocaleString()} / ${pass.touchedPages.toLocaleString()} pages resident before this pass.`}
          </Text>
          <Text style={styles.note}>{(pass.readFinishedUptimeMs - pass.readStartedUptimeMs).toFixed(2)} ms traversal · touched bytes verified</Text>
        </View>;
      })}
      {result && <Text style={styles.note}>
        {result.cacheResult === 0 ? "Cache-preparation request succeeded; a cold read is not guaranteed." :
          result.cacheResult > 0 ? `Cache-preparation request failed (code ${result.cacheResult}).` : "Cache preparation was not reached."}
      </Text>}
      <Text style={styles.note}>Counts include other app activity. Zero can reflect caching. Stops on backgrounding or a 30-second budget; pending I/O can delay stopping.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  probe: { borderTopWidth: 1, borderTopColor: "#cbd7d2", marginTop: 16, paddingTop: 16 },
  heading: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359", marginBottom: 8 },
  body: { fontSize: 13, lineHeight: 20, color: "#52665c" },
  note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6 },
  status: { fontSize: 14, fontWeight: "600", color: "#143f32", marginTop: 10 },
  pass: { marginTop: 14 },
  passTitle: { fontSize: 14, fontWeight: "600", color: "#143f32", marginBottom: 4 },
  button: { borderWidth: 1, borderColor: "#86a698", borderRadius: 10, alignItems: "center", padding: 12, marginTop: 14 },
  buttonText: { fontSize: 13, fontWeight: "600", color: "#24533f" },
  dim: { opacity: 0.5 },
});
