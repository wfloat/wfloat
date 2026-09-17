import { validateThreadCpuSample } from "./threadCpu";

export const iosThreadStateLabels = {
  running: "Running / runnable", waiting: "Waiting", stopped: "Stopped",
  uninterruptible: "Uninterruptible wait", halted: "Halted", unknown: "Unknown code",
} as const;
type State = keyof typeof iosThreadStateLabels;
// Public Mach enums, not a bitmask. Preserve unrecognized signed codes in logs
// and summarize them separately from threads whose OS query could not be read.
const known = new Map<number, State>([[1, "running"], [2, "stopped"], [3, "waiting"],
  [4, "uninterruptible"], [5, "halted"]]);

export function summarizeIosThreadStates(value: unknown) {
  const sample = validateThreadCpuSample(value);
  if (sample.platform !== "ios" || sample.runStateSource !== "thread_info(THREAD_BASIC_INFO).run_state" ||
      !["simulator", "device"].includes(sample.runStateEnvironment ?? ""))
    throw new Error("iOS thread states were not recorded by this build. Rebuild the app.");
  const counts: Record<State, number> = { running: 0, waiting: 0, stopped: 0, uninterruptible: 0, halted: 0, unknown: 0 };
  const unknownCodes: Record<string, number> = {};
  for (const thread of sample.threads) {
    const raw = thread.runState;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < -2147483648 || raw > 2147483647)
      throw new Error("Missing or invalid iOS thread run-state code.");
    const state = known.get(raw) ?? "unknown";
    counts[state]++;
    if (state === "unknown") unknownCodes[String(raw)] = (unknownCodes[String(raw)] ?? 0) + 1;
  }
  return { counts, unknownCodes, observed: sample.threads.length, unreadable: sample.errors.length,
    enumerated: sample.enumeratedThreadCount, complete: sample.errors.length === 0,
    environment: sample.runStateEnvironment!, processId: sample.processId, sequence: sample.sequence,
    source: sample.runStateSource, unit: "threads" as const,
    scanMs: sample.queryFinishedUptimeMs - sample.queryStartedUptimeMs };
}

export const androidThreadStateLabels = {
  running: "Running / runnable · R", sleeping: "Interruptible sleep · S",
  uninterruptible: "Uninterruptible wait · D", stopped: "Stopped · T",
  tracing: "Tracing stop · t", dead: "Dead · X", zombie: "Zombie · Z",
  parked: "Parked · P", idle: "Idle · I", unknown: "Unknown code",
} as const;
type AndroidState = keyof typeof androidThreadStateLabels;
const linuxStates = new Map<string, AndroidState>([["R", "running"], ["S", "sleeping"],
  ["D", "uninterruptible"], ["T", "stopped"], ["t", "tracing"], ["X", "dead"],
  ["Z", "zombie"], ["P", "parked"], ["I", "idle"]]);

export function summarizeAndroidThreadStates(value: unknown) {
  const sample = validateThreadCpuSample(value);
  if (sample.platform !== "android" || sample.runStateSource !== "/proc/self/task/*/stat:state")
    throw new Error("Android thread states were not recorded by this build. Rebuild the app.");
  const counts: Record<AndroidState, number> = { running: 0, sleeping: 0, uninterruptible: 0,
    stopped: 0, tracing: 0, dead: 0, zombie: 0, parked: 0, idle: 0, unknown: 0 };
  const unknownCodes: Record<string, number> = {};
  for (const thread of sample.threads) {
    const raw = thread.runState;
    if (typeof raw !== "string" || !/^[!-~]$/.test(raw))
      throw new Error("Missing or invalid Android thread state code.");
    const state = linuxStates.get(raw) ?? "unknown";
    counts[state]++;
    if (state === "unknown") unknownCodes[raw] = (unknownCodes[raw] ?? 0) + 1;
  }
  return { counts, unknownCodes, observed: sample.threads.length, unreadable: sample.errors.length,
    enumerated: sample.enumeratedThreadCount, complete: sample.errors.length === 0,
    processId: sample.processId, sequence: sample.sequence, source: sample.runStateSource,
    unit: "threads" as const, scanMs: sample.queryFinishedUptimeMs - sample.queryStartedUptimeMs };
}
