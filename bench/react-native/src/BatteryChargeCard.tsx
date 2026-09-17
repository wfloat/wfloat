import { useMetricState } from "./useMetricState";
import { useEffect } from "react";
import { AppState, NativeModules, StyleSheet, Text, View } from "react-native";
import { batteryContext } from "./batteryTemperature";
import { batteryChargeNote, batteryChargeValue, validateBatteryCharge, type BatteryChargeSample } from "./batteryCharge";

export function BatteryChargeCard() {
  const [sample, setSample] = useMetricState<BatteryChargeSample | null>("BatteryChargeCard.sample", null);
  const [error, setError] = useMetricState<string | null>("BatteryChargeCard.error", null);
  const [active, setActive] = useMetricState("BatteryChargeCard.active", AppState.currentState === "active");
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
        if (!NativeModules.BenchBattery?.readChargeCounter)
          throw new Error("Native charge-counter collector is missing. Rebuild the app.");
        const next = await NativeModules.BenchBattery.readChargeCounter();
        if (!mounted || generation !== epoch) return;
        setSample(validateBatteryCharge(next));
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
  const value = !active ? "Paused" : error ? "Read failed" : sample ? batteryChargeValue(sample) : "Waiting…";
  const context = sample?.batteryContext;
  const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour12: false });
  return (
    <View style={styles.card}>
      <Text style={styles.label}>BATTERY CHARGE REMAINING · ANDROID</Text>
      <Text testID="battery-charge" accessibilityLabel={`Battery charge remaining: ${value}`} style={styles.value}>{value}</Text>
      <Text style={styles.body}>{error ?? (sample ? batteryChargeNote(sample) : "Reading Android’s battery-charge property.")}</Text>
      <Text style={styles.body}>Remaining charge can rise or fall. Its change excludes power supplied directly through USB and does not measure app energy use.</Text>
      <Text style={styles.note}>{context ? `${batteryContext(context)} · context received ${time(context.receivedAtMs)}` : "Charging context unavailable."}</Text>
      <Text style={styles.note}>Refreshes about every 2 seconds. Displayed precision does not establish sensor accuracy.</Text>
      {sample?.environment === "emulator" && <Text style={styles.note}>Emulator · synthetic battery data.</Text>}
      <Text testID="battery-charge-report" style={styles.note}>
        {!active ? "Monitoring resumes when the app is active." : sample
          ? `API read ${time(sample.readCompletedAtMs)} · ${sample.rawMicroampHours === null ? "no charge value" : `${sample.rawMicroampHours} µAh`}. Sensor time unavailable.`
          : "No charge reading yet."}
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
