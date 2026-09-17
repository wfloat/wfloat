import { useMetricState } from "./useMetricState";
import { useEffect } from "react";
import { AppState, NativeModules, StyleSheet, Text, View } from "react-native";
import { batteryContext, batteryReceipt, batteryTemperatureNote, validateBatteryReport, type BatteryTemperatureReport } from "./batteryTemperature";

export function BatteryTemperatureCard() {
  const [report, setReport] = useMetricState<BatteryTemperatureReport | null>("BatteryTemperatureCard.report", null);
  const [error, setError] = useMetricState<string | null>("BatteryTemperatureCard.error", null);
  const [active, setActive] = useMetricState("BatteryTemperatureCard.active", AppState.currentState === "active");

  useEffect(() => {
    let mounted = true;
    let foreground = AppState.currentState === "active";
    setActive(foreground);
    let epoch = 0;
    let pending = false;
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
        const next = snapshot.report === null ? null : validateBatteryReport(snapshot.report);
        setReport(previous => previous && next && previous.pid === next.pid && previous.sequence === next.sequence ? previous : next);
        setError(null);
      } catch (cause) {
        if (!mounted || generation !== epoch) return;
        setReport(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally { pending = false; }
    }
    void read();
    // This only reads our native cache. Android controls actual battery-report delivery.
    const timer = setInterval(() => void read(), 2000);
    const subscription = AppState.addEventListener("change", state => {
      epoch++;
      foreground = state === "active";
      setActive(foreground);
      setReport(null);
      setError(null);
      if (foreground) void read();
    });
    return () => { mounted = false; epoch++; clearInterval(timer); subscription.remove(); };
  }, []);

  const value = !active ? "Paused" : error ? "Read failed" : !report ? "Waiting…"
    : report.availability === "available" ? `${report.celsius!.toFixed(1)} °C`
    : report.availability === "error" ? "Read failed" : "Unavailable";
  return (
    <View style={styles.card}>
      <Text style={styles.label}>BATTERY TEMPERATURE · ANDROID</Text>
      <Text testID="battery-temperature" accessibilityLabel={`Battery temperature: ${value}`} style={styles.value}>{value}</Text>
      <Text style={styles.body}>{report ? batteryContext(report) : "Waiting for an Android battery report."}</Text>
      <Text style={styles.note}>{error ?? (report ? batteryTemperatureNote(report) : "Android controls the update cadence.")}</Text>
      <Text testID="battery-temperature-report" style={styles.note}>
        {!active ? "Monitoring resumes when the app is active." : report ? batteryReceipt(report) : "No battery report received yet."}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#e9eee8", borderRadius: 20, padding: 20, marginTop: 12 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359" },
  value: { fontSize: 38, fontWeight: "600", letterSpacing: -1, color: "#143f32", marginVertical: 10 },
  body: { fontSize: 13, lineHeight: 20, color: "#52665c" },
  note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6 },
});
