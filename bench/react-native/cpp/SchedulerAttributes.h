#pragma once
#include "NativeJson.h"
#include <sys/syscall.h>
#include <unistd.h>
#include <cstdint>
#include <cerrno>
namespace bench {
// Linux sched_attr v1 ABI. Older kernels return a shorter size; tail fields
// remain absent. Direct read-only syscall also works before bionic's API 37 wrapper.
inline std::string schedulerAttributes(pid_t tid) {
  struct Attributes {uint32_t size,policy;uint64_t flags;int32_t nice;uint32_t priority;uint64_t runtime,deadline,period;uint32_t utilMin,utilMax;};
  static_assert(sizeof(Attributes)==56,"sched_attr v1 ABI");
  Attributes a{};a.size=sizeof(a);const long code=syscall(__NR_sched_getattr,tid,&a,sizeof(a),0U);const int e=code<0?errno:0;
  const long io=syscall(__NR_ioprio_get,1,tid);const int ioe=io<0?errno:0;
  const auto ioprio=jsonObject({{"errno",std::to_string(ioe)},{"raw",ioe?"null":jsonInteger(io)},{"class",ioe?"null":jsonInteger(io>>13)},{"data",ioe?"null":jsonInteger(io&8191)}});
  if(e)return jsonObject({{"errno",std::to_string(e)},{"values","null"},{"ioprio_get",ioprio}});
  const auto values=jsonObject({{"size",jsonInteger(a.size)},{"sched_policy",jsonInteger(a.policy)},{"sched_flags",jsonInteger(a.flags)},{"sched_nice",jsonInteger(a.nice)},{"sched_priority",jsonInteger(a.priority)},{"sched_runtime",jsonInteger(a.runtime)},{"sched_deadline",jsonInteger(a.deadline)},{"sched_period",jsonInteger(a.period)},{"sched_util_min",a.size>=56?jsonInteger(a.utilMin):"null"},{"sched_util_max",a.size>=56?jsonInteger(a.utilMax):"null"}});
  return jsonObject({{"errno","0"},{"values",values},{"ioprio_get",ioprio}});
}
}
