#pragma once
#import <Foundation/Foundation.h>
#include <sys/sysctl.h>
#include <cerrno>
#include <algorithm>
#include <cstring>
// Complete native statistical structures; retained losslessly even when this
// SDK lacks the matching firmware layout. Do not guess word/field boundaries.
static NSDictionary *structuredSysctlSources() {
  struct Entry {const char *name,*format;};
  const Entry catalog[]={
    {"kern.aotmetrics","IOPMAOTMetrics; power-state cycle counters, native total time and bounded sleep/wake history; zeros when inactive, reset by OS transitions"},
    {"kern.wakereason","native last wake reason text"},
    {"kern.bootreason","native boot reason text"},
    {"kern.shutdownreason","native last shutdown reason text"},
    {"kern.skywalk.features","native Skywalk capability bitset"},
    {"net.inet.ip.input_perf_data","net_perf; zero if OS accounting inactive"},
    {"net.inet.ip.output_perf_data","net_perf; zero if OS accounting inactive"},
    {"net.inet6.ip6.input_perf_data","net_perf; zero if OS accounting inactive"},
    {"net.inet6.ip6.output_perf_data","net_perf; zero if OS accounting inactive"},
    {"kern.clockrate","clockinfo"},
    {"vm.loadavg","user64_loadavg"},
    {"kern.zone_map_size_and_capacity","uint64 current zone-map size, capacity"},
    {"kern.skywalk.stats.net_if","sk_stats_net_if[]"},
    {"kern.skywalk.stats.flow_switch","sk_stats_flow_switch[]"},
    {"kern.skywalk.stats.netif_queue","netif_qstats_info[]"},
    {"kern.sched_stats","_processor_statistics_np[]; requires existing OS scheduler accounting enablement"},
    {"vm.malloc_ranges","own VM allocator range boundaries, native text"},
    {"kern.coalition_page_count","uint64 page counts per own-process coalition type"},
    {"net.filter_state","native network filter state string"},
    {"net.link.generic.system.tx_chain_len_stats","chain_len_stats"},
    {"net.link.generic.system.port_used.stats","if_ports_used_stats"},
    {"kern.boottime","user64_timeval"},
    {"kern.sleeptime","user64_timeval"},
    {"kern.waketime","user64_timeval"},
    {"machdep.remotetime.conversion_params","bt_params"},
    {"kern.stackshot_stats","stackshot_stats_t"},
    {"kern.sched_preemption_disable_stats","uint64_max_duration_per_cpu[]"},
    {"kern.ipc.mb_tag_stats","m_tag_stats[]"},
    {"net.aop.driver_stats","aop_driver_stats"},
    {"net.aop.protocol_stats","net_aop_protocol_stats"},
    {"vm.kmem_gobj_stats","kmem_gobj_stats"},
    {"kern.turnstile_boost_stats","turnstile_stats[]"},
    {"kern.turnstile_unboost_stats","turnstile_stats[]"},
    {"vm.swapusage","S,xsw_usage"},
    {"hw.cachesize","Q[]"},
    {"hw.cacheconfig","Q[]"},
    {"kern.hibernatestatistics","hibernate_statistics_t"},
    {"kern.ipc.extbkidlestat","soextbkidlestat"},
    {"kern.ipc.mb_stat","S,mb_stat"},
    {"kern.ipc.mbstat","S,mbstat"},
    {"net.api_stats","net_api_stats"},
    {"net.cfil.stats","cfil_stats"},
    {"net.inet.icmp.stats","icmpstat"},
    {"net.inet.igmp.stats","igmpstat"},
    {"net.inet.igmp.v3stats","igmpstat_v3"},
    {"net.inet.ip.linklocal.stat","ip_linklocal_stat"},
    {"net.inet.ip.stats","S,ipstat"},
    {"net.inet.ipsec.stats","ipsecstat"},
    {"net.inet.tcp.stats","S,tcpstat"},
    {"net.inet.udp.stats","S,udpstat"},
    {"net.inet6.icmp6.stats","icmp6stat"},
    {"net.inet6.ip6.rip6stats","rip6stat"},
    {"net.inet6.ip6.stats","S,ip6stat"},
    {"net.inet6.ipsec6.stats","ipsecstat"},
    {"net.key.pfkeystat","S,pfkeystat"},
    {"net.link.bridge.hostfilterstats","bridge_hostfilter_stats"},
    {"net.link.ether.inet.stats","S,arpstat"},
    {"net.stats.global_counts","nstat_global_counts"},
    {"net.stats.stats","nstat_stats"},
    {"net.systm.kctl.stats","S,kctlstat"},
    {"net.systm.kevt.stats","S,kevtstat"},
  };
  NSMutableArray *rows=[NSMutableArray new];
  for(auto &entry:catalog){
    const bool fixedCapacity=!strcmp(entry.name,"kern.sched_stats");
    size_t required=fixedCapacity?65536:0;errno=0;int code=fixedCapacity?0:sysctlbyname(entry.name,nullptr,&required,nullptr,0),error=code?errno:0;
    NSMutableDictionary *row=[@{@"name":@(entry.name),@"nativeFormat":@(entry.format),@"sizingReturnCode":@(code),@"sizingErrno":@(error),@"requiredBytesAtSizing":@(required)} mutableCopy];
    if(!code&&!required){row[@"returnCode"]=@0;row[@"errno"]=@0;row[@"returnedBytes"]=@0;row[@"rawBase64"]=@"";row[@"possiblyTruncated"]=@NO;}
    if(fixedCapacity)row[@"sizingStrategy"]=@"64 KiB fixed bound; handler does not support a size-only query. No enablement changes.";
    if(!code && required){
      const size_t cap=65536;NSMutableData *data=[NSMutableData dataWithLength:std::min(required,cap)];size_t length=data.length;errno=0;
      const int readCode=sysctlbyname(entry.name,data.mutableBytes,&length,nullptr,0),readError=readCode?errno:0;
      row[@"returnCode"]=@(readCode);row[@"errno"]=@(readError);row[@"returnedBytes"]=@(length);row[@"possiblyTruncated"]=@(required>cap||readError==ENOMEM||length>data.length);
      if(!readCode&&length<=data.length){data.length=length;row[@"rawBase64"]=[data base64EncodedStringWithOptions:0];}
    }
    [rows addObject:row];
  }
  // The IPCS input selects a read-only configuration operation. Do not use
  // SHM_CONF/ITER: that handler initializes the global shared-memory subsystem.
  struct IpcsCommand {int32_t magic,operation,cursor,dataLength;uint64_t address;};
  static_assert(sizeof(IpcsCommand)==24);
  const char *semNames[]={"semmap","semmni","semmns","semmnu","semmsl","semopm","semume","semusz","semvmx","semaem"};
  const char *msgNames[]={"msgmax","msgmni","msgmnb","msgtql","msgssz","msgseg"};
  for(int i=0;i<2;++i){int32_t words[10]{};const int count=i?6:10;const char *name=i?"kern.sysv.ipcs.msg":"kern.sysv.ipcs.sem";IpcsCommand command{1,i?0x100:0x10,0,count*4,reinterpret_cast<uint64_t>(words)},returned{};size_t length=sizeof(returned);errno=0;int code=sysctlbyname(name,&returned,&length,&command,sizeof(command)),error=code?errno:0;
    NSMutableDictionary *row=[@{@"name":@(name),@"nativeFormat":i?@"msginfo":@"seminfo",@"returnCode":@(code),@"errno":@(error),@"commandReturnedBytes":@(length),@"operation":@(command.operation),@"scope":@"IPCS configuration read only; semaphore fields describe allocated pool limits and configuration, not active object counts; no subsystem initialization or iteration requested"} mutableCopy];
    if(!code){NSMutableDictionary *values=[NSMutableDictionary new];for(int j=0;j<count;++j)values[@(i?msgNames[j]:semNames[j])]=[NSString stringWithFormat:@"%d",words[j]];row[@"fields"]=values;row[@"returnedBytes"]=@(count*4);row[@"rawBase64"]=[[NSData dataWithBytes:words length:count*4] base64EncodedStringWithOptions:0];row[@"possiblyTruncated"]=@NO;}[rows addObject:row];
  }
  return @{@"queries":rows,@"scope":@"complete native XNU resource/configuration structures and selected native text; bytes require matching kernel ABI before interpretation; global accounting, not app-only traffic. No resets, packet contents or socket address lists. Some kernels redact counters to zero."};
}
