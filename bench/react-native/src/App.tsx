import { SignalsStatus } from "./SignalsStatus";
import { useMetricState } from "./useMetricState";
import { useEffect, useRef } from "react";
import {
  AppState,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { loadLlmModel, type LlmModel } from "@wfloat/react-native-wfloat";
import { readThermalState, type ThermalReading } from "./thermal";
import { repeatWorkload } from "./sustained";
import { CpuUsageCard } from "./CpuUsageCard";
import { ThermalHeadroomCard } from "./ThermalHeadroomCard";
import { CpuHeadroomCard } from "./CpuHeadroomCard";
import { PowerMonitorsCard } from "./PowerMonitorsCard";
import { BatteryTemperatureCard } from "./BatteryTemperatureCard";
import { BatteryCurrentCard } from "./BatteryCurrentCard";
import { BatteryChargeCard } from "./BatteryChargeCard";
import { BatteryVoltageCard } from "./BatteryVoltageCard";
import { MemoryUsageCard } from "./MemoryUsageCard";
import { SystemMemoryCard } from "./SystemMemoryCard";
import { MemoryWarningsCard } from "./MemoryWarningsCard";
import { PageFaultsCard } from "./PageFaultsCard";
import { ContextSwitchCard } from "./ContextSwitchCard";
import { StorageIoCard } from "./StorageIoCard";
import { NetworkCard } from "./NetworkCard";
import { FileDescriptorCard } from "./FileDescriptorCard";
import { ThreadCountCard } from "./ThreadCountCard";
import { ThreadCpuCard } from "./ThreadCpuCard";
import {
  startCpuStress,
  readCpuStress,
  stopCpuStress,
  type CpuStatus,
} from "./cpu";

// React Native 0.76 provides this monotonic clock but omits its global TS type.
declare const performance: { now(): number };

const MODEL = "HuggingFaceTB/SmolLM2-360M-Instruct";
const PROMPT =
  "Explain in three short sentences why running AI locally can be useful.";
const MAX_HISTORY = 24;
const RUN_DURATION_MS = 5 * 60 * 1000;
type Workload = "cpu" | "combined" | "llm";
const defaultWorkload: Workload = Platform.OS === "android" ? "combined" : "cpu";
const workloadOptions: Workload[] = Platform.OS === "android"
  ? ["combined", "cpu", "llm"] : ["cpu", "llm"];
const workloadLabel = (kind: Workload) => kind === "combined"
  ? "CPU + GPU stress" : kind === "cpu" ? "CPU stress" : "LLM";
const workloadDetail = (kind: Workload) =>
  kind === "combined"
    ? "CPU workers + GPU compute · up to ten minutes"
    : kind === "cpu"
      ? "Ramp to all CPU cores · up to ten minutes"
      : "Repeat the workload for up to five minutes";
type Phase =
  | "Idle"
  | "Before run"
  | "Loading"
  | "Running"
  | "Stopping"
  | "Stopped"
  | "Completed"
  | "Failed";
type Observation = ThermalReading & { phase: Phase };

function time(ms: number) {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}
function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
function duration(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export default function App({ onOpenOverhead, onOpenEnergy }: { onOpenOverhead?: () => void; onOpenEnergy?: () => void }) {
  const [workload, setWorkload] = useMetricState<Workload>("App.workload", defaultWorkload);
  const [fileProbeRunning, setFileProbeRunning] = useMetricState("App.fileProbeRunning", false);
  const [waitWakeRunning, setWaitWakeRunning] = useMetricState("App.waitWakeRunning", false);
  const [storageCheckRunning, setStorageCheckRunning] = useMetricState("App.storageCheckRunning", false);
  const workloadRef = useRef<Workload>(defaultWorkload);
  const [cpu, setCpu] = useMetricState<CpuStatus | null>("App.cpu", null);
  const [phase, setPhase] = useMetricState<Phase>("App.phase", "Idle");
  const [detail, setDetail] = useMetricState("App.detail", workloadDetail(defaultWorkload));
  const [reading, setReading] = useMetricState<ThermalReading | null>("App.reading", null);
  const [thermalError, setThermalError] = useMetricState<string | null>("App.thermalError", null);
  const [runError, setRunError] = useMetricState<string | null>("App.runError", null);
  const [history, setHistory] = useMetricState<Observation[]>("App.history", []);
  const [output, setOutput] = useMetricState("App.output", "");
  const [iterations, setIterations] = useMetricState("App.iterations", 0);
  const [elapsedMs, setElapsedMs] = useMetricState("App.elapsedMs", 0);
  const model = useRef<LlmModel | null>(null);
  const phaseRef = useRef<Phase>("Idle");
  const busy = useRef(false);
  const mounted = useRef(true);
  const pendingRead = useRef<Promise<void> | null>(null);
  const stopReason = useRef<string | null>(null);
  const startedAt = useRef<number | null>(null);

  function changePhase(next: Phase) {
    phaseRef.current = next;
    if (mounted.current) setPhase(next);
  }

  function requestStop(reason: string) {
    if (!busy.current || stopReason.current) return;
    stopReason.current = reason;
    if (workloadRef.current !== "llm") {
      const code = reason.startsWith("Thermal state")
        ? 3
        : reason.startsWith("Thermal read")
          ? 4
          : 0;
      void stopCpuStress(code).catch((error) => {
        if (mounted.current) setRunError(message(error));
      });
    }
    changePhase("Stopping");
    if (mounted.current) {
      setDetail(
        `${reason} · ${workloadRef.current !== "llm" ? "stopping native workers" : "finishing the current operation"}`,
      );
    }
  }

  // Native timestamps describe when the OS was queried. History records state
  // changes and run boundaries, while the current reading refreshes each second.
  async function sample(checkpoint = false): Promise<void> {
    if (pendingRead.current) {
      if (!checkpoint) return;
      await pendingRead.current;
    }
    if (!mounted.current) return;
    const observedPhase = phaseRef.current;
    const task = (async () => {
      try {
        const next = await readThermalState();
        if (!mounted.current) return;
        setReading(next);
        setThermalError(null);
        if (next.availability !== "available" || next.rawValue == null) {
          requestStop("Thermal reading unavailable");
        } else if (next.rawValue > 0) {
          requestStop(`Thermal state reached ${next.state ?? next.rawValue}`);
        }
        setHistory((previous) => {
          const last = previous[0];
          if (
            !checkpoint &&
            last?.rawValue === next.rawValue &&
            last?.availability === next.availability &&
            last?.phase === observedPhase
          )
            return previous;
          return [{ ...next, phase: observedPhase }, ...previous].slice(
            0,
            MAX_HISTORY,
          );
        });
      } catch (error) {
        requestStop("Thermal read failed");
        if (mounted.current) {
          setThermalError(message(error));
          setReading(null);
        }
      }
    })();
    pendingRead.current = task;
    try {
      await task;
    } finally {
      pendingRead.current = null;
    }
  }

  useEffect(() => {
    mounted.current = true;
    void sample();
    const timer = setInterval(() => {
      if (AppState.currentState === "active") void sample();
      if (startedAt.current != null) {
        const elapsed = performance.now() - startedAt.current;
        setElapsedMs(elapsed);
        if (elapsed >= RUN_DURATION_MS)
          requestStop("Five-minute limit reached");
      }
    }, 1000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void sample();
      else requestStop("App moved to the background");
    });
    return () => {
      mounted.current = false;
      requestStop("App closed");
      clearInterval(timer);
      subscription.remove();
    };
  }, []);

  async function run() {
    if (busy.current || fileProbeRunning || waitWakeRunning || storageCheckRunning) return;
    busy.current = true;
    stopReason.current = null;
    startedAt.current = null;
    setRunError(null);
    setOutput("");
    setHistory([]);
    setIterations(0);
    setElapsedMs(0);
    setCpu(null);
    try {
      changePhase("Before run");
      await sample(true);
      if (!stopReason.current && workloadRef.current !== "llm") {
        changePhase("Running");
        setDetail(
          "Starting native workload · stops at the first nonzero thermal state",
        );
        await sample(true);
        if (!stopReason.current) {
          let current = await startCpuStress(workloadRef.current === "combined");
          while (mounted.current) {
            setCpu(current);
            setElapsedMs(current.elapsedMs);
            if (!current.running) {
              if (current.gpuError) throw new Error(current.gpuError);
              stopReason.current ??= current.reason;
              break;
            }
            if (!current.stopping) {
              setDetail(current.workers < current.targetWorkers
                ? "Ramping CPU workers · stops at the first nonzero thermal state"
                : "Full workload · stops at the first nonzero thermal state");
            }
            if (current.stopping) {
              changePhase("Stopping");
              setDetail(current.reason);
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 500));
            current = await readCpuStress();
          }
        }
      }
      if (
        !stopReason.current &&
        workloadRef.current === "llm" &&
        !model.current
      ) {
        changePhase("Loading");
        setDetail("Preparing model · first run downloads the weights");
        await sample(true);
        if (!stopReason.current) {
          model.current = await loadLlmModel(MODEL, {
            contextSize: 1024,
            numThreads: 4,
            gpuLayerCount: 0,
            onProgress(event) {
              if (!mounted.current || stopReason.current) return;
              if (event.status === "downloading") {
                setDetail("Downloading model");
              } else if (event.status === "loading") {
                setDetail("Loading model into memory");
              }
            },
          });
        }
      }
      if (
        !stopReason.current &&
        workloadRef.current === "llm" &&
        model.current
      ) {
        changePhase("Running");
        setDetail(
          "Repeating on CPU · stops at the first nonzero thermal state",
        );
        await sample(true);
        startedAt.current = performance.now();
        const loadedModel = model.current;
        const result = await repeatWorkload({
          generate: () =>
            loadedModel.chat({
              messages: [{ role: "user", content: PROMPT }],
              maxTokens: 64,
              temperature: 0,
              seed: 1,
            }),
          async onResult(result, count) {
            if (mounted.current) {
              setOutput(result.text || "(The model returned no text.)");
              setIterations(count);
            }
            await sample();
          },
          stopReason: () => stopReason.current,
          durationMs: RUN_DURATION_MS,
          now: () => performance.now(),
        });
        stopReason.current = result.reason;
      }
      changePhase(
        stopReason.current === "Five-minute limit reached" ||
          stopReason.current === "Time limit reached"
          ? "Completed"
          : "Stopped",
      );
      if (mounted.current)
        setDetail(
          `${stopReason.current ?? "Stopped"} · readings continue during cooldown`,
        );
    } catch (error) {
      if (mounted.current) {
        setRunError(message(error));
        setDetail("Run failed");
      }
      changePhase("Failed");
    } finally {
      if (workloadRef.current !== "llm") {
        // Also stop after a bridge/read failure or unmount. Native guards remain
        // independent of this JS cleanup.
        try {
          await stopCpuStress();
        } catch (error) {
          if (mounted.current) setRunError(message(error));
        }
      }
      if (startedAt.current != null && mounted.current) {
        setElapsedMs(performance.now() - startedAt.current);
      }
      startedAt.current = null;
      // Ending the workload does not unload the model or stop thermal polling.
      busy.current = false;
      await sample(true);
    }
  }

  const running =
    phase === "Before run" ||
    phase === "Loading" ||
    phase === "Running" ||
    phase === "Stopping";
  const virtual =
    reading?.environment === "simulator" || reading?.environment === "emulator";
  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar barStyle="dark-content" backgroundColor="#f5f6f2" />
      <ScrollView contentContainerStyle={styles.page}>
        <SignalsStatus />
        <Text style={styles.eyebrow}>WFLOAT / BENCH</Text>
        <Text style={styles.title}>Device readings</Text>
        <Text style={styles.subtitle}>Thermals, CPU usage and process memory.</Text>
        {onOpenOverhead && <Pressable accessibilityRole="button" accessibilityLabel="Open instrumentation overhead check"
          disabled={running || fileProbeRunning || waitWakeRunning || storageCheckRunning || model.current !== null}
          onPress={onOpenOverhead} style={{ paddingVertical: 12, marginBottom: 12 }}>
          <Text style={styles.body}>Check instrumentation CPU overhead →</Text>
          {model.current !== null && <Text style={styles.note}>Relaunch before this check to start without a loaded model.</Text>}
        </Pressable>}
        {Platform.OS === 'android' && onOpenEnergy && <Pressable accessibilityRole="button" accessibilityLabel="Open energy comparison"
          disabled={running || fileProbeRunning || waitWakeRunning || storageCheckRunning || model.current !== null}
          onPress={onOpenEnergy} style={{ paddingVertical: 12, marginBottom: 12 }}>
          <Text style={styles.body}>Compare idle and CPU energy →</Text>
        </Pressable>}

        <View style={styles.card}>
          <View style={styles.row}>
            <Text style={styles.label}>THERMAL STATE</Text>
            <Text style={styles.badge}>
              {Platform.OS === "ios" ? "iOS" : "Android"} ·{" "}
              {reading?.environment ?? "checking"}
            </Text>
          </View>
          <Text
            testID="thermal-state"
            accessibilityLabel={`Thermal state: ${thermalError ? "error" : (reading?.state ?? "unavailable")}`}
            style={styles.value}
          >
            {thermalError
              ? "Read failed"
              : reading
                ? (reading.state ?? "Unavailable")
                : "Reading…"}
          </Text>
          <Text style={styles.body}>
            {reading?.rawValue != null
              ? `Native value ${reading.rawValue} · `
              : ""}
            {reading
              ? `Read at ${time(reading.sampledAtMs)}`
              : "Waiting for the native collector"}
          </Text>
          <Text style={styles.note}>
            {thermalError ??
              reading?.note ??
              "Reading the operating system thermal API."}
          </Text>
          {reading && <Text style={styles.source}>{reading.source}</Text>}
        </View>

        {Platform.OS === "android" && <ThermalHeadroomCard />}
        {Platform.OS === "android" && <PowerMonitorsCard emulated={virtual} />}
        {Platform.OS === "android" && <BatteryTemperatureCard />}
        {Platform.OS === "android" && <BatteryCurrentCard />}
        {Platform.OS === "android" && <BatteryVoltageCard />}
        {Platform.OS === "android" && <BatteryChargeCard />}
        <CpuUsageCard />
        {Platform.OS === "android" && <CpuHeadroomCard />}
        <ThreadCountCard />
        {Platform.OS === "android" && <FileDescriptorCard />}
        <ThreadCpuCard />
        <ContextSwitchCard workloadRunning={running || fileProbeRunning || storageCheckRunning} onProbeRunningChange={setWaitWakeRunning} />
        <MemoryUsageCard workloadRunning={running || fileProbeRunning || waitWakeRunning || storageCheckRunning} />
        {Platform.OS === "android" && <SystemMemoryCard />}
        {Platform.OS === "ios" && <MemoryWarningsCard />}
        <StorageIoCard workloadRunning={running || fileProbeRunning || waitWakeRunning} onProbeRunningChange={setStorageCheckRunning} />
        {Platform.OS === "android" && <NetworkCard />}
        <PageFaultsCard workloadRunning={running || waitWakeRunning || storageCheckRunning} onProbeRunningChange={setFileProbeRunning} />

        {virtual && (
          <View style={styles.notice}>
            <Text style={styles.noticeText}>
              {Platform.OS === "ios" ? "Simulator" : "Emulator"} proof only.
              These readings do not represent a physical phone’s performance
              or thermal response.
            </Text>
          </View>
        )}

        <View style={styles.workload}>
          <View style={styles.row}>
            {workloadOptions.map((kind) => (
              <Pressable
                key={kind}
                accessibilityRole="button"
                accessibilityLabel={`Select ${workloadLabel(kind)}`}
                accessibilityState={{
                  selected: workload === kind,
                  disabled: running,
                }}
                disabled={running}
                onPress={() => {
                  workloadRef.current = kind;
                  setWorkload(kind);
                  changePhase("Idle");
                  setElapsedMs(0);
                  setIterations(0);
                  setCpu(null);
                  setOutput("");
                  setRunError(null);
                  setDetail(workloadDetail(kind));
                }}
                style={{
                  paddingVertical: 12,
                  opacity: workload === kind ? 1 : 0.45,
                }}
              >
                <Text style={styles.label}>
                  {kind === "combined" ? "CPU + GPU" : kind === "cpu" ? "CPU" : "LLM"}
                </Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.row}>
            <Text style={styles.label}>
              {workload !== "llm" ? "SYNTHETIC WORKLOAD" : "LLM WORKLOAD"}
            </Text>
            <Text testID="run-phase" style={styles.phase}>
              {phase}
            </Text>
          </View>
          <Text style={styles.model}>
            {workload !== "llm" ? workloadLabel(workload) : "SmolLM2 · 360M"}
          </Text>
          <Text style={styles.body}>
            {workload === "combined"
              ? "Native CPU arithmetic + offscreen GPU compute"
              : workload === "cpu"
                ? "Native vector arithmetic · ramps to all available cores"
                : "CPU · 4 threads · up to 64 output tokens per iteration"}
          </Text>
          <Text testID="run-progress" style={styles.body}>
            {duration(elapsedMs)} workload time ·{" "}
            {workload !== "llm"
              ? `${cpu?.workers ?? 0} active workers${cpu ? ` / ${cpu.targetWorkers} target` : ""}`
              : `${iterations} completed iterations`}
          </Text>
          {workload !== "llm" ? (
            <Text testID="cpu-progress" style={styles.prompt}>
              {cpu
                ? `${cpu.blocks.toLocaleString()} computation blocks completed`
                : workload === "combined"
                  ? "CPU ramp: 2 → half → all but one core. GPU runs continuously."
                  : "2 workers → half the cores at 10s → all cores at 20s"}
            </Text>
          ) : (
            <Text style={styles.prompt}>{PROMPT}</Text>
          )}
          {workload === "combined" && cpu && (
            <View testID="gpu-progress">
              <Text style={styles.body}>
                GPU {cpu.gpuActive ? "active" : "idle"} ·{" "}
                {(cpu.gpuBatches ?? 0).toLocaleString()} verified batches
              </Text>
              <Text style={styles.note}>
                {cpu.gpuRenderer || "Preparing GPU"}
                {cpu.gpuBatches ? ` · last batch ${cpu.gpuLastBatchMs} ms` : ""}
              </Text>
            </View>
          )}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${running ? "Stop" : "Start"} ${workloadLabel(workload)}`}
            testID="run-llm"
            disabled={phase === "Stopping" || fileProbeRunning || waitWakeRunning || storageCheckRunning}
            onPress={() =>
              running ? requestStop("Stopped by you") : void run()
            }
            style={({ pressed }) => [
              styles.button,
              (phase === "Stopping" || pressed) && styles.buttonDim,
            ]}
          >
            <Text style={styles.buttonText}>
              {phase === "Stopping" ? "Stopping…" : running ? "Stop" : "Start"}
            </Text>
          </Pressable>
          <Text accessibilityLiveRegion="polite" style={styles.status}>
            {detail}
          </Text>
          <Text style={styles.note}>
            {workload !== "llm"
              ? "Stops on thermal change, Stop, backgrounding or the ten-minute limit. No model is needed."
              : "Stop finishes the current generation. Model preparation is excluded from workload time."}
          </Text>
          {runError && (
            <Text selectable style={styles.error}>
              {runError}
            </Text>
          )}
          {output !== "" && (
            <View style={styles.output}>
              <Text selectable testID="llm-output" style={styles.outputText}>
                {output}
              </Text>
            </View>
          )}
        </View>

        <View style={styles.history}>
          <Text style={styles.label}>THERMAL HISTORY</Text>
          <Text style={styles.caption}>
            State changes and run checkpoints · newest first
          </Text>
          {history.map((item, index) => (
            <View key={`${item.uptimeMs}-${index}`} style={styles.historyRow}>
              <View style={styles.historyMeta}>
                <Text style={styles.historyPhase}>{item.phase}</Text>
                <Text style={styles.caption}>{time(item.sampledAtMs)}</Text>
              </View>
              <Text style={styles.historyState}>
                {item.state ?? "Unavailable"}
                {item.rawValue != null ? ` (${item.rawValue})` : ""}
              </Text>
            </View>
          ))}
          {history.length === 0 && (
            <Text style={styles.note}>No readings recorded yet.</Text>
          )}
        </View>
        <Text style={styles.footer}>
          Reads approximately once per second while foregrounded. Thermal history keeps
          the latest {MAX_HISTORY} entries in memory.
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: "#f5f6f2" },
  page: {
    padding: 24,
    paddingBottom: 36,
    width: "100%",
    maxWidth: 650,
    alignSelf: "center",
  },
  eyebrow: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 2,
    color: "#3c7067",
    marginTop: 12,
  },
  title: {
    fontSize: 34,
    fontWeight: "700",
    letterSpacing: -1,
    color: "#142b27",
    marginTop: 12,
  },
  subtitle: { fontSize: 16, color: "#63716b", marginTop: 6, marginBottom: 24 },
  card: { backgroundColor: "#e3ede5", borderRadius: 20, padding: 20 },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    flexWrap: "wrap",
    gap: 8,
  },
  label: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 1.2,
    color: "#496359",
  },
  badge: {
    fontSize: 11,
    color: "#285146",
    backgroundColor: "#f4f8f3",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
  },
  value: {
    fontSize: 43,
    fontWeight: "600",
    letterSpacing: -1,
    color: "#143f32",
    marginVertical: 14,
  },
  body: { fontSize: 13, lineHeight: 20, color: "#52665c" },
  note: { fontSize: 12, lineHeight: 18, color: "#52665c", marginTop: 10 },
  source: {
    fontSize: 10,
    color: "#52665c",
    marginTop: 12,
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
  },
  notice: {
    marginTop: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: "#eeeee5",
  },
  noticeText: { fontSize: 12, lineHeight: 18, color: "#686345" },
  workload: { marginTop: 28 },
  phase: { fontSize: 12, fontWeight: "600", color: "#285b4d" },
  model: {
    fontSize: 23,
    fontWeight: "600",
    color: "#213b32",
    marginTop: 12,
    marginBottom: 4,
  },
  prompt: {
    fontSize: 14,
    lineHeight: 21,
    color: "#43584f",
    marginTop: 14,
    marginBottom: 18,
  },
  button: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1c5141",
    minHeight: 50,
    borderRadius: 12,
  },
  buttonDim: { opacity: 0.6 },
  buttonText: { fontSize: 16, fontWeight: "600", color: "#fff" },
  status: {
    fontSize: 12,
    color: "#68756d",
    textAlign: "center",
    marginTop: 10,
    lineHeight: 18,
  },
  error: { fontSize: 13, lineHeight: 20, color: "#a13228", marginTop: 14 },
  output: {
    backgroundColor: "#fff",
    borderRadius: 14,
    padding: 16,
    marginTop: 18,
  },
  outputText: { fontSize: 14, lineHeight: 22, color: "#283e33" },
  history: { marginTop: 28 },
  caption: { fontSize: 11, color: "#77847a", marginTop: 5 },
  historyRow: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#e2e6df",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  historyMeta: { flex: 1 },
  historyPhase: { fontSize: 13, color: "#4d6357" },
  historyState: {
    fontSize: 13,
    fontWeight: "600",
    color: "#254b3d",
    flexShrink: 1,
  },
  footer: { fontSize: 11, lineHeight: 17, color: "#77847a", marginTop: 18 },
});
