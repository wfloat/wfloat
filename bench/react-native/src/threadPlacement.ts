import { validateThreadCpuSample } from "./threadCpu";

export function validateAndroidThreadPlacement(value: unknown) {
  const sample = validateThreadCpuSample(value);
  if (sample.platform !== "android" || sample.lastCpuSource !== "/proc/self/task/*/stat:processor" ||
      sample.lastCpuUnit !== "logical_cpu_id")
    throw new Error("Last logical CPU was not recorded by this build. Rebuild the app.");
  const threads = sample.threads.map(thread => {
    const { lastCpu } = thread;
    // CPU identifiers need not be dense or bounded by this process's available CPU count.
    if (typeof lastCpu !== "number" || !Number.isInteger(lastCpu) || lastCpu < 0 || lastCpu > 2147483647)
      throw new Error("Missing or invalid last logical CPU.");
    return { threadId: thread.threadId, startTimeTicks: thread.startTimeTicks, lastCpu };
  });
  return { threads, observed: threads.length, unreadable: sample.errors.length,
    enumerated: sample.enumeratedThreadCount, source: sample.lastCpuSource };
}
