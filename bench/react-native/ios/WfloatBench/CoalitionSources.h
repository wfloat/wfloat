#pragma once
#include <dlfcn.h>
#include <array>
#include <cerrno>
#include <cstring>
// Published XNU ABI. Read only our process's resource coalition; no membership,
// ledger, efficiency or naming changes. Kernel copyout does not return its size.
static NSDictionary *coalitionSources() {
  using PidInfo=int(*)(int,int,uint64_t,void *,int);
  using Usage=int(*)(uint64_t,void *,size_t);
  static auto pidInfo=(PidInfo)dlsym(RTLD_DEFAULT,"proc_pidinfo");
  static auto usage=(Usage)dlsym(RTLD_DEFAULT,"coalition_info_resource_usage");
  if(!pidInfo||!usage)return @{@"error":@"coalition query symbol unavailable"};
  std::array<uint64_t,5> ids{};errno=0;
  const int returned=pidInfo(getpid(),20,0,ids.data(),sizeof(ids)),saved=errno;
  if(returned!=sizeof(ids))return @{@"error":@"self coalition identity query failed",@"returnedBytes":@(returned),@"expectedBytes":@(sizeof(ids)),@"errno":@(saved)};
  NSArray *names=@[@"tasks_started",@"tasks_exited",@"time_nonempty",@"cpu_time",@"interrupt_wakeups",@"platform_idle_wakeups",@"bytesread",@"byteswritten",@"gpu_time",@"cpu_time_billed_to_me",@"cpu_time_billed_to_others",@"energy",@"logical_immediate_writes",@"logical_deferred_writes",@"logical_invalidated_writes",@"logical_metadata_writes",@"logical_immediate_writes_to_external",@"logical_deferred_writes_to_external",@"logical_invalidated_writes_to_external",@"logical_metadata_writes_to_external",@"energy_billed_to_me",@"energy_billed_to_others",@"cpu_ptime",@"cpu_time_eqos_len",@"cpu_time_eqos[0]",@"cpu_time_eqos[1]",@"cpu_time_eqos[2]",@"cpu_time_eqos[3]",@"cpu_time_eqos[4]",@"cpu_time_eqos[5]",@"cpu_time_eqos[6]",@"cpu_instructions",@"cpu_cycles",@"fs_metadata_writes",@"pm_writes",@"cpu_pinstructions",@"cpu_pcycles",@"conclave_mem",@"ane_mach_time",@"ane_energy_nj",@"phys_footprint",@"gpu_energy_nj",@"gpu_energy_nj_billed_to_me",@"gpu_energy_nj_billed_to_others",@"swapins"];
  NSMutableArray *samples=[NSMutableArray new];
  for(uint64_t fill:{UINT64_C(0xa5a5a5a5a5a5a5a5),UINT64_C(0x5a5a5a5a5a5a5a5a)}) {
    std::array<uint64_t,45> raw;raw.fill(fill);
    const double began=NSProcessInfo.processInfo.systemUptime;errno=0;
    const int status=usage(ids[0],raw.data(),sizeof(raw)),error=errno;
    const double ended=NSProcessInfo.processInfo.systemUptime;
    NSMutableDictionary *values=[NSMutableDictionary new];NSMutableArray *untouched=[NSMutableArray new];
    if(status==0)for(NSUInteger i=0;i<raw.size();++i){
      // Conservative: an unchanged word is unavailable/ambiguous, never zero.
      // A second different fill distinguishes an unwritten tail from a genuine
      // counter equal to one fill. The two calls are separate observations.
      values[names[i]]=raw[i]==fill?(id)NSNull.null:exact(raw[i]);
      if(raw[i]==fill)[untouched addObject:names[i]];
    }
    NSData *data=[NSData dataWithBytes:raw.data() length:sizeof(raw)];
    [samples addObject:@{@"queryStartedUptimeSeconds":@(began),@"queryFinishedUptimeSeconds":@(ended),@"status":@(status),@"errno":@(error),@"requestedBytes":@(sizeof(raw)),@"fillWord":exact(fill),@"rawBytesBase64":[data base64EncodedStringWithOptions:0],@"values":status==0?values:(id)NSNull.null,@"unchangedWords":untouched}];
  }
  return @{@"resourceCoalitionId":exact(ids[0]),@"jetsamCoalitionId":exact(ids[1]),@"samples":samples,@"error":NSNull.null,@"scope":@"own resource coalition, may include multiple processes and exited members; published XNU native units; kernel does not return copied size, so untouched tail words stay null and two differently filled calls remain separate snapshots; no calibrated energy or NPU utilization claim"};
}
