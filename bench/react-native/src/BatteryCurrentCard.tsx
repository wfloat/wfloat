import { useMetricState } from "./useMetricState";
import { useEffect } from "react";
import { AppState, NativeModules, StyleSheet, Text, View } from "react-native";
import { batteryContext } from "./batteryTemperature";
import { batteryCurrentNote, batteryCurrentValue, validateBatteryCurrent, type BatteryCurrentSample } from "./batteryCurrent";

export function BatteryCurrentCard() {
  const [sample, setSample] = useMetricState<BatteryCurrentSample | null>("BatteryCurrentCard.sample", null);
  const [error, setError] = useMetricState<string | null>("BatteryCurrentCard.error", null);
  const [active, setActive] = useMetricState("BatteryCurrentCard.active", AppState.currentState === "active");
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
        if (!NativeModules.BenchBattery?.readCurrent)
          throw new Error("Native current collector is missing. Rebuild the app.");
        const next = await NativeModules.BenchBattery.readCurrent();
        if (!mounted || generation !== epoch) return;
        setSample(validateBatteryCurrent(next));
        setError(null);
      } catch (cause) {
        if (!mounted || generation !== epoch) return;
        setSample(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending = false;
        if (mounted && foreground) timer = setTimeout(() => void read(), generation === epoch ? 2000 : 0);
      }
    }
    void read();
    const subscription = AppState.addEventListener("change", state => {
      epoch++;
      foreground = state === "active";
      if (timer !== undefined) clearTimeout(timer);
      setActive(foreground);
      setSample(null);
      setError(null);
      if (foreground) void read();
    });
    return () => { mounted = false; epoch++; if (timer !== undefined) clearTimeout(timer); subscription.remove(); };
  }, []);
  const value = !active ? "Paused" : error ? "Read failed" : sample ? batteryCurrentValue(sample) : "Waiting…";
  const context = sample?.batteryContext;
  const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });
  return (
    <View style={styles.card}>
      <Text style={styles.label}>BATTERY CURRENT · ANDROID</Text>
      <Text testID="battery-current" accessibilityLabel={`Battery current: ${value}`} style={styles.value}>{value}</Text>
      <Text style={styles.body}>{error ?? (sample ? batteryCurrentNote(sample) : "Reading Android’s battery-current property.")}</Text>
      <Text style={styles.body}>Battery flow does not measure total phone or app power, especially while plugged in.</Text>
      <Text style={styles.note}>Uses Android’s µA contract. Some Samsung firmware reports mA instead, making the display 1,000× too small. No automatic correction is applied.</Text>
      <Text style={styles.note}>{context ? `${batteryContext(context)} · context received ${time(context.receivedAtMs)}` : "Charging context unavailable."}</Text>
      <Text testID="battery-current-report" style={styles.note}>
        {!active ? "Monitoring resumes when the app is active." : sample
          ? `API read ${time(sample.readCompletedAtMs)} · ${sample.rawMicroamps === null ? "no current value" : `raw ${sample.rawMicroamps} (API declares µA)`}. Sensor time unavailable.`
          : "No current reading yet."}
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
