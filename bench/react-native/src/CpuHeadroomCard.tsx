import { useEffect } from "react";
import { AppState, NativeModules, StyleSheet, Text, View } from "react-native";
import { useMetricState } from "./useMetricState";
import { cpuHeadroomNote, validateCpuHeadroom, type CpuHeadroomSample } from "./cpuHeadroom";

export function CpuHeadroomCard() {
  const [reading, setReading] = useMetricState<CpuHeadroomSample | null>("CpuHeadroomCard.reading", null);
  const [error, setError] = useMetricState<string | null>("CpuHeadroomCard.error", null);
  const [active, setActive] = useMetricState("CpuHeadroomCard.active", AppState.currentState === "active");

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
      let delayMs: number | null = 5000;
      try {
        if (!NativeModules.BenchCpuHeadroom?.read)
          throw new Error("Native CPU-headroom collector is missing. Rebuild the app.");
        const next = validateCpuHeadroom(await NativeModules.BenchCpuHeadroom.read());
        if (!mounted || generation !== epoch) return;
        setReading(next);
        setError(null);
        delayMs = next.nextReadInMs === null ? null : Math.max(100, next.nextReadInMs);
      } catch (cause) {
        if (!mounted || generation !== epoch) return;
        setReading(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending = false;
        if (mounted && foreground && (generation !== epoch || delayMs !== null))
          timer = setTimeout(() => void sample(), generation === epoch ? delayMs! : 0);
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
    : reading.availability === "available" ? `${reading.value!.toFixed(1)}%`
    : reading.availability === "unsupported" ? "Unsupported"
    : reading.availability === "error" ? "Read failed" : "Unavailable";
  return (
    <View style={styles.card}>
      <Text style={styles.label}>CPU HEADROOM · ANDROID</Text>
      <Text testID="cpu-headroom" accessibilityLabel={`CPU headroom: ${value}`} style={styles.value}>{value}</Text>
      <Text style={styles.body}>Higher = more spare CPU capacity · 0% = none available</Text>
      <Text style={styles.note}>{error ?? (reading ? cpuHeadroomNote(reading) : "Checking Android’s CPU-headroom support.")}</Text>
      {reading?.requestedWindowMs != null && <Text style={styles.note}>
        Mean · requested window {reading.requestedWindowMs / 1000} s · polling {reading.pollIntervalMs == null ? "stopped" : `${reading.pollIntervalMs / 1000} s`}
      </Text>}
      <Text style={styles.note} testID="cpu-headroom-sample">
        {!active ? "Sampling resumes when the app is active." : reading
          ? `${reading.availability === "unsupported" ? "Support checked" : "Queried"} at ${new Date(reading.sampledAtMs).toLocaleTimeString([], { hour12: false })} · API ${reading.apiLevel}`
          : "Collected off the UI thread."}
      </Text>
      {reading?.headroomQueried && <Text style={styles.note}>Query time is not the estimate’s sample time. Android may return cached data.</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: "#e9eee8", borderRadius: 20, padding: 20, marginTop: 12 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359" },
  value: { fontSize: 34, fontWeight: "600", letterSpacing: -1, color: "#143f32", marginVertical: 10 },
  body: { fontSize: 13, lineHeight: 20, color: "#52665c" },
  note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6 },
});
