#pragma once
#include "ClockDisciplineSource.h"
#include "NativeJson.h"
#include "PosixResourceLimits.h"
#include "MountedFilesystemSources.h"
#include "FileResourceSources.h"
#include "ResourceUsageSources.h"
#include <malloc.h>
#include <sys/resource.h>
#include <sys/sysinfo.h>
#include <sys/vfs.h>
#include <sys/utsname.h>
#include <sys/auxv.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sched.h>
#include <time.h>
#include <unistd.h>
#include <cerrno>
#include <cstdio>
#include <cstring>
#include <vector>
namespace bench {
inline std::string androidResourceSources() {
  const auto m=mallinfo2();
  const auto heap=jsonObject({{"arena",jsonInteger(m.arena)},{"ordblks",jsonInteger(m.ordblks)},{"smblks",jsonInteger(m.smblks)},{"hblks",jsonInteger(m.hblks)},{"hblkhd",jsonInteger(m.hblkhd)},{"usmblks",jsonInteger(m.usmblks)},{"fsmblks",jsonInteger(m.fsmblks)},{"uordblks",jsonInteger(m.uordblks)},{"fordblks",jsonInteger(m.fordblks)},{"keepcost",jsonInteger(m.keepcost)}});
  std::string limits="[";
  const int resources[]={RLIMIT_AS,RLIMIT_CORE,RLIMIT_CPU,RLIMIT_DATA,RLIMIT_FSIZE,RLIMIT_LOCKS,RLIMIT_MEMLOCK,RLIMIT_MSGQUEUE,RLIMIT_NICE,RLIMIT_NOFILE,RLIMIT_NPROC,RLIMIT_RSS,RLIMIT_RTPRIO,RLIMIT_RTTIME,RLIMIT_SIGPENDING,RLIMIT_STACK};
  const char *names[]={"AS","CORE","CPU","DATA","FSIZE","LOCKS","MEMLOCK","MSGQUEUE","NICE","NOFILE","NPROC","RSS","RTPRIO","RTTIME","SIGPENDING","STACK"};
  for(size_t i=0;i<sizeof(resources)/sizeof(resources[0]);++i){if(i)limits+=',';rlimit v{};const int e=getrlimit(resources[i],&v)==0?0:errno;limits+=jsonObject({{"name",jsonString(names[i])},{"errno",std::to_string(e)},{"soft",e?"null":jsonInteger(v.rlim_cur)},{"hard",e?"null":jsonInteger(v.rlim_max)}});}limits+=']';
  std::string clocks="[";const clockid_t ids[]={CLOCK_REALTIME,CLOCK_MONOTONIC,CLOCK_MONOTONIC_RAW,CLOCK_BOOTTIME,CLOCK_PROCESS_CPUTIME_ID,CLOCK_THREAD_CPUTIME_ID,CLOCK_REALTIME_COARSE,CLOCK_MONOTONIC_COARSE};
  const char *clockNames[]={"REALTIME","MONOTONIC","MONOTONIC_RAW","BOOTTIME","PROCESS_CPUTIME_ID","THREAD_CPUTIME_ID","REALTIME_COARSE","MONOTONIC_COARSE"};
  for(size_t i=0;i<sizeof(ids)/sizeof(ids[0]);++i){if(i)clocks+=',';timespec t{},r{};const int te=clock_gettime(ids[i],&t)==0?0:errno,re=clock_getres(ids[i],&r)==0?0:errno;clocks+=jsonObject({{"name",jsonString(clockNames[i])},{"timeErrno",std::to_string(te)},{"resolutionErrno",std::to_string(re)},{"seconds",te?"null":jsonInteger(t.tv_sec)},{"nanoseconds",te?"null":jsonInteger(t.tv_nsec)},{"resolutionSeconds",re?"null":jsonInteger(r.tv_sec)},{"resolutionNanoseconds",re?"null":jsonInteger(r.tv_nsec)}});}clocks+=']';
  struct sysinfo si{};const int se=sysinfo(&si)==0?0:errno;
  const auto system=jsonObject({{"errno",std::to_string(se)},{"uptime",se?"null":jsonInteger(si.uptime)},{"load1",se?"null":jsonInteger(si.loads[0])},{"load5",se?"null":jsonInteger(si.loads[1])},{"load15",se?"null":jsonInteger(si.loads[2])},{"loadShift",std::to_string(SI_LOAD_SHIFT)},{"totalram",se?"null":jsonInteger(si.totalram)},{"freeram",se?"null":jsonInteger(si.freeram)},{"sharedram",se?"null":jsonInteger(si.sharedram)},{"bufferram",se?"null":jsonInteger(si.bufferram)},{"totalswap",se?"null":jsonInteger(si.totalswap)},{"freeswap",se?"null":jsonInteger(si.freeswap)},{"procs",se?"null":jsonInteger(si.procs)},{"totalhigh",se?"null":jsonInteger(si.totalhigh)},{"freehigh",se?"null":jsonInteger(si.freehigh)},{"mem_unit",se?"null":jsonInteger(si.mem_unit)}});
  timespec quantum{};const int qe=sched_rr_get_interval(0,&quantum)==0?0:errno;
  const int cpu=sched_getcpu(),ce=cpu<0?errno:0;errno=0;const int priority=getpriority(PRIO_PROCESS,0),pe=errno;
  const auto scheduler=jsonObject({{"callingThreadId",jsonInteger(gettid())},{"currentCpu",std::to_string(cpu)},{"cpuErrno",std::to_string(ce)},{"nice",std::to_string(priority)},{"niceErrno",std::to_string(pe)},{"rrIntervalErrno",std::to_string(qe)},{"rrIntervalSeconds",qe?"null":jsonInteger(quantum.tv_sec)},{"rrIntervalNanoseconds",qe?"null":jsonInteger(quantum.tv_nsec)}});
  struct statfs fs{};const int fe=statfs("/data",&fs)==0?0:errno;
  const auto filesystem=jsonObject({{"path",jsonString("/data")},{"errno",std::to_string(fe)},{"f_type",fe?"null":jsonInteger(fs.f_type)},{"f_bsize",fe?"null":jsonInteger(fs.f_bsize)},{"f_blocks",fe?"null":jsonInteger(fs.f_blocks)},{"f_bfree",fe?"null":jsonInteger(fs.f_bfree)},{"f_bavail",fe?"null":jsonInteger(fs.f_bavail)},{"f_files",fe?"null":jsonInteger(fs.f_files)},{"f_ffree",fe?"null":jsonInteger(fs.f_ffree)},{"f_namelen",fe?"null":jsonInteger(fs.f_namelen)},{"f_frsize",fe?"null":jsonInteger(fs.f_frsize)},{"f_flags",fe?"null":jsonInteger(fs.f_flags)}});
  std::vector<char> buffer(262145);FILE *fp=fmemopen(buffer.data(),buffer.size(),"w");int xmlError=fp?0:errno,xmlCode=-1;bool truncated=false;
  if(fp){errno=0;xmlCode=malloc_info(0,fp);xmlError=errno;fflush(fp);truncated=ferror(fp)!=0;fclose(fp);}
  const auto xml=jsonObject({{"returnCode",std::to_string(xmlCode)},{"errno",std::to_string(xmlError)},{"possiblyTruncated",truncated?"true":"false"},{"text",jsonString(std::string(buffer.data(),strnlen(buffer.data(),buffer.size())))}});
  std::string aux="[";const unsigned long auxKeys[]={AT_HWCAP,AT_HWCAP2,AT_CLKTCK,AT_PAGESZ,AT_MINSIGSTKSZ};const char *auxNames[]={"AT_HWCAP","AT_HWCAP2","AT_CLKTCK","AT_PAGESZ","AT_MINSIGSTKSZ"};
  for(size_t i=0;i<5;++i){if(i)aux+=',';errno=0;const auto value=getauxval(auxKeys[i]);const int e=errno;aux+=jsonObject({{"name",jsonString(auxNames[i])},{"errno",std::to_string(e)},{"value",e?"null":jsonInteger(value)}});}aux+=']';
  std::string controls="[";const int options[]={PR_GET_TIMERSLACK,PR_GET_NO_NEW_PRIVS,PR_GET_SECCOMP,PR_GET_DUMPABLE,PR_GET_THP_DISABLE,PR_GET_TAGGED_ADDR_CTRL,PR_SVE_GET_VL,PR_SME_GET_VL};const char *optionNames[]={"PR_GET_TIMERSLACK","PR_GET_NO_NEW_PRIVS","PR_GET_SECCOMP","PR_GET_DUMPABLE","PR_GET_THP_DISABLE","PR_GET_TAGGED_ADDR_CTRL","PR_SVE_GET_VL","PR_SME_GET_VL"};
  for(size_t i=0;i<8;++i){if(i)controls+=',';errno=0;const long value=syscall(__NR_prctl,options[i],0UL,0UL,0UL,0UL);const int e=value<0?errno:0;controls+=jsonObject({{"name",jsonString(optionNames[i])},{"errno",std::to_string(e)},{"value",e?"null":jsonInteger(value)}});}controls+=']';
  struct utsname unameValue{};const int ue=uname(&unameValue)==0?0:errno;
  return jsonObject({{"clockDiscipline",clockDisciplineSource()},{"statxFiles",fileResourceSources(false)},{"fileCache",fileResourceSources(true)},{"mountedFilesystems",mountedFilesystemSources()},{"posixResourceLimits",posixResourceLimits("/data")},{"rusageChildren",scopedResourceUsage(RUSAGE_CHILDREN)},{"rusageCallingThread",scopedResourceUsage(RUSAGE_THREAD)},{"auxv",aux},{"prctlCallingThread",controls},{"unameMachine",ue?"null":jsonString(unameValue.machine)},{"unameErrno",std::to_string(ue)},{"mallinfo2",heap},{"malloc_info",xml},{"getrlimit",limits},{"rlimInfinity",jsonInteger(RLIM_INFINITY)},{"clocks",clocks},{"sysinfo",system},{"callingThreadScheduler",scheduler},{"statfs",filesystem}});
}
}
