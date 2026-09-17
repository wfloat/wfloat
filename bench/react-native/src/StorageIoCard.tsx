import { useMetricState } from "./useMetricState";
import { useEffect, useRef } from "react";
import { AppState, NativeModules, Platform, Pressable, StyleSheet, Text, View } from "react-native";
import { StorageIoTracker, validateStorageIoCheck, validProcIo, type StorageIoReading } from "./storageIo";
const mib = (bytes: number) => (bytes / 1048576).toFixed(2);

export function StorageIoCard({ workloadRunning, onProbeRunningChange }: {
  workloadRunning: boolean; onProbeRunningChange: (running: boolean) => void;
}) {
  const tracker = useRef(new StorageIoTracker());
  const lifetime = useRef({ mounted: false, epoch: 0 });
  const runningRef = useRef(false);
  const [reading, setReading] = useMetricState<StorageIoReading | null>("StorageIoCard.reading", null);
  const [error, setError] = useMetricState<string | null>("StorageIoCard.error", null);
  const [active, setActive] = useMetricState("StorageIoCard.active", AppState.currentState === "active");
  const [running, setRunning] = useMetricState("StorageIoCard.running", false);
  const [check, setCheck] = useMetricState<ReturnType<typeof validateStorageIoCheck> | null>("StorageIoCard.check", null);
  const [checkError, setCheckError] = useMetricState<string | null>("StorageIoCard.checkError", null);
  useEffect(() => {
    lifetime.current.mounted = true;
    let foreground = AppState.currentState === "active", pending = false;
    setActive(foreground);
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function sample() {
      if (!lifetime.current.mounted || !foreground || pending) return;
      pending = true;
      const generation = lifetime.current.epoch;
      try {
        if (!NativeModules.BenchStorageIo?.read) throw new Error("Native storage collector is missing. Rebuild the app.");
        const result = JSON.parse(await NativeModules.BenchStorageIo.read());
        if (!lifetime.current.mounted || generation !== lifetime.current.epoch) return;
        if (result?.platform !== Platform.OS) throw new Error("Unexpected storage I/O platform");
        setReading(tracker.current.record(result)); setError(null);
      } catch (cause) {
        if (!lifetime.current.mounted || generation !== lifetime.current.epoch) return;
        tracker.current.resetWindow(); setReading(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        pending = false;
        if (lifetime.current.mounted && foreground)
          timer = setTimeout(() => void sample(), generation === lifetime.current.epoch ? 2000 : 0);
      }
    }
    tracker.current.resetWindow(); void sample();
    const subscription = AppState.addEventListener("change", state => {
      ++lifetime.current.epoch; foreground = state === "active";
      if (timer !== undefined) clearTimeout(timer);
      setActive(foreground); setReading(null); setError(null); tracker.current.resetWindow();
      if (!foreground && runningRef.current) { setCheckError("Storage check interrupted when the app left the foreground."); void NativeModules.BenchStorageIo?.cancel().catch(() => {}); }
      if (foreground) void sample();
    });
    return () => {
      lifetime.current.mounted = false; ++lifetime.current.epoch;
      if (timer !== undefined) clearTimeout(timer);
      subscription.remove(); tracker.current.resetWindow();
      void NativeModules.BenchStorageIo?.cancel().catch(() => {});
      onProbeRunningChange(false);
    };
  }, [onProbeRunningChange]);
  async function runCheck(reduceCaching = false) {
    if (runningRef.current || workloadRunning || AppState.currentState !== "active") return;
    const generation = lifetime.current.epoch;
    runningRef.current = true; setRunning(true); onProbeRunningChange(true); setCheck(null); setCheckError(null);
    try {
      if (!NativeModules.BenchStorageIo?.run) throw new Error("Native storage check is missing. Rebuild the app.");
      const result = JSON.parse(await NativeModules.BenchStorageIo.run(reduceCaching));
      if (lifetime.current.mounted && generation === lifetime.current.epoch) setCheck(validateStorageIoCheck(result, Platform.OS));
    } catch (cause) {
      if (lifetime.current.mounted && generation === lifetime.current.epoch) setCheckError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      runningRef.current = false;
      if (lifetime.current.mounted) { setRunning(false); onProbeRunningChange(false); }
    }
  }
  return <View style={styles.card}>
    <Text style={styles.label}>APP STORAGE I/O · {Platform.OS === "android" ? "ANDROID" : "iOS"}</Text>
    <Text style={styles.body}>Storage bytes attributed to this process by the OS.</Text>
    {[["readBytes", "Reads"], ["writeBytes", "Writes"]].map(([key, label]) => {
      const value = !active ? "Paused" : error ? "Unavailable" : reading?.window ? `${mib(reading.window.perSecond[key])} MiB/s` : "Sampling…";
      return <View style={styles.counter} key={key}>
        <Text style={styles.counterLabel}>{label}</Text>
        <Text testID={`storage-io-${key}-rate`} accessibilityLabel={`Storage ${label}: ${value}`} style={styles.value}>{value}</Text>
        <Text testID={`storage-io-${key}-total`} style={styles.body}>{reading ? `${mib(reading.sample.counters[key])} MiB · OS cumulative counter` : "Waiting for native counters."}</Text>
      </View>;
    })}
    <Text style={styles.note}>{Platform.OS === "android"
      ? "Writes are counted when memory pages become dirty; some may be cancelled before storage writeback."
      : "Apple disk I/O accounting. Attribution and caching differ from Android."}</Text>
    {Platform.OS === "android" && reading && <Text style={styles.note}>{validProcIo(reading.sample)
      ? `Cancelled writes: ${mib(validProcIo(reading.sample)!.cancelledWriteBytes)} MiB cumulative · reported separately.`
      : "Additional cancelled-write and logical-I/O counters are unavailable to this app."}</Text>}
    {Platform.OS === "android" && <Text style={styles.note}>Read/write bytes are derived from 512-byte OS accounting units. Run the check to verify that the counters respond on this device.</Text>}
    <Text style={styles.note}>Cached reads may add zero storage bytes. Includes other app activity; these rates do not measure the device’s maximum storage speed.</Text>
    <Text testID="storage-io-status" style={styles.note}>{error ?? (!active ? "Sampling resumes when the app is active." : reading?.window
      ? `Measured over ${(reading.window.elapsedMs / 1000).toFixed(2)} s · refreshes every 2 seconds`
      : "Rates need two foreground samples.")}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={running ? "Cancel storage check" : "Run storage check"}
      testID="storage-io-check" disabled={!active || (!running && workloadRunning)}
      onPress={() => running ? void NativeModules.BenchStorageIo.cancel().catch((cause: unknown) => setCheckError(String(cause))) : void runCheck()}
      style={[styles.button, (!active || (!running && workloadRunning)) && { opacity: 0.4 }]}>
      <Text style={styles.buttonText}>{running ? "Cancel storage check" : "Check with a 32 MiB file"}</Text>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="Run storage read response check"
      testID="storage-read-response-check" disabled={!active || running || workloadRunning}
      onPress={() => void runCheck(true)}
      style={[styles.button, (!active || running || workloadRunning) && { opacity: 0.4 }]}>
      <Text style={styles.buttonText}>Check reads with cache control</Text>
    </Pressable>
    <Text style={styles.note}>Each check writes and syncs 32 MiB, then reads and verifies it twice. The temporary file is removed automatically.</Text>
    <Text style={styles.note}>{Platform.OS === "ios"
      ? "Cache control requests uncached I/O for this file during writing and both reads."
      : "Cache control requests eviction of this file after sync, before its first read. The second read uses normal caching."} This does not clear hardware or host caches.</Text>
    <Text testID="storage-io-check-result" style={styles.note}>{checkError ?? (running ? "Checking…" : check
      ? `Completed · ${check.result.cachePolicy === "file_cache_control" ? "file cache control" : "normal caching"} · 32 MiB written, 64 MiB read and verified.\nOS write increase during write + sync: ${mib(check.windows[0].deltas.writeBytes)} MiB\nOS read increases: ${mib(check.windows[1].deltas.readBytes)} / ${mib(check.windows[2].deltas.readBytes)} MiB`
      : "Ready for a storage check.")}</Text>
    {check?.result.cacheControl && <Text style={styles.note} testID="storage-cache-control-result">
      {check.result.cacheControl.errno === 0 ? "Cache-control request accepted." : `Cache-control request failed (errno ${check.result.cacheControl.errno}).`}
      {check.windows[1].deltas.readBytes > 0 ? " OS read counter responded during the first read."
        : " No OS read increase observed during the first read; storage read response remains unverified."}
    </Text>}
  </View>;
}
const styles = StyleSheet.create({
  card: { backgroundColor: "#e9eee8", borderRadius: 20, padding: 20, marginTop: 12 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359", marginBottom: 8 },
  counter: { marginTop: 14 }, counterLabel: { fontSize: 14, fontWeight: "600", color: "#143f32" },
  value: { fontSize: 30, fontWeight: "600", color: "#143f32", marginVertical: 4, fontVariant: ["tabular-nums"] },
  body: { fontSize: 13, lineHeight: 20, color: "#52665c" }, note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6 },
  button: { borderWidth: 1, borderColor: "#8aaa9b", borderRadius: 10, padding: 12, marginTop: 16 },
  buttonText: { fontSize: 13, fontWeight: "600", color: "#285e47", textAlign: "center" },
});
