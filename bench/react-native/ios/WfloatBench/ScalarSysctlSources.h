#pragma once
#include "ScalarSysctlCatalog.h"
#include <sys/sysctl.h>
#include <chrono>
#include <cstring>
#include <cerrno>
static NSDictionary *scalarSysctlSources() {
  NSMutableArray *rows=[NSMutableArray new];const auto start=std::chrono::steady_clock::now();bool limited=false;
  for(auto &entry:benchScalarSysctls){
    if(std::chrono::steady_clock::now()-start>std::chrono::milliseconds(100)){limited=true;break;}
    uint64_t raw=0;size_t size=sizeof(raw);errno=0;
    const auto began=std::chrono::steady_clock::now();const int code=sysctlbyname(entry.name,&raw,&size,nullptr,0),error=code?errno:0;
    const auto duration=std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now()-began).count();
    NSMutableDictionary *row=[@{@"name":@(entry.name),@"declarationMacro":@(entry.macro),@"returnCode":@(code),@"errno":@(error),@"returnedBytes":@(size),@"queryDurationNs":exact(duration)} mutableCopy];
    if(!code && (size==4||size==8)){
      uint64_t unsignedValue=raw;int64_t signedValue=0;
      if(size==4){uint32_t u;int32_t s;memcpy(&u,&raw,4);memcpy(&s,&raw,4);unsignedValue=u;signedValue=s;}else memcpy(&signedValue,&raw,8);
      row[@"unsignedBitsDecimal"]=exact(unsignedValue);row[@"signedBitsDecimal"]=signedExact(signedValue);
      // Both interpretations preserve the word; the source declaration determines
      // semantics. Macro QUAD alone does not prove the C counter's signedness.
    }else row[@"valueUnavailable"]=@YES;
    if(!strcmp(entry.name,"kern.memorystatus.sysprocs_idle_delay_time_ns")||!strcmp(entry.name,"kern.memorystatus.apps_idle_delay_time_ns"))row[@"sourceSemantics"]=@"Reviewed XNU handler returns whole seconds despite the _ns name; native value retained.";
    if(!strcmp(entry.name,"net.link.generic.system.ifcount"))row[@"sourceSemantics"]=@"Native if_index high-water/index bound; not necessarily the number of currently present interfaces.";
    if(!strcmp(entry.name,"net.inet.tcp.fin_timeout"))row[@"sourceSemantics"]=@"Read returns native TCP retransmission ticks; the setter accepts milliseconds. No setter used.";
    if(!strcmp(entry.name,"net.link.generic.system.rcvq_trim_pct"))row[@"sourceSemantics"]=@"Reviewed XNU getter reads if_rcvq_burst_limit rather than if_rcvq_trim_pct. Preserve native bits; do not interpret as a trimming percentage.";
    if(!strcmp(entry.name,"net.inet.tcp.ecn_initiate_out"))row[@"sourceSemantics"]=@"Reviewed XNU handler reads the shared tcp_ecn policy, including for this compatibility alias. Not a congestion event count.";
    [rows addObject:row];
  }
  return @{@"queries":rows,@"catalogSize":@(sizeof(benchScalarSysctls)/sizeof(benchScalarSysctls[0])),@"timeLimitReached":@(limited),@"scope":@"reviewed numeric XNU VM/compressor/freezer/process/scheduler/IPC/power/network declarations; native words and per-node errors, no writes; selected custom numeric handlers reviewed separately; firmware may omit or restrict nodes; overlapping system values are not additive"};
}
