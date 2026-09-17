import { threadCpuSource } from "./threadSources";
import { useMetricState } from "./useMetricState";
import { useEffect, useRef } from "react";
import { AppState, Platform, StyleSheet, Text, View } from "react-native";
import { validateAndroidThreadContextSwitches } from "./threadContextSwitches";
import { validateAndroidThreadGetterAffinity } from "./threadGetterAffinity";
import { validateAndroidThreadAffinity } from "./threadAffinity";
import { validateAndroidThreadPlacement } from "./threadPlacement";
import { validateAndroidThreadSchedulers } from "./threadScheduler";
import { validateAndroidThreadPriorities } from "./threadPriority";
import { ThreadCpuTracker } from "./threadCpu";
import { AndroidThreadStates } from "./AndroidThreadStates";
import { IosThreadStates } from "./IosThreadStates";

export function ThreadCpuCard() {
  const tracker = useRef(new ThreadCpuTracker());
  const [result, setResult] = useMetricState<ReturnType<ThreadCpuTracker["record"]> | null>("ThreadCpuCard.result", null);
  const [error, setError] = useMetricState<string | null>("ThreadCpuCard.error", null);
  const [active, setActive] = useMetricState("ThreadCpuCard.active", AppState.currentState === "active");
  useEffect(() => {
    tracker.current.reset();
    const unsubscribe = threadCpuSource.subscribe(event => {
      setActive(event.active);
      if (!event.active || event.value === null) {
        tracker.current.reset(); setResult(null); setError(event.error); return;
      }
      try { setResult(tracker.current.record(event.value)); setError(null); }
      catch (cause) { tracker.current.reset(); setResult(null); setError(cause instanceof Error ? cause.message : String(cause)); }
    });
    return () => { unsubscribe(); tracker.current.reset(); };
  }, []);
  const sample = result?.sample;
  let priorities: ReturnType<typeof validateAndroidThreadPriorities> | null = null;
  let priorityError: string | null = null;
  if (Platform.OS === "android" && sample && active && !error) {
    try { priorities = validateAndroidThreadPriorities(sample); }
    catch (cause) { priorityError = cause instanceof Error ? cause.message : String(cause); }
  }
  let schedulers: ReturnType<typeof validateAndroidThreadSchedulers> | null = null;
  let schedulerError: string | null = null;
  if (Platform.OS === "android" && sample && active && !error) {
    try { schedulers = validateAndroidThreadSchedulers(sample); }
    catch (cause) { schedulerError = cause instanceof Error ? cause.message : String(cause); }
  }
  let placement: ReturnType<typeof validateAndroidThreadPlacement> | null = null;
  let placementError: string | null = null;
  if (Platform.OS === "android" && sample && active && !error) {
    try { placement = validateAndroidThreadPlacement(sample); }
    catch (cause) { placementError = cause instanceof Error ? cause.message : String(cause); }
  }
  let affinities: ReturnType<typeof validateAndroidThreadAffinity> | null = null;
  let affinityError: string | null = null;
  if (Platform.OS === "android" && sample && active && !error) {
    try { affinities = validateAndroidThreadAffinity(sample); }
    catch (cause) { affinityError = cause instanceof Error ? cause.message : String(cause); }
  }
  let switches: ReturnType<typeof validateAndroidThreadContextSwitches> | null = null;
  let switchesError: string | null = null;
  if (Platform.OS === "android" && sample && active && !error) {
    try { switches = validateAndroidThreadContextSwitches(sample); }
    catch (cause) { switchesError = cause instanceof Error ? cause.message : String(cause); }
  }
  let getterAffinities: ReturnType<typeof validateAndroidThreadGetterAffinity> | null = null;
  let getterAffinityError: string | null = null;
  if (Platform.OS === "android" && sample && active && !error) {
    try { getterAffinities = validateAndroidThreadGetterAffinity(sample); }
    catch (cause) { getterAffinityError = cause instanceof Error ? cause.message : String(cause); }
  }
  const measured = result?.rows.filter(r => r.state === "measured").length ?? 0;
  return <View style={styles.card}>
    <Text style={styles.label}>CPU BY APP THREAD</Text>
    {sample?.capture && <Text selectable testID="thread-capture-status" style={styles.note}>
      Source file: {sample.capture.state}{'\n'}{sample.capture.path}
    </Text>}
    <Text style={styles.body}>Busiest 5 sampled threads · 100% = one occupied core</Text>
    {result?.rows.slice(0, 5).map((r, index) => <View key={`${r.reading.threadId}:${r.reading.startTimeTicks}`} style={styles.thread}>
      <View style={styles.row}>
        <Text numberOfLines={1} style={styles.name}>{r.reading.name?.replace(/\s+/g, " ") || `Thread ${r.reading.threadId}`}</Text>
        <Text testID={`thread-cpu-usage-${index}`} style={styles.value}>{r.percent === null ? "—" : `${r.percent.toFixed(1)}%`}</Text>
      </View>
      <Text testID={`thread-cpu-detail-${index}`} style={styles.note}>
        ID {r.reading.threadId} · {r.state === "measured"
          ? `${r.userDeltaMs!.toFixed(1)} ms user + ${r.systemDeltaMs!.toFixed(1)} ms kernel / ${(r.elapsedMs! / 1000).toFixed(2)} s`
          : r.state === "counter_reset" ? "Counter reset; awaiting a new interval" : "Awaiting a second sample"}
      </Text>
      {Platform.OS === "android" && <Text testID={`thread-last-cpu-${index}`} style={styles.note}>
        {(() => {
          const p = placement?.threads.find(t => t.threadId === r.reading.threadId && t.startTimeTicks === r.reading.startTimeTicks);
          return p ? `Last logical CPU ${p.lastCpu}` : "Last logical CPU unavailable";
        })()}
      </Text>}
      {Platform.OS === "android" && <Text testID={`thread-affinity-${index}`} style={styles.note}>
        {(() => {
          const a = affinities?.threads.find(t => t.threadId === r.reading.threadId && t.startTimeTicks === r.reading.startTimeTicks);
          return a?.available ? `Reported CPU allowance ${a.cpuList} · ${a.cpuCount} logical CPU${a.cpuCount === 1 ? "" : "s"}`
            : `CPU allowance unavailable${a?.reason ? ` · ${a.reason}` : ""}`;
        })()}
      </Text>}
      {Platform.OS === "android" && <Text testID={`thread-getter-affinity-${index}`} style={styles.note}>
        {(() => {
          const a = getterAffinities?.threads.find(t => t.threadId === r.reading.threadId && t.startTimeTicks === r.reading.startTimeTicks);
          return a?.available ? `Getter CPU allowance ${a.cpuList || "none"} · ${a.cpuCount} logical CPU${a.cpuCount === 1 ? "" : "s"}`
            : `Getter CPU allowance unavailable${a?.reason ? ` · ${a.reason}` : ""}`;
        })()}
      </Text>}
      {Platform.OS === "android" && <Text testID={`thread-context-switches-${index}`} style={styles.note}>
        {(() => {
          const c = switches?.threads.find(t => t.threadId === r.reading.threadId && t.startTimeTicks === r.reading.startTimeTicks);
          return c?.available ? `Context switches · ${c.voluntaryCount} voluntary · ${c.involuntaryCount} involuntary`
            : `Context switches unavailable${c?.reason ? ` · ${c.reason}` : ""}`;
        })()}
      </Text>}
      {Platform.OS === "android" && <Text testID={`thread-priority-${index}`} style={styles.note}>
        {(() => {
          const p = priorities?.threads.find(t => t.threadId === r.reading.threadId && t.startTimeTicks === r.reading.startTimeTicks);
          return p ? `Kernel priority ${p.priority} · Nice ${p.nice}` : "Priority / nice unavailable";
        })()}
      </Text>}
      {Platform.OS === "android" && <Text testID={`thread-scheduler-${index}`} style={styles.note}>
        {(() => {
          const s = schedulers?.threads.find(t => t.threadId === r.reading.threadId && t.startTimeTicks === r.reading.startTimeTicks);
          return s ? `Policy ${s.policyName} (${s.policy}) · RT priority ${s.rtPriority}${s.note ? ` · ${s.note}` : ""}` : "Policy / RT priority unavailable";
        })()}
      </Text>}
    </View>)}
    <Text testID="thread-cpu-status" style={styles.note}>{error ?? (!active ? "Paused" : sample
      ? `${measured} measured · ${sample.threads.length - measured} awaiting baseline · ${sample.errors.length} unreadable of ${sample.enumeratedThreadCount} enumerated`
      : "Reading thread CPU counters…")}</Text>
    <Text style={styles.note}>Short-lived threads can be missed. New or unreadable threads have no usage estimate; these rows are not a complete app CPU total.</Text>
    {sample && <Text testID="thread-cpu-query" style={styles.note}>
      Scan {(sample.queryFinishedUptimeMs - sample.queryStartedUptimeMs).toFixed(2)} ms · refreshes every 2 seconds
    </Text>}
    {Platform.OS === "android" && <View>
      <Text testID="thread-priority-status" style={styles.note}>{!active ? "Priority / nice paused" : error ?? priorityError ?? (priorities
        ? `Priority / nice: ${priorities.observed} read · ${priorities.unreadable} unreadable of ${priorities.enumerated} enumerated · shown for the busiest 5 above`
        : "Reading priority / nice…")}</Text>
      <Text style={styles.note}>Nice ranges from −20 to 19; lower is more favorable for normal scheduling. Kernel priority is a separate raw OS value, usually nice + 20 for normal threads. Neither is CPU usage or a guarantee of CPU time. All readable threads are recorded.</Text>
    </View>}
    {Platform.OS === "android" && <View>
      <Text testID="thread-scheduler-status" style={styles.note}>{!active ? "Policy / RT priority paused" : error ?? schedulerError ?? (schedulers
        ? `Policy / RT priority: ${schedulers.observed} read · ${schedulers.unreadable} unreadable of ${schedulers.enumerated} enumerated${schedulers.flagged ? ` · ${schedulers.flagged} unfamiliar or unexpected pairs; see records` : ""}`
        : "Reading scheduling policy…")}</Text>
      <Text style={styles.note}>RT priority is normally 1–99 for FIFO / round robin (higher is stronger), and 0 otherwise. This is separate from nice and kernel priority. Policy describes scheduling rules, not a guarantee of CPU time or deadlines. Sequential observations; all readable threads are recorded.</Text>
    </View>}
    {Platform.OS === "android" && <View>
      <Text testID="thread-last-cpu-status" style={styles.note}>{!active ? "Last logical CPU paused" : error ?? placementError ?? (placement
        ? `Last logical CPU: ${placement.observed} read · ${placement.unreadable} unreadable of ${placement.enumerated} enumerated`
        : "Reading last logical CPU…")}</Text>
      <Text style={styles.note}>CPU number each thread last ran on when read. CPU 0 is valid. A sleeping thread retains its last location. These samples do not measure time per CPU, every migration, affinity or core type. All readable threads are recorded.</Text>
    </View>}
    {Platform.OS === "android" && <View>
      <Text testID="thread-affinity-status" style={styles.note}>{!active ? "CPU allowance paused" : error ?? affinityError ?? (affinities
        ? `CPU allowance: ${affinities.observed} read · ${affinities.unavailable} unavailable of ${affinities.enumerated} enumerated`
        : "Reading CPU allowance…")}</Text>
      <Text style={styles.note}>Reported affinity list, not CPU use or core type. OS restrictions and CPU availability can change; this does not guarantee a later pinning request will succeed. Read separately from last CPU, with thread identity checked again. Adds status and identity reads per thread; all readable allowances are recorded.</Text>
    </View>}
    {Platform.OS === "android" && <View>
      <Text testID="thread-context-switches-status" style={styles.note}>{!active ? "Thread context switches paused" : error ?? switchesError ?? (switches
        ? `Thread context switches: ${switches.observed} read · ${switches.unavailable} unavailable of ${switches.enumerated} enumerated`
        : "Reading thread context switches…")}</Text>
      <Text style={styles.note}>Cumulative counts since each thread started. Voluntary switches usually accompany blocking or sleeping; involuntary switches reflect scheduler preemption. These are not latency or CPU usage. Shares the affinity status read and identity check; the pair is not an atomic snapshot. All readable threads are recorded; summing them does not reconstruct the whole-app counters.</Text>
    </View>}
    {Platform.OS === "android" && <View>
      <Text testID="thread-getter-affinity-status" style={styles.note}>{!active ? "Getter CPU allowance paused" : error ?? getterAffinityError ?? (getterAffinities
        ? `Getter CPU allowance: ${getterAffinities.observed} read · ${getterAffinities.unavailable} unavailable of ${getterAffinities.enumerated} enumerated`
        : "Reading getter CPU allowance…")}</Text>
      <Text style={styles.note}>The kernel getter can filter the stored CPU allowance above. Both are separate observations, not a guarantee of future execution. An empty result is distinct from an unavailable reading. Adds one getter call and identity read per thread; all readable results are recorded.</Text>
    </View>}
    {Platform.OS === "ios" && <IosThreadStates sample={sample} active={active} error={error} />}
    {Platform.OS === "android" && <AndroidThreadStates sample={sample} active={active} error={error} />}
  </View>;
}
const styles = StyleSheet.create({
  card: { backgroundColor: "#e9eee8", borderRadius: 20, padding: 20, marginTop: 12 },
  label: { fontSize: 11, fontWeight: "700", letterSpacing: 1.2, color: "#496359", marginBottom: 8 },
  body: { fontSize: 13, lineHeight: 20, color: "#52665c" },
  thread: { marginTop: 12 }, row: { flexDirection: "row", gap: 12, alignItems: "center" },
  name: { flex: 1, fontSize: 14, fontWeight: "600", color: "#143f32" },
  value: { fontSize: 22, fontWeight: "600", color: "#143f32", fontVariant: ["tabular-nums"] },
  note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 6 },
});
