import { useMetricState } from "./useMetricState";
import { useEffect } from "react";
import { AppState, NativeModules, StyleSheet, Text, View } from "react-native";
import { headroomNote, validateHeadroom, type ThermalHeadroomSample } from "./thermalHeadroom";

export function ThermalHeadroomCard() {
  const [reading, setReading] = useMetricState<ThermalHeadroomSample | null>("ThermalHeadroomCard.reading", null);
  const [error, setError] = useMetricState<string | null>("ThermalHeadroomCard.error", null);
  const [active, setActive] = useMetricState("ThermalHeadroomCard.active", AppState.currentState === "active");

  useEffect(() => {
    let mounted = true;
    let foreground = AppState.currentState === "active";
    setActive(foreground);
    let epoch = 0;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function sample() {
      if (!mounted || !foreground || pending) return;
      pending = true;
      const generation = epoch;
      let delayMs = 10_000;
      try {
        if (!NativeModules.BenchHeadroom?.read)
          throw new Error("Native headroom collector is missing. Rebuild the app.");
        const next = validateHeadroom(await NativeModules.BenchHeadroom.read());
        if (!mounted || generation !== epoch) return;
        setReading(next);
        setError(null);
        delayMs = Math.max(100, next.nextReadInMs);
      } catch (cause) {
        if (!mounted || generation !== epoch) return;
        setReading(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending = false;
        // Resume during an in-flight read must schedule again, discarding the stale response.
        if (mounted && foreground)
          timer = setTimeout(() => void sample(), generation === epoch ? delayMs : 0);
      }
    }

    void sample();
    const subscription = AppState.addEventListener("change", state => {
      epoch++;
      foreground = state === "active";
      setActive(foreground);
      setReading(null);
      setError(null);
      if (timer !== undefined) clearTimeout(timer);
      if (foreground) void sample();
    });
    return () => { mounted = false; epoch++; if (timer !== undefined) clearTimeout(timer); subscription.remove(); };
  }, []);

  const value = !active ? "Paused" : error ? "Read failed" : !reading ? "Reading…"
    : reading.availability === "available" ? reading.value!.toFixed(3)
    : reading.availability === "error" ? "Read failed" : "Unavailable";
  return (
    <View style={styles.card}>
      <Text style={styles.label}>THERMAL HEADROOM · ANDROID</Text>
      <Text testID="thermal-headroom" accessibilityLabel={`Thermal headroom: ${value}`} style={styles.value}>{value}</Text>
      <Text style={styles.body}>Higher = more thermal stress · 1.0 = severe threshold</Text>
      <Text style={styles.note}>{error ?? (reading ? headroomNote(reading) : "Current OS estimate · not a temperature.")}</Text>
      <Text testID="thermal-headroom-sample" style={styles.note}>
        {reading ? `Read at ${new Date(reading.sampledAtMs).toLocaleTimeString([], { hour12: false })} · every 10 s`
          : active ? "Samples at most once every 10 seconds." : "Sampling resumes when the app is active."}
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
