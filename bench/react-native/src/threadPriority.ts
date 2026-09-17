import { validateThreadCpuSample } from "./threadCpu";

export function validateAndroidThreadPriorities(value: unknown) {
  const sample = validateThreadCpuSample(value);
  if (sample.platform !== "android" || sample.prioritySource !== "/proc/self/task/*/stat:priority,nice" ||
      sample.priorityUnit !== "kernel_priority" || sample.niceUnit !== "linux_nice")
    throw new Error("Thread priority / nice was not recorded by this build. Rebuild the app.");
  const threads = sample.threads.map(thread => {
    const { priority, nice } = thread;
    // Preserve the signed kernel value: deadline and inherited priorities need
    // not follow the ordinary nice + 20 relation. Do not infer scheduler policy.
    if (typeof priority !== "number" || !Number.isInteger(priority) || priority < -2147483648 || priority > 2147483647 ||
        typeof nice !== "number" || !Number.isInteger(nice) || nice < -20 || nice > 19)
      throw new Error("Missing or invalid thread priority / nice value.");
    return { threadId: thread.threadId, startTimeTicks: thread.startTimeTicks, priority, nice };
  });
  return { threads, observed: threads.length, unreadable: sample.errors.length,
    enumerated: sample.enumeratedThreadCount, source: sample.prioritySource,
    priorityUnit: sample.priorityUnit, niceUnit: sample.niceUnit };
}
