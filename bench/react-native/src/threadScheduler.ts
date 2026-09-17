import { validateThreadCpuSample } from "./threadCpu";

const policies = new Map<number, string>([[0, "Normal"], [1, "FIFO"], [2, "Round robin"],
  [3, "Batch"], [5, "Idle"], [6, "Deadline"], [7, "Extensible"]]);
const uint32 = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 4294967295;
export function validateAndroidThreadSchedulers(value: unknown) {
  const sample = validateThreadCpuSample(value);
  if (sample.platform !== "android" || sample.schedulerSource !== "/proc/self/task/*/stat:policy,rt_priority" ||
      sample.policyUnit !== "linux_sched_policy" || sample.rtPriorityUnit !== "linux_rt_priority")
    throw new Error("Thread scheduling policy / RT priority was not recorded by this build. Rebuild the app.");
  const threads = sample.threads.map(thread => {
    const { policy, rtPriority } = thread;
    if (!uint32(policy) || !uint32(rtPriority)) throw new Error("Missing or invalid thread scheduler value.");
    // stat exports task->policy, not sched_getscheduler's reset-on-fork bit.
    // Do not strip flags or infer policy from nice or effective kernel priority.
    const policyName = policies.get(policy) ?? "Unknown";
    const expected = policy === 1 || policy === 2 ? rtPriority >= 1 && rtPriority <= 99 : rtPriority === 0;
    return { threadId: thread.threadId, startTimeTicks: thread.startTimeTicks, policy, policyName, rtPriority,
      note: !policies.has(policy) ? "Unknown policy; RT priority retained without interpretation"
        : !expected ? "Unexpected policy / RT priority pair; raw values retained" : null };
  });
  return { threads, flagged: threads.filter(t => t.note !== null).length, observed: threads.length, unreadable: sample.errors.length,
    enumerated: sample.enumeratedThreadCount, source: sample.schedulerSource };
}
