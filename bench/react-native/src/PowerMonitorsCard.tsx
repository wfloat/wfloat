import { useEffect, useRef } from "react";
import { AppState, NativeModules, Pressable, StyleSheet, Text, View } from "react-native";
import { useMetricState } from "./useMetricState";
import { energyReadNote, validateEnergyRead, type EnergyRead } from "./powerMonitors";

export function PowerMonitorsCard({ emulated = false }: { emulated?: boolean }) {
  const [reading, setReading] = useMetricState<EnergyRead | null>("PowerMonitorsCard.reading", null);
  const [error, setError] = useMetricState<string | null>("PowerMonitorsCard.error", null);
  const [busy, setBusy] = useMetricState("PowerMonitorsCard.busy", false);
  const [expanded, setExpanded] = useMetricState("PowerMonitorsCard.expanded", false);
  const [active, setActive] = useMetricState("PowerMonitorsCard.active", AppState.currentState === "active");
  const lifecycle = useRef({ mounted: false, foreground: AppState.currentState === "active", epoch: 0, pending: false });
  useEffect(() => {
    const state = lifecycle.current;
    state.mounted = true;
    state.foreground = AppState.currentState === "active";
    setActive(state.foreground);
    const listener = AppState.addEventListener("change", status => {
      state.epoch++; state.foreground = status === "active"; state.pending = false;
      setActive(state.foreground); setBusy(false); setReading(null); setError(null);
    });
    return () => { state.mounted = false; state.epoch++; listener.remove(); };
  }, []);
  async function read() {
    const state = lifecycle.current;
    if (!state.mounted || !state.foreground || state.pending) return;
    const epoch = state.epoch;
    state.pending = true; setBusy(true); setError(null); setReading(null);
    try {
      if (!NativeModules.BenchPowerMonitors?.read) throw new Error("Rebuild the app to include energy monitors.");
      const next = validateEnergyRead(await NativeModules.BenchPowerMonitors.read());
      if (state.mounted && state.foreground && state.epoch === epoch) setReading(next);
    } catch (cause) {
      if (state.mounted && state.foreground && state.epoch === epoch)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (state.mounted && state.epoch === epoch) { state.pending = false; setBusy(false); }
    }
  }
  const rows = reading?.monitors ?? [];
  return <View style={styles.card}>
    <Text style={styles.label}>ENERGY MONITORS · ANDROID</Text>
    <Text style={styles.body}>Cumulative energy since boot · includes plugged-in use</Text>
    {emulated && <Text style={styles.note}>Emulator · values do not measure physical phone energy.</Text>}
    <Pressable accessibilityRole="button" accessibilityLabel="Read energy monitors" testID="read-energy-monitors"
      disabled={!active || busy} onPress={() => void read()} style={[styles.button, (!active || busy) && { opacity: 0.5 }]}>
      <Text style={styles.buttonText}>{busy ? "Reading…" : "Read energy monitors"}</Text>
    </Pressable>
    <Text testID="energy-status" style={styles.body}>{!active ? "Paused" : error ?? (reading ? energyReadNote(reading) : "Read on demand. No automatic polling.")}</Text>
    <Text style={styles.note}>Device subsystems, not just this app. Android may cache and add noise to energy values, including rail readings.</Text>
    <Text style={styles.note}>A new request may return the same snapshot. Wait about 25 seconds before checking again.</Text>
    {reading && <Text testID="energy-read-time" style={styles.note}>
      Request {reading.sequence} · completed {new Date(reading.recordedAtMs).toLocaleTimeString([], { hour12: false })}
      {reading.finePermissionGranted ? " · fine-access permission granted" : " · ordinary app access"}
    </Text>}
    {(expanded ? rows : rows.slice(0, 5)).map(m => <View key={m.id} style={styles.row}>
      <Text style={styles.name}>{m.name || "Unnamed monitor"}</Text>
      <Text style={styles.note}>{m.type === "rail" ? "Measured rail · API may add noise" : m.type === "consumer" ? "Subsystem estimate · may combine rails or use a model" : `Unknown monitor type ${m.typeRaw}`}</Text>
      <Text testID={`energy-value-${m.index}`} style={styles.value}>{m.availability === "available" ? `${m.joules!.toFixed(3)} J` : m.availability === "unavailable" ? "Unavailable" : "Read failed"}</Text>
      <Text style={styles.note}>{m.snapshotAgeAtReadMs !== null
        ? `Snapshot was ${(m.snapshotAgeAtReadMs / 1000).toFixed(1)} s old when read`
        : m.reason}</Text>
    </View>)}
    {rows.length > 5 && <Pressable accessibilityRole="button" accessibilityLabel="Toggle all energy monitors" onPress={() => setExpanded(!expanded)}>
      <Text style={styles.toggle}>{expanded ? "Show first 5" : `Show all ${rows.length} monitors`}</Text>
    </Pressable>}
  </View>;
}
const styles = StyleSheet.create({
  card: { backgroundColor: "#e9eee8", borderRadius: 20, padding: 20, marginTop: 12 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359" },
  body: { fontSize: 13, lineHeight: 20, color: "#52665c", marginTop: 8 },
  note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6 },
  button: { backgroundColor: "#143f32", borderRadius: 12, padding: 13, marginTop: 14, alignItems: "center" },
  buttonText: { color: "white", fontWeight: "600" },
  row: { borderTopWidth: 1, borderTopColor: "#cbd6ce", paddingTop: 12, marginTop: 14 },
  name: { color: "#143f32", fontSize: 13, fontWeight: "600" },
  value: { color: "#143f32", fontSize: 24, marginTop: 6 },
  toggle: { color: "#143f32", fontWeight: "600", paddingVertical: 14 },
});
