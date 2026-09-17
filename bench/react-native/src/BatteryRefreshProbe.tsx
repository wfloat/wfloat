import { useMetricState } from "./useMetricState";
import { useEffect } from "react";
import { AppState, NativeModules, Pressable, StyleSheet, Text, View } from "react-native";

type Probe = {
  active: boolean; probeId: number | null; remainingMs: number;
  requests: number; sent: number; reportsDuringProbe: number; stopReason: string | null;
  lastRequest: { outcome: string; detail: string; callDurationMs: number } | null;
};

export function BatteryRefreshProbe() {
  const [probe, setProbe] = useMetricState<Probe | null>("BatteryRefreshProbe.probe", null);
  const [error, setError] = useMetricState<string | null>("BatteryRefreshProbe.error", null);
  const [busy, setBusy] = useMetricState("BatteryRefreshProbe.busy", false);
  const [active, setActive] = useMetricState("BatteryRefreshProbe.active", AppState.currentState === "active");
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
        const next: Probe = await NativeModules.BenchBattery.readRefreshProbe();
        if (mounted && generation === epoch) { setProbe(next); setError(null); }
      } catch (cause) {
        if (mounted && generation === epoch) setError(String(cause));
      } finally {
        pending = false;
        if (mounted && foreground) timer = setTimeout(() => void read(), generation === epoch ? 1000 : 0);
      }
    }
    void read();
    const subscription = AppState.addEventListener("change", state => {
      epoch++; foreground = state === "active"; setActive(foreground);
      if (timer !== undefined) clearTimeout(timer);
      if (foreground) void read();
    });
    return () => { mounted = false; epoch++; if (timer !== undefined) clearTimeout(timer); subscription.remove(); };
  }, []);
  async function toggle() {
    if (busy) return;
    setBusy(true);
    try {
      const method = probe?.active ? "stopRefreshProbe" : "startRefreshProbe";
      setProbe(await NativeModules.BenchBattery[method]()); setError(null);
    } catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  }
  return (
    <View style={styles.box}>
      <Text style={styles.title}>EXPERIMENTAL REFRESH</Text>
      <Text testID="battery-refresh-state" style={styles.body}>
        {!active ? "Paused" : probe?.active ? `Requesting updates · ${Math.ceil(probe.remainingMs / 1000)}s left`
          : probe?.stopReason === "access_failed" ? "Refresh unavailable" : "Passive battery reporting"}
      </Text>
      <Text style={styles.body}>Requests an Android battery-health update every 2s for up to 60s. Stops on backgrounding.</Text>
      {probe?.lastRequest && <Text testID="battery-refresh-result" style={styles.body}>
        {probe.sent}/{probe.requests} requests sent · {probe.reportsDuringProbe} OS reports during probe.{"\n"}
        {probe.lastRequest.detail}
      </Text>}
      <Text style={styles.body}>Report counts do not prove fresh sensor samples. Voltage remains the value Android broadcasts.</Text>
      {error && <Text style={styles.body}>{error}</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel={probe?.active ? "Stop battery refresh probe" : "Start battery refresh probe"}
        disabled={busy || !active} onPress={() => void toggle()} style={[styles.button, (busy || !active) && { opacity: 0.5 }]}>
        <Text style={styles.buttonText}>{probe?.active ? "Stop refresh probe" : "Probe refresh for 60s"}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { marginTop: 18, paddingTop: 16, borderTopWidth: 1, borderTopColor: "#ccd8ce" },
  title: { fontSize: 11, fontWeight: "700", letterSpacing: 1, color: "#496359" },
  body: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 7 },
  button: { backgroundColor: "#1c5141", padding: 14, borderRadius: 12, alignItems: "center", marginTop: 12 },
  buttonText: { color: "white", fontSize: 14, fontWeight: "600" },
});
