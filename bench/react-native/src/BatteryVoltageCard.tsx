import { useMetricState } from "./useMetricState";
import { useEffect } from "react";
import { AppState, NativeModules, StyleSheet, Text, View } from "react-native";
import { batteryContext, batteryReceipt } from "./batteryTemperature";
import { batteryVoltageNote, batteryVoltageValue, batteryVoltageReceiptAgeMs, formatBatteryReceiptAge, validateBatteryVoltage, type BatteryVoltageReport } from "./batteryVoltage";
import { BatteryRefreshProbe } from "./BatteryRefreshProbe";

export function BatteryVoltageCard() {
  const [report, setReport] = useMetricState<BatteryVoltageReport | null>("BatteryVoltageCard.report", null);
  const [receiptAgeMs, setReceiptAgeMs] = useMetricState<number | null>("BatteryVoltageCard.receiptAgeMs", null);
  const [error, setError] = useMetricState<string | null>("BatteryVoltageCard.error", null);
  const [active, setActive] = useMetricState("BatteryVoltageCard.active", AppState.currentState === "active");
  useEffect(() => {
    let mounted = true;
    let foreground = AppState.currentState === "active";
    setActive(foreground);
    let epoch = 0;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function read() {
      if (!mounted || !foreground || pending) return;
      pending = true;
      const generation = epoch;
      try {
        if (!NativeModules.BenchBattery?.read)
          throw new Error("Native battery collector is missing. Rebuild the app.");
        const snapshot = await NativeModules.BenchBattery.read();
        if (!mounted || generation !== epoch) return;
        if (snapshot.error) throw new Error(snapshot.error);
        const next = snapshot.voltageReport === null ? null : validateBatteryVoltage(snapshot.voltageReport);
        const ageMs = next ? batteryVoltageReceiptAgeMs(next, snapshot.readUptimeMs) : null;
        setReport(previous => previous && next && previous.pid === next.pid && previous.sequence === next.sequence ? previous : next);
        setReceiptAgeMs(ageMs);
        setError(null);
      } catch (cause) {
        if (!mounted || generation !== epoch) return;
        setReport(null);
        setReceiptAgeMs(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending = false;
        // This reads the existing native report cache, not the voltage sensor.
        if (mounted && foreground) timer = setTimeout(() => void read(), generation === epoch ? 2000 : 0);
      }
    }
    void read();
    const subscription = AppState.addEventListener("change", state => {
      epoch++;
      foreground = state === "active";
      if (timer !== undefined) clearTimeout(timer);
      setActive(foreground);
      setReport(null);
      setReceiptAgeMs(null);
      setError(null);
      if (foreground) void read();
    });
    return () => { mounted = false; epoch++; if (timer !== undefined) clearTimeout(timer); subscription.remove(); };
  }, []);
  const value = !active ? "Paused" : error ? "Read failed" : report ? batteryVoltageValue(report) : "Waiting…";
  return (
    <View style={styles.card}>
      <Text style={styles.label}>BATTERY VOLTAGE · ANDROID</Text>
      <Text testID="battery-voltage" accessibilityLabel={`Battery voltage: ${value}`} style={styles.value}>{value}</Text>
      {active && report && receiptAgeMs !== null && (
        <View style={styles.ageBox}>
          <Text testID="battery-voltage-age" style={styles.age}>
            {report.receiptKind === "sticky_cache" ? "Cached report" : "OS report"} received {formatBatteryReceiptAge(receiptAgeMs)}
          </Text>
          {report.receiptKind === "sticky_cache" && (
            <Text style={styles.cacheNote}>The report may already have been old when received.</Text>
          )}
        </View>
      )}
      <Text style={styles.body}>{report ? batteryContext(report) : "Waiting for an Android battery report."}</Text>
      <Text style={styles.note}>{error ?? (report ? batteryVoltageNote(report) : "Android controls the update cadence.")}</Text>
      <Text testID="battery-voltage-report" style={styles.note}>
        {!active ? "Monitoring resumes when the app is active." : report
          ? `${report.rawMillivolts === null ? "No raw voltage. " : `${report.rawMillivolts} mV · `}${batteryReceipt(report)}`
          : "No battery report received yet."}
      </Text>
      <BatteryRefreshProbe />
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#e9eee8", borderRadius: 20, padding: 20, marginTop: 12 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359" },
  value: { fontSize: 38, fontWeight: "600", letterSpacing: -1, color: "#143f32", marginVertical: 10 },
  ageBox: { borderLeftWidth: 3, borderLeftColor: "#496359", paddingLeft: 10, marginBottom: 10 },
  age: { fontSize: 16, lineHeight: 22, fontWeight: "600", color: "#143f32", fontVariant: ["tabular-nums"] },
  cacheNote: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 3 },
  body: { fontSize: 13, lineHeight: 20, color: "#52665c" },
  note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6 },
});
