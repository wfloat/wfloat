#pragma once
#include <dlfcn.h>
#include <cstdint>
#include <cerrno>
#include <unistd.h>
// Stable XNU proc_info.h ABI; these declarations are absent from the iPhone
// headers although libproc exports the function. Keep this compatibility probe
// distinct from an iOS SDK API guarantee. Never queries another process.
struct BenchProcTaskInfo {
  uint64_t pti_virtual_size,pti_resident_size,pti_total_user,pti_total_system,pti_threads_user,pti_threads_system;
  int32_t pti_policy,pti_faults,pti_pageins,pti_cow_faults,pti_messages_sent,pti_messages_received,pti_syscalls_mach,pti_syscalls_unix,pti_csw,pti_threadnum,pti_numrunning,pti_priority;
};
struct BenchProcWorkqueueInfo {uint32_t pwq_nthreads,pwq_runthreads,pwq_blockedthreads,pwq_state;};
static_assert(sizeof(BenchProcTaskInfo)==96);static_assert(sizeof(BenchProcWorkqueueInfo)==16);
struct BenchProcBsdInfo {
  uint32_t flags,status,xstatus,pid,ppid,uid,gid,ruid,rgid,svuid,svgid,reserved;
  char comm[16],name[32];
  uint32_t nfiles,pgid,jobc,ttydev,ttypgid;int32_t nice;
  uint64_t startSeconds,startMicroseconds;
};
static_assert(sizeof(BenchProcBsdInfo)==136);
static NSDictionary *darwinProcessSources() {
  using Fn=int(*)(int,int,uint64_t,void *,int);static Fn query=(Fn)dlsym(RTLD_DEFAULT,"proc_pidinfo");
  if(!query)return @{@"error":@"proc_pidinfo symbol unavailable"};
  NSMutableArray *rows=[NSMutableArray new];
  {BenchProcTaskInfo v{};errno=0;const int count=query(getpid(),4,0,&v,sizeof(v)),saved=errno;NSMutableDictionary *values=[NSMutableDictionary new];
#define BENCH_PROC(field) values[@#field]=std::is_signed<decltype(v.field)>::value?signedExact(v.field):exact(v.field)
    if(count==sizeof(v)){BENCH_PROC(pti_virtual_size);BENCH_PROC(pti_resident_size);BENCH_PROC(pti_total_user);BENCH_PROC(pti_total_system);BENCH_PROC(pti_threads_user);BENCH_PROC(pti_threads_system);BENCH_PROC(pti_policy);BENCH_PROC(pti_faults);BENCH_PROC(pti_pageins);BENCH_PROC(pti_cow_faults);BENCH_PROC(pti_messages_sent);BENCH_PROC(pti_messages_received);BENCH_PROC(pti_syscalls_mach);BENCH_PROC(pti_syscalls_unix);BENCH_PROC(pti_csw);BENCH_PROC(pti_threadnum);BENCH_PROC(pti_numrunning);BENCH_PROC(pti_priority);}
    [rows addObject:@{@"flavor":@"PROC_PIDTASKINFO",@"returnedBytes":@(count),@"expectedBytes":@(sizeof(v)),@"errno":@(saved),@"values":count==sizeof(v)?values:(id)NSNull.null}];}
  {BenchProcWorkqueueInfo v{};errno=0;const int count=query(getpid(),12,0,&v,sizeof(v)),saved=errno;NSMutableDictionary *values=[NSMutableDictionary new];
    if(count==sizeof(v)){BENCH_PROC(pwq_nthreads);BENCH_PROC(pwq_runthreads);BENCH_PROC(pwq_blockedthreads);BENCH_PROC(pwq_state);}
    [rows addObject:@{@"flavor":@"PROC_PIDWORKQUEUEINFO",@"returnedBytes":@(count),@"expectedBytes":@(sizeof(v)),@"errno":@(saved),@"values":count==sizeof(v)?values:(id)NSNull.null}];}
  {uint32_t v[2]{};errno=0;const int count=query(getpid(),32,0,v,sizeof(v)),error=count<=0?errno:0;
    [rows addObject:@{@"flavor":@"PROC_PIDIPCTABLEINFO",@"returnedBytes":@(count),@"expectedBytes":@(sizeof(v)),@"errno":@(error),@"values":count==sizeof(v)?@{@"table_size":exact(v[0]),@"table_free":exact(v[1])}:(id)NSNull.null}];}
  {BenchProcBsdInfo v{};errno=0;const int count=query(getpid(),3,0,&v,sizeof(v)),saved=errno;
    NSMutableDictionary *values=[NSMutableDictionary new];
    if(count==sizeof(v)){BENCH_PROC(flags);BENCH_PROC(status);BENCH_PROC(xstatus);BENCH_PROC(pid);BENCH_PROC(ppid);BENCH_PROC(uid);BENCH_PROC(gid);BENCH_PROC(ruid);BENCH_PROC(rgid);BENCH_PROC(svuid);BENCH_PROC(svgid);BENCH_PROC(nfiles);BENCH_PROC(pgid);BENCH_PROC(jobc);BENCH_PROC(ttydev);BENCH_PROC(ttypgid);BENCH_PROC(nice);BENCH_PROC(startSeconds);BENCH_PROC(startMicroseconds);}
    [rows addObject:@{@"flavor":@"PROC_PIDTBSDINFO",@"returnedBytes":@(count),@"expectedBytes":@(sizeof(v)),@"errno":@(saved),@"values":count==sizeof(v)?values:(id)NSNull.null,@"scope":@"self process state/flags/nice/start time; nfiles is allocated descriptor-table capacity, not open descriptor count; reserved/name bytes omitted"}];}
  {struct Fileport {uint32_t port,type;};Fileport ports[1024]{};errno=0;const int count=query(getpid(),14,0,ports,sizeof(ports)),saved=errno;
    const bool valid=count>=0 && count<=sizeof(ports) && count%sizeof(Fileport)==0 && saved==0;NSMutableArray *values=[NSMutableArray new];
    if(valid)for(int i=0;i<count/sizeof(Fileport);++i)[values addObject:@{@"portName":exact(ports[i].port),@"nativeFileType":exact(ports[i].type)}];
    [rows addObject:@{@"flavor":@"PROC_PIDLISTFILEPORTS",@"returnedBytes":@(count),@"errno":@(saved),@"valid":@(valid),@"capacityRecords":@1024,@"possiblyTruncated":@(count==sizeof(ports)),@"values":values,@"scope":@"own Mach fileport rights backed by file objects; distinct from integer descriptors; observation only, no duplication or rights changes"}];}
#undef BENCH_PROC
  return @{@"queries":rows,@"scope":@"self process Darwin ABI compatibility probe; Mach absolute CPU time units and signed accounting; running/workqueue counts are snapshots, not interval utilization",@"error":NSNull.null};
}

