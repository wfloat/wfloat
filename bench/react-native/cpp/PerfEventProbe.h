#pragma once
#include "NativeJson.h"
#include <linux/perf_event.h>
#include <sys/syscall.h>
#include <sys/ioctl.h>
#include <sys/wait.h>
#include <sys/resource.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>
#include <cerrno>
#include <cstdint>
#include <time.h>
namespace bench {
// A child with the same app identity isolates a vendor seccomp SIGSYS. No access
// settings are changed. Only async-signal-safe/syscall work happens after fork.
inline std::string perfEventProbe() {
  struct Report {int event,openError,controlError,readError;int64_t readBytes;uint64_t value,timeEnabled,timeRunning,checksum;};
  // Entire generic numeric event families. DUMMY and BPF_OUTPUT are delivery
  // mechanisms, not standalone resource counters. Cache combinations may be
  // unsupported; retain the kernel's result for each rather than prefiltering.
  constexpr int count=62;uint32_t types[count]{};uint64_t configs[count]{};
  std::string names[count];int next=0;
  const char *hardware[]={"cpu_cycles","instructions","cache_references","cache_misses","branch_instructions","branch_misses","bus_cycles","stalled_cycles_frontend","stalled_cycles_backend","ref_cpu_cycles"};
  for(int i=0;i<10;++i){types[next]=PERF_TYPE_HARDWARE;configs[next]=i;names[next++]=hardware[i];}
  const char *software[]={"cpu_clock","task_clock","page_faults","context_switches","cpu_migrations","minor_page_faults","major_page_faults","alignment_faults","emulation_faults"};
  for(int i=0;i<9;++i){types[next]=PERF_TYPE_SOFTWARE;configs[next]=i;names[next++]=software[i];}
  types[next]=PERF_TYPE_SOFTWARE;configs[next]=PERF_COUNT_SW_CGROUP_SWITCHES;names[next++]="cgroup_switches";
  const char *caches[]={"l1d","l1i","last_level","dtlb","itlb","branch_predictor","node"};
  const char *operations[]={"read","write","prefetch"};const char *results[]={"access","miss"};
  for(int cache=0;cache<7;++cache)for(int op=0;op<3;++op)for(int result=0;result<2;++result){types[next]=PERF_TYPE_HW_CACHE;configs[next]=cache|(op<<8)|(result<<16);names[next++]=std::string(caches[cache])+"_"+operations[op]+"_"+results[result];}
  int pipes[2];if(pipe(pipes)<0)return jsonObject({{"error",jsonString("pipe")},{"errno",std::to_string(errno)}});
  const pid_t child=fork();if(child<0){const int e=errno;close(pipes[0]);close(pipes[1]);return jsonObject({{"error",jsonString("fork")},{"errno",std::to_string(e)}});}
  if(child==0) {
    struct sigaction action{};action.sa_handler=SIG_DFL;sigemptyset(&action.sa_mask);sigaction(SIGSYS,&action,nullptr);
    close(pipes[0]);rlimit core{0,0};setrlimit(RLIMIT_CORE,&core);
    for(int i=0;i<count;++i){Report r{};r.event=i;perf_event_attr attr{};attr.size=PERF_ATTR_SIZE_VER0;attr.type=types[i];attr.config=configs[i];attr.disabled=1;attr.exclude_kernel=1;attr.exclude_hv=1;attr.read_format=PERF_FORMAT_TOTAL_TIME_ENABLED|PERF_FORMAT_TOTAL_TIME_RUNNING;
      const int fd=(int)syscall(__NR_perf_event_open,&attr,0,-1,-1,0);if(fd<0)r.openError=errno;
      else {
        if(ioctl(fd,PERF_EVENT_IOC_RESET,0)<0||ioctl(fd,PERF_EVENT_IOC_ENABLE,0)<0)r.controlError=errno;
        if(!r.controlError){volatile uint64_t value=1;for(unsigned j=0;j<100000;++j)value=value*1664525+1013904223;r.checksum=value;if(ioctl(fd,PERF_EVENT_IOC_DISABLE,0)<0)r.controlError=errno;}
        uint64_t values[3]{};r.readBytes=read(fd,values,sizeof(values));if(r.readBytes<0)r.readError=errno;else if(r.readBytes!=sizeof(values))r.readError=EIO;r.value=values[0];r.timeEnabled=values[1];r.timeRunning=values[2];close(fd);
      }
      if(write(pipes[1],&r,sizeof(r))!=sizeof(r))_exit(2);
    }
    close(pipes[1]);_exit(0);
  }
  close(pipes[1]);Report reports[count]{};size_t bytes=0;bool timeout=false;int pipeError=0;
  const auto monotonicMs=[](){timespec t{};clock_gettime(CLOCK_MONOTONIC,&t);return int64_t(t.tv_sec)*1000+t.tv_nsec/1000000;};const auto deadline=monotonicMs()+3000;
  // Pipe fits every fixed-size report, so neither side needs heap allocation.
  while(bytes<sizeof(reports)){pollfd p{pipes[0],POLLIN|POLLHUP,0};const auto remaining=deadline-monotonicMs();if(remaining<=0){timeout=true;break;}const int rc=poll(&p,1,(int)remaining);if(rc==0){timeout=true;break;}if(rc<0){if(errno==EINTR)continue;pipeError=errno;break;}const auto n=read(pipes[0],(char *)reports+bytes,sizeof(reports)-bytes);if(n<0){if(errno==EINTR)continue;pipeError=errno;break;}if(n==0)break;bytes+=n;}
  close(pipes[0]);if(timeout||pipeError)kill(child,SIGKILL);int status=0;pid_t waited;do{waited=waitpid(child,&status,0);}while(waited<0&&errno==EINTR);const int waitError=waited<0?errno:0;
  std::string rows="[";for(size_t i=0;i<bytes/sizeof(Report);++i){if(i)rows+=',';const auto&r=reports[i];const bool valid=!r.openError&&!r.controlError&&!r.readError;rows+=jsonObject({{"event",jsonString(names[r.event])},{"type",jsonInteger(types[r.event])},{"config",jsonInteger(configs[r.event])},{"openErrno",std::to_string(r.openError)},{"controlErrno",std::to_string(r.controlError)},{"readErrno",std::to_string(r.readError)},{"value",valid?jsonInteger(r.value):"null"},{"timeEnabledNs",valid?jsonInteger(r.timeEnabled):"null"},{"timeRunningNs",valid?jsonInteger(r.timeRunning):"null"},{"workChecksum",jsonInteger(r.checksum)}});}rows+=']';
  return jsonObject({{"scope",jsonString("short child workload under ordinary app identity; userspace only")},{"events",rows},{"pipeErrno",std::to_string(pipeError)},{"waitErrno",std::to_string(waitError)},{"requestedEvents",std::to_string(count)},{"completedReports",std::to_string(bytes/sizeof(Report))},{"timedOut",timeout?"true":"false"},{"childSignal",!waitError&&WIFSIGNALED(status)?std::to_string(WTERMSIG(status)):"null"},{"childExitCode",!waitError&&WIFEXITED(status)?std::to_string(WEXITSTATUS(status)):"null"},{"error",pipeError||waitError?jsonString("child transport or wait failed"):timeout?jsonString("child deadline"):!waitError&&WIFSIGNALED(status)?jsonString("child terminated by signal"):bytes!=sizeof(reports)||!WIFEXITED(status)||WEXITSTATUS(status)!=0?jsonString("incomplete child report"):"null"}});
}
}
