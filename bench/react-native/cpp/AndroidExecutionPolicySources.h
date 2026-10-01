#pragma once
#include "NativeJson.h"
#include <cstdint>
#include <cerrno>

namespace bench {
// Stable Linux UAPI option numbers also work with older NDK headers. Unknown
// kernel options return their native errno. No SET operation is permitted here.
// Unlike a child probe, these getters observe the actual collecting thread/mm.
inline std::string androidExecutionPolicySources(long (*query)(int, unsigned long), int64_t collectingThreadId) {
  struct Query { int option; unsigned long selector; const char *name; const char *scope; };
  const Query queries[] = {
    {13, 0, "PR_GET_TIMING", "calling_thread_cpu_accounting_mode"},
    {52, 0, "PR_GET_SPECULATION_CTRL:PR_SPEC_STORE_BYPASS", "calling_thread_speculation_policy"},
    {52, 1, "PR_GET_SPECULATION_CTRL:PR_SPEC_INDIRECT_BRANCH", "calling_thread_speculation_policy"},
    {52, 2, "PR_GET_SPECULATION_CTRL:PR_SPEC_L1D_FLUSH", "calling_thread_speculation_policy"},
    {68, 0, "PR_GET_MEMORY_MERGE", "process_ksm_merge_any_policy_not_merged_page_count"},
    {78, 2, "PR_FUTEX_HASH:PR_FUTEX_HASH_GET_SLOTS", "process_private_futex_hash_capacity_not_waiter_count"},
    {79, 1, "PR_RSEQ_SLICE_EXTENSION:PR_RSEQ_SLICE_EXTENSION_GET", "calling_thread_rseq_slice_extension_policy"},
  };
  std::string rows = "[";
  for (const auto &q : queries) {
    errno = 0;
    const long value = query(q.option, q.selector);
    const int error = value == -1 ? errno : 0;
    if (rows.size() > 1) rows += ',';
    rows += jsonObject({{"name", jsonString(q.name)}, {"option", std::to_string(q.option)},
      {"selector", jsonInteger(q.selector)}, {"scope", jsonString(q.scope)},
      {"returnValue", jsonInteger(value)}, {"errno", std::to_string(error)},
      {"value", value == -1 ? "null" : jsonInteger(value)}});
  }
  return jsonObject({{"callingThreadId", jsonInteger(collectingThreadId)}, {"queries", rows + ']'},
    {"semantics", jsonString("native policy bits/capacities, not measured overhead; speculation ENABLE/DISABLE has reversed mitigation meaning for L1D_FLUSH; zero may be a valid policy; unavailable is null with errno")}});
}
}