// Historical realtime-thread page faults. The kernel copies its ring without
// consuming it; records can recur across snapshots. No realtime policy is set.
static NSDictionary *darwinRealtimeFaultSources() {
  using Fn=int(*)(int,int,uint64_t,void *,int);static Fn query=(Fn)dlsym(RTLD_DEFAULT,"proc_pidinfo");
  if(!query)return @{@"error":@"proc_pidinfo unavailable"};
  struct Record {uint64_t start,duration,address,pc,tid,uniquePid,type;};static_assert(sizeof(Record)==56);
  Record records[1024]{};errno=0;const int count=query(getpid(),29,0,records,sizeof(records)),saved=errno;
  const bool valid=count>=0 && count<=1024 && saved==0;NSMutableArray *rows=[NSMutableArray new];
  if(valid)for(int i=0;i<count;++i){auto &v=records[i];[rows addObject:@{@"rtfabstime":exact(v.start),@"rtfduration":exact(v.duration),@"rtfaddr":exact(v.address),@"rtfpc":exact(v.pc),@"rtftid":exact(v.tid),@"rtfupid":exact(v.uniquePid),@"rtftype":exact(v.type)}];}
  return @{@"returnedRecordCount":@(count),@"errno":@(saved),@"records":rows,@"valid":@(valid),@"capacityRecords":@1024,@"possiblyTruncated":@(count==1024 || saved==ENOMEM),@"scope":@"self-process historical realtime-thread page faults, not all page faults; bounded shared ring snapshot, repeated records possible; Mach continuous start/duration units, native addresses and fault type; no thread policy changes"};
}
