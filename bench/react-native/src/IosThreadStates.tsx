import { StyleSheet, Text, View } from "react-native";
import { iosThreadStateLabels, summarizeIosThreadStates } from "./threadStates";
import type { ThreadCpuSample } from "./threadCpu";

// Shares the CPU card's sample and lifecycle. No second polling loop or OS scan.
export function IosThreadStates({ sample, active, error }: {
  sample?: ThreadCpuSample; active: boolean; error: string | null;
}) {
  let result: ReturnType<typeof summarizeIosThreadStates> | null = null;
  let problem = error;
  if (active && sample && !error) {
    try { result = summarizeIosThreadStates(sample); }
    catch (cause) { problem = cause instanceof Error ? cause.message : String(cause); }
  }
  return <View style={styles.section}>
    <Text style={styles.heading}>APP THREAD STATES · iOS</Text>
    <Text style={styles.note}>OS state of each readable app thread when it was queried.</Text>
    {(Object.keys(iosThreadStateLabels) as (keyof typeof iosThreadStateLabels)[]).map(state => <View key={state} style={styles.row}>
      <Text style={styles.body}>{iosThreadStateLabels[state]}</Text>
      <Text testID={`thread-state-${state}`} style={styles.value}>{result ? result.counts[state] : "—"}</Text>
    </View>)}
    <Text testID="thread-state-status" style={styles.note}>{!active ? "Paused" : problem ?? (result
      ? `${result.observed} read · ${result.unreadable} unreadable of ${result.enumerated} enumerated · ${result.complete ? "Complete" : "Partial"} scan`
      : "Reading thread states…")}</Text>
    {result && result.counts.unknown > 0 && <Text testID="thread-state-unknown-codes" style={styles.note}>
      Unknown raw codes: {Object.entries(result.unknownCodes).map(([code, count]) => `${code} (${count})`).join(", ")}
    </Text>}
    <Text style={styles.note}>Running / runnable includes threads waiting for a CPU. Waiting does not identify what they are waiting for. Threads are read in sequence; these are not simultaneous totals, time in each state or CPU utilization. Includes the collector.</Text>
    {result?.environment === "simulator" && <Text style={styles.note}>Simulator reading · these app threads run on this Mac.</Text>}
  </View>;
}
const styles = StyleSheet.create({
  section: { borderTopWidth: 1, borderColor: "#cbd7d2", marginTop: 16, paddingTop: 16 },
  heading: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359", marginBottom: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12, marginTop: 8 },
  body: { fontSize: 14, color: "#52665c" },
  value: { fontSize: 18, fontWeight: "600", color: "#143f32", fontVariant: ["tabular-nums"] },
  note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6 },
});
