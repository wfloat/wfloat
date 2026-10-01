#include "PurgeableQueueProbe.h"
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <MetricKit/MetricKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#include <atomic>
#include <mach/mach.h>
#include <mach/mach_time.h>
#include <mach/thread_policy.h>
#include <mach/task_policy.h>
#include <arm/cpu_capabilities_public.h>
#include <malloc/malloc.h>
#include <mach/vm_region.h>
#include <sys/resource.h>
#include <sys/statvfs.h>
#include <sys/mount.h>
#include <time.h>
#include <sys/sysctl.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <dirent.h>
#include <unistd.h>
#include <cerrno>
#include <cstddef>
#include <type_traits>
#include "../../cpp/SourceCapture.h"
#include "LedgerSources.h"
#include "../../cpp/PageStateProbe.h"
#include "../../cpp/SocketSignalProbe.h"
#include "../../cpp/AppleInterfaceSources.h"
extern "C" int proc_pid_rusage(int pid, int flavor, rusage_info_t *buffer);

static NSString *exact(uint64_t n) { return [NSString stringWithFormat:@"%llu",(unsigned long long)n]; }
static NSString *signedExact(int64_t n) { return [NSString stringWithFormat:@"%lld",(long long)n]; }
#include "MetalSignalProbe.h"
#include "FrameSignalProbe.h"
#include "DisplaySignalSources.h"
#include "PowerRegistrySource.h"
#include "IOReportCatalog.h"
#include "../../cpp/ClockDisciplineSource.h"
#include "HIDSensorSources.h"
#include "PerformanceCounterSources.h"
#include "DarwinQueueSources.h"
#include "DarwinProcessSources.h"
#include "DarwinThreadAccounting.h"
#include "ScalarSysctlSources.h"
#include "StructuredSysctlSources.h"
#include "VolumeResourceSources.h"
#include "AllocatorZoneSources.h"
#include "../../cpp/PosixResourceLimits.h"
#include "../../cpp/IntervalTimerSources.h"
#include "CoalitionSources.h"
struct MetricKitCapture {
  bench::SourceCapture writer{32*1024*1024,128*1024*1024,"metrickit"};
  uint64_t received=0;
  std::string state="no_payload_received";
};
static double stamp() { return NSProcessInfo.processInfo.systemUptime*1000.; }
// A successful struct query can still return a shorter version. Never manufacture
// zeros from the initialized but unreturned tail. Native integer strings are exact.
#define FIELD(field) if (offsetof(decltype(v), field)+sizeof(v.field)<=size_t(count)*sizeof(natural_t)) values[@#field]=std::is_signed<decltype(v.field)>::value ? signedExact(v.field) : exact(v.field)


#include "MachIpcProbe.h"

// The task_threads rights keep each identity stable across these sequential reads.
// Defaults are retained explicitly; an affinity tag is not a CPU mask.
static NSDictionary *threadScheduling() {
  struct Ports {
    thread_act_array_t list=nullptr;mach_msg_type_number_t count=0;
    ~Ports() {if(list) {for(mach_msg_type_number_t i=0;i<count;++i) mach_port_deallocate(mach_task_self(),list[i]);vm_deallocate(mach_task_self(),(vm_address_t)list,count*sizeof(thread_t));}}
  } ports;
  const auto code=task_threads(mach_task_self(),&ports.list,&ports.count);
  if(code!=KERN_SUCCESS) return @{ @"error":@(code) };
  NSMutableArray *threads=[NSMutableArray new];NSDictionary *perfLevels=darwinPerfLevelNames();const double start=stamp();bool deadline=false;
  for(mach_msg_type_number_t i=0;i<ports.count && i<512;++i) {
    if(stamp()-start>250) {deadline=true;break;}
    const double began=stamp();const auto thread=ports.list[i];NSMutableArray *queries=[NSMutableArray new];
    thread_identifier_info_data_t identity{};mach_msg_type_number_t identityCount=THREAD_IDENTIFIER_INFO_COUNT;
    const auto identityCode=thread_info(thread,THREAD_IDENTIFIER_INFO,(thread_info_t)&identity,&identityCount);
    {thread_extended_info_data_t v{};mach_msg_type_number_t count=THREAD_EXTENDED_INFO_COUNT;
      const auto result=thread_info(thread,THREAD_EXTENDED_INFO,(thread_info_t)&v,&count);NSMutableDictionary *values=[NSMutableDictionary new];
      if(result==KERN_SUCCESS) {
        FIELD(pth_user_time);FIELD(pth_system_time);FIELD(pth_cpu_usage);FIELD(pth_policy);FIELD(pth_run_state);FIELD(pth_flags);FIELD(pth_sleep_time);FIELD(pth_curpri);FIELD(pth_priority);FIELD(pth_maxpriority);
        if(offsetof(decltype(v),pth_name)+sizeof(v.pth_name)<=count*sizeof(natural_t)) values[@"pth_name"]=[[NSString alloc] initWithBytes:v.pth_name length:strnlen(v.pth_name,sizeof(v.pth_name)) encoding:NSUTF8StringEncoding]?: (id)NSNull.null;
      }
      [queries addObject:@{@"source":@"THREAD_EXTENDED_INFO",@"returnCode":@(result),@"returnedCount":@(count),@"values":result==KERN_SUCCESS?values:(id)NSNull.null}];
    }
    {policy_timeshare_info_data_t v{};mach_msg_type_number_t count=POLICY_TIMESHARE_INFO_COUNT;const auto code=thread_info(thread,THREAD_SCHED_TIMESHARE_INFO,(thread_info_t)&v,&count);NSMutableDictionary *values=[NSMutableDictionary new];
      if(code==KERN_SUCCESS) {FIELD(max_priority);FIELD(base_priority);FIELD(cur_priority);FIELD(depressed);FIELD(depress_priority);}
      [queries addObject:@{@"source":@"THREAD_SCHED_TIMESHARE_INFO",@"returnCode":@(code),@"returnedCount":@(count),@"values":code==KERN_SUCCESS?values:(id)NSNull.null}];
    }
    {policy_rr_info_data_t v{};mach_msg_type_number_t count=POLICY_RR_INFO_COUNT;const auto code=thread_info(thread,THREAD_SCHED_RR_INFO,(thread_info_t)&v,&count);NSMutableDictionary *values=[NSMutableDictionary new];
      if(code==KERN_SUCCESS) {FIELD(max_priority);FIELD(base_priority);FIELD(quantum);FIELD(depressed);FIELD(depress_priority);}
      [queries addObject:@{@"source":@"THREAD_SCHED_RR_INFO",@"returnCode":@(code),@"returnedCount":@(count),@"values":code==KERN_SUCCESS?values:(id)NSNull.null}];
    }
    {policy_fifo_info_data_t v{};mach_msg_type_number_t count=POLICY_FIFO_INFO_COUNT;const auto code=thread_info(thread,THREAD_SCHED_FIFO_INFO,(thread_info_t)&v,&count);NSMutableDictionary *values=[NSMutableDictionary new];
      if(code==KERN_SUCCESS) {FIELD(max_priority);FIELD(base_priority);FIELD(depressed);FIELD(depress_priority);}
      [queries addObject:@{@"source":@"THREAD_SCHED_FIFO_INFO",@"returnCode":@(code),@"returnedCount":@(count),@"values":code==KERN_SUCCESS?values:(id)NSNull.null}];
    }
    // These public policy structs consist of one to four 32-bit native words.
    const int flavors[]={THREAD_EXTENDED_POLICY,THREAD_PRECEDENCE_POLICY,THREAD_TIME_CONSTRAINT_POLICY,THREAD_AFFINITY_POLICY,THREAD_BACKGROUND_POLICY,THREAD_LATENCY_QOS_POLICY,THREAD_THROUGHPUT_QOS_POLICY};
    NSArray *labels=@[@"THREAD_EXTENDED_POLICY",@"THREAD_PRECEDENCE_POLICY",@"THREAD_TIME_CONSTRAINT_POLICY",@"THREAD_AFFINITY_POLICY",@"THREAD_BACKGROUND_POLICY",@"THREAD_LATENCY_QOS_POLICY",@"THREAD_THROUGHPUT_QOS_POLICY"];
    NSArray *keys=@[@[@"timeshare"],@[@"importance"],@[@"period",@"computation",@"constraint",@"preemptible"],@[@"affinity_tag"],@[@"priority"],@[@"thread_latency_qos_tier"],@[@"thread_throughput_qos_tier"]];
    for(unsigned j=0;j<sizeof(flavors)/sizeof(flavors[0]);++j) {
      integer_t words[4]{};mach_msg_type_number_t count=(mach_msg_type_number_t)[keys[j] count];boolean_t defaults=FALSE;
      const auto result=thread_policy_get(thread,flavors[j],words,&count,&defaults);NSMutableDictionary *values=[NSMutableDictionary new];
      if(result==KERN_SUCCESS) for(NSUInteger k=0;k<std::min<NSUInteger>(count,[keys[j] count]);++k) values[keys[j][k]]=(j==2 && k<3)?exact((uint32_t)words[k]):signedExact(words[k]);
      [queries addObject:@{@"source":labels[j],@"returnCode":@(result),@"returnedCount":@(count),@"defaultPolicy":@(defaults),@"values":result==KERN_SUCCESS?values:(id)NSNull.null}];
    }
    if(identityCode==KERN_SUCCESS && identityCount>=THREAD_IDENTIFIER_INFO_COUNT)[queries addObjectsFromArray:darwinThreadAccounting(identity.thread_id)];
    [threads addObject:@{@"threadId":identityCode==KERN_SUCCESS && identityCount>=THREAD_IDENTIFIER_INFO_COUNT?exact(identity.thread_id):(id)NSNull.null,@"identityReturnCode":@(identityCode),@"queryStartedUptimeMs":@(began),@"queryFinishedUptimeMs":@(stamp()),@"queries":queries}];
  }
  return @{@"perfLevels":perfLevels,@"threads":threads,@"enumerated":@(ports.count),@"scanned":@(threads.count),@"complete":@(threads.count==ports.count),@"timeLimit":@(deadline),@"error":NSNull.null};
}

@interface BenchSignals : NSObject <RCTBridgeModule,RCTInvalidating,MXMetricManagerSubscriber> {
  std::atomic<bool> _foreground, _closed;
  dispatch_queue_t _queue;
  uint64_t _sequence;
  BOOL _batteryWasEnabled;
  MetricKitCapture _metricKit;
  NSDictionary *_pageProbe;
  NSDictionary *_gpuProbe;
  NSDictionary *_socketProbe;
  NSDictionary *_ipcProbe;
  BenchFrameSignalProbe *_frameProbe;
  dispatch_source_t _pressureSource;
  NSMutableArray *_osEvents;
  uint64_t _osEventCount;
}
@end
@implementation BenchSignals
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return YES; }
- (instancetype)init {
  if((self=[super init])) {
    _queue=dispatch_queue_create("com.wfloat.bench.signals",DISPATCH_QUEUE_SERIAL);
    _foreground.store(UIApplication.sharedApplication.applicationState==UIApplicationStateActive);
    _closed.store(false); _sequence=0;_frameProbe=[BenchFrameSignalProbe new];_osEvents=[NSMutableArray new];_osEventCount=0;
    _pressureSource=dispatch_source_create(DISPATCH_SOURCE_TYPE_MEMORYPRESSURE,0,DISPATCH_MEMORYPRESSURE_NORMAL|DISPATCH_MEMORYPRESSURE_WARN|DISPATCH_MEMORYPRESSURE_CRITICAL,_queue);
    if(_pressureSource){__weak BenchSignals *weakSelf=self;dispatch_source_set_event_handler(_pressureSource,^{BenchSignals *strongSelf=weakSelf;if(!strongSelf||!strongSelf->_foreground.load()||strongSelf->_closed.load())return;
      [strongSelf appendOsEvent:@{@"kind":@"dispatch_memorypressure",@"flags":exact(dispatch_source_get_data(strongSelf->_pressureSource)),@"receivedAtMs":@(NSDate.date.timeIntervalSince1970*1000.),@"receivedUptimeMs":@(stamp())}];});dispatch_resume(_pressureSource);}
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(thermalChanged:) name:NSProcessInfoThermalStateDidChangeNotification object:nil];
    for(NSNotificationName name in @[NSProcessInfoPowerStateDidChangeNotification,UIDeviceBatteryLevelDidChangeNotification,UIDeviceBatteryStateDidChangeNotification]) [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(powerChanged:) name:name object:nil];
    _batteryWasEnabled=UIDevice.currentDevice.batteryMonitoringEnabled;
    UIDevice.currentDevice.batteryMonitoringEnabled=YES;
    [MXMetricManager.sharedManager addSubscriber:self];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(resumed:) name:UIApplicationDidBecomeActiveNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(paused:) name:UIApplicationWillResignActiveNotification object:nil];
  } return self;
}
- (dispatch_queue_t)methodQueue { return _queue; }
- (void)appendOsEvent:(NSDictionary *)event {++_osEventCount;if(_osEvents.count>=64)[_osEvents removeObjectAtIndex:0];[_osEvents addObject:event];}
- (void)thermalChanged:(NSNotification *)notification {
  if(!_foreground.load()||_closed.load())return;NSDictionary *event=@{@"kind":@"thermal_state_notification",@"thermalState":@((NSInteger)NSProcessInfo.processInfo.thermalState),@"receivedAtMs":@(NSDate.date.timeIntervalSince1970*1000.),@"receivedUptimeMs":@(stamp())};
  dispatch_async(_queue,^{if(!self->_closed.load())[self appendOsEvent:event];});
}
- (void)powerChanged:(NSNotification *)notification {
  if(!_foreground.load()||_closed.load())return;NSDictionary *event=@{@"kind":@"power_battery_notification",@"notification":notification.name,@"lowPowerMode":@(NSProcessInfo.processInfo.lowPowerModeEnabled),@"batteryState":@((NSInteger)UIDevice.currentDevice.batteryState),@"batteryLevel":@(UIDevice.currentDevice.batteryLevel),@"receivedAtMs":@(NSDate.date.timeIntervalSince1970*1000.),@"receivedUptimeMs":@(stamp())};
  dispatch_async(_queue,^{if(!self->_closed.load())[self appendOsEvent:event];});
}
- (void)resumed:(NSNotification *)n { _foreground.store(true); }
- (void)paused:(NSNotification *)n { _foreground.store(false);[_frameProbe stop]; }
- (void)captureMetricPayload:(NSData *)data kind:(NSString *)kind {
  if(!data || _closed.load()) return;
  // Delivery is intentionally not tied to foreground polling: these are delayed
  // OS reports, not observations of the current foreground interval.
  dispatch_async(_queue,^{
    if(self->_closed.load()) return;
    ++self->_metricKit.received;
    NSString *raw=[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    if(!raw) {self->_metricKit.state="invalid_utf8";return;}
    NSDictionary *row=@{@"captureSchema":@1,@"source":@"MetricKit",@"kind":kind,@"scope":@"os_reported_payload_interval",@"receivedAtMs":@(NSDate.date.timeIntervalSince1970*1000.),@"payloadJSON":raw};
    NSData *json=[NSJSONSerialization dataWithJSONObject:row options:0 error:nil];
    if(!json) {self->_metricKit.state="serialization_failed";return;}
    NSString *directory=[NSSearchPathForDirectoriesInDomains(NSDocumentDirectory,NSUserDomainMask,YES).firstObject stringByAppendingPathComponent:@"source-captures"];
    self->_metricKit.state=self->_metricKit.writer.append(directory.UTF8String,std::string((const char *)json.bytes,json.length));
  });
}
- (void)didReceiveMetricPayloads:(NSArray<MXMetricPayload *> *)payloads { for(MXMetricPayload *p in payloads) [self captureMetricPayload:p.JSONRepresentation kind:@"metrics"]; }
- (void)didReceiveDiagnosticPayloads:(NSArray<MXDiagnosticPayload *> *)payloads { for(MXDiagnosticPayload *p in payloads) [self captureMetricPayload:p.JSONRepresentation kind:@"diagnostics"]; }
RCT_EXPORT_METHOD(runIpcProbe:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if(!_foreground.load()||_closed.load()){reject(@"IPC_PROBE_FAILED",@"IPC probe requires foreground",nil);return;}NSMutableDictionary *probe=[machIpcProbe() mutableCopy];probe[@"ownedKqueueProbe"]=ownedKqueueProbe();_ipcProbe=probe;resolve(nil);
}
RCT_EXPORT_METHOD(runFrameProbe:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if(!_foreground.load()||_closed.load()){reject(@"FRAME_PROBE_FAILED",@"Frame probe requires foreground",nil);return;}[_frameProbe start];resolve(nil);
}
RCT_EXPORT_METHOD(runSocketProbe:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  try {if(!_foreground.load()||_closed.load()) throw std::runtime_error("Socket probe requires foreground");const auto raw=bench::socketSignalProbe();
    _socketProbe=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:raw.data() length:raw.size()] options:0 error:nil];resolve(nil);
  }catch(const std::exception &e){reject(@"SOCKET_PROBE_FAILED",[NSString stringWithUTF8String:e.what()],nil);}
}
RCT_EXPORT_METHOD(runGpuProbe:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if(!_foreground.load()||_closed.load()) {reject(@"GPU_PROBE_FAILED",@"GPU probe requires foreground",nil);return;}
  @try {_gpuProbe=metalSignalProbe(^BOOL{return !self->_foreground.load()||self->_closed.load();});resolve(nil);} @catch(NSException *e){_gpuProbe=@{@"state":@"failed",@"error":e.reason?:e.name,@"exceptionName":e.name};metalProbeProgress([@"exception:" stringByAppendingString:e.reason?:e.name]);reject(@"GPU_PROBE_FAILED",e.reason,nil);}
}
RCT_EXPORT_METHOD(runPageProbe:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  try {if(!_foreground.load()||_closed.load()) throw std::runtime_error("Page probe requires foreground");
    const double began=NSDate.date.timeIntervalSince1970*1000.;const auto raw=bench::pageStateProbe();NSMutableDictionary *row=[[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:raw.data() length:raw.size()] options:0 error:nil] mutableCopy];
    row[@"purgeableQueueProbe"]=ownedPurgeableQueueProbe();row[@"requestedAtMs"]=@(began);row[@"receivedAtMs"]=@(NSDate.date.timeIntervalSince1970*1000.);_pageProbe=row;resolve(nil);
  }catch(const std::exception &e){reject(@"PAGE_PROBE_FAILED",[NSString stringWithUTF8String:e.what()],nil);}
}
RCT_EXPORT_METHOD(read:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
 try {
  if(!_foreground.load()||_closed.load()) throw std::runtime_error("Source sampling requires foreground");
  NSMutableArray *sources=[NSMutableArray new];
  void (^record)(NSString *,NSString *,double,NSDictionary *,NSString *)=^(NSString *name,NSString *scope,double start,NSDictionary *values,NSString *error) {
    [sources addObject:@{@"source":name,@"scope":scope,@"queryStartedUptimeMs":@(start),@"queryFinishedUptimeMs":@(stamp()),@"values":values?: (id)NSNull.null,@"error":error?:(id)NSNull.null}];
  };
  record(@"Mach_IPC_probe",@"explicit_probe_last_result",stamp(),_ipcProbe?:@{@"state":@"not_requested"},nil);
  record(@"OS_pressure_thermal_events",@"foreground_os_event_delivery",stamp(),@{@"memoryPressureSourceCreated":@(_pressureSource!=nil),@"totalCallbacks":exact(_osEventCount),@"events":[_osEvents copy],@"note":@"Pressure flags may be coalesced; no callback does not establish absence of pressure"},nil);
  {const double start=stamp();record(@"Darwin_thermal_notification_states",@"system_thermal_policy",start,nativeThermalNotificationRecords(),nil);}
  {const double start=stamp();record(@"IOPM_power_management_records",@"system_power_policy",start,powerManagementRecords(),nil);}
  {const double start=stamp();record(@"IOKit_allocation_diagnostics",@"system_driver_allocations",start,registryAllocationDiagnostics(),nil);}
  for(NSString *className in @[@"IONetworkInterface",@"IONetworkController"]){const double start=stamp();record([className stringByAppendingString:@"_resource_registry"],@"device_network_driver_registry_visibility",start,registryPropertySource(className,@[@"IONetworkData",@"IOLinkSpeed",@"IOLinkStatus",@"IOMaxPacketSize",@"IOMinPacketSize",@"IOMaxTransferUnit",@"IOInterfaceState",@"IOControllerEnabled"]),nil);}
  {const double start=stamp();record(@"IOPMPowerSource_registry",@"device_power_registry_visibility",start,registryPropertySource(@"IOPMPowerSource"),nil);}
  for(NSString *className in @[@"IOPMrootDomain",@"IOAccelerator",@"IOGPU",@"IOCPU",@"AppleARMCPU",@"IOBlockStorageDriver",@"H11ANEIn",@"H1xANELoadBalancer",@"ANEHWDevice"]){const double start=stamp();record([className stringByAppendingString:@"_registry"],@"device_driver_registry_visibility",start,registryPropertySource(className),nil);}
  {const double start=stamp();auto raw=bench::clockTimeErrorSource();NSData *data=[NSData dataWithBytes:raw.data() length:raw.size()];record(@"ntp_gettime_readonly",@"system_clock_error_report",start,[NSJSONSerialization JSONObjectWithData:data options:0 error:nil],nil);}
  {const double start=stamp();auto raw=bench::clockDisciplineSource();NSData *data=[NSData dataWithBytes:raw.data() length:raw.size()];record(@"ntp_adjtime_readonly",@"system_clock_discipline",start,[NSJSONSerialization JSONObjectWithData:data options:0 error:nil],nil);}
  {const double start=stamp();record(@"IOReport_channel_catalog",@"device_report_channel_visibility",start,ioReportCatalog(),nil);}
  {const double start=stamp();record(@"IOHID_sensor_sources",@"device_sensor_visibility",start,hidSensorSources(true),nil);}
  {const double start=stamp();record(@"IOHID_default_sensor_sources",@"device_sensor_visibility",start,hidSensorSources(false),nil);}
  {const double start=stamp();record(@"KPC_performance_counter_sources",@"pmu_capability_and_collector_thread",start,performanceCounterSources(),nil);}
  {const double start=stamp();record(@"UIScreen_configuration",@"app_screens",start,displaySignalSources(),nil);}
  record(@"CADisplayLink_probe",@"explicit_probe_last_result",stamp(),[_frameProbe snapshot],nil);
  record(@"TCP_loopback_probe",@"explicit_probe_last_result",stamp(),_socketProbe?:@{@"state":@"not_requested"},nil);
  record(@"Metal_explicit_probe",@"explicit_probe_last_result",stamp(),_gpuProbe?:@{@"state":@"not_requested"},nil);
  {const double start=stamp();host_load_info_data_t v{};mach_msg_type_number_t count=HOST_LOAD_INFO_COUNT;const auto host=mach_host_self();const auto code=host_statistics(host,HOST_LOAD_INFO,(host_info_t)&v,&count);mach_port_deallocate(mach_task_self(),host);NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS){FIELD(avenrun[0]);FIELD(avenrun[1]);FIELD(avenrun[2]);FIELD(mach_factor[0]);FIELD(mach_factor[1]);FIELD(mach_factor[2]);values[@"loadScale"]=@(LOAD_SCALE);}record(@"host_statistics(HOST_LOAD_INFO)",@"system_scheduler_load",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  {const double start=stamp();host_priority_info_data_t v{};mach_msg_type_number_t count=HOST_PRIORITY_INFO_COUNT;const auto host=mach_host_self();const auto code=host_info(host,HOST_PRIORITY_INFO,(host_info_t)&v,&count);mach_port_deallocate(mach_task_self(),host);NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS){FIELD(kernel_priority);FIELD(system_priority);FIELD(server_priority);FIELD(user_priority);FIELD(depress_priority);FIELD(idle_priority);FIELD(minimum_priority);FIELD(maximum_priority);}record(@"host_info(HOST_PRIORITY_INFO)",@"system_scheduler_configuration",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  {const double start=stamp();task_purgable_info_t v{};const auto code=task_purgable_info(mach_task_self(),&v);record(@"task_purgable_info",@"process_purgeable_queues",start,code==KERN_SUCCESS?purgeableQueueValues(v):nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);}
  {const double start=stamp();host_purgable_info_data_t v{};mach_msg_type_number_t count=HOST_VM_PURGABLE_COUNT;const auto host=mach_host_self();const auto code=host_info(host,HOST_VM_PURGABLE,(host_info_t)&v,&count);mach_port_deallocate(mach_task_self(),host);NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS){
      FIELD(fifo_data[0].count);FIELD(fifo_data[0].size);
      FIELD(fifo_data[1].count);FIELD(fifo_data[1].size);
      FIELD(fifo_data[2].count);FIELD(fifo_data[2].size);
      FIELD(fifo_data[3].count);FIELD(fifo_data[3].size);
      FIELD(fifo_data[4].count);FIELD(fifo_data[4].size);
      FIELD(fifo_data[5].count);FIELD(fifo_data[5].size);
      FIELD(fifo_data[6].count);FIELD(fifo_data[6].size);
      FIELD(fifo_data[7].count);FIELD(fifo_data[7].size);
      FIELD(lifo_data[0].count);FIELD(lifo_data[0].size);
      FIELD(lifo_data[1].count);FIELD(lifo_data[1].size);
      FIELD(lifo_data[2].count);FIELD(lifo_data[2].size);
      FIELD(lifo_data[3].count);FIELD(lifo_data[3].size);
      FIELD(lifo_data[4].count);FIELD(lifo_data[4].size);
      FIELD(lifo_data[5].count);FIELD(lifo_data[5].size);
      FIELD(lifo_data[6].count);FIELD(lifo_data[6].size);
      FIELD(lifo_data[7].count);FIELD(lifo_data[7].size);
      FIELD(obsolete_data.count);FIELD(obsolete_data.size);
    }record(@"host_info(HOST_VM_PURGABLE)",@"system_purgeable_queues",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  {const double start=stamp();host_basic_info_data_t v{};mach_msg_type_number_t count=HOST_BASIC_INFO_COUNT;const auto host=mach_host_self();const auto code=host_info(host,HOST_BASIC_INFO,(host_info_t)&v,&count);mach_port_deallocate(mach_task_self(),host);NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS){FIELD(max_cpus);FIELD(avail_cpus);FIELD(memory_size);FIELD(cpu_type);FIELD(cpu_subtype);FIELD(cpu_threadtype);FIELD(physical_cpu);FIELD(physical_cpu_max);FIELD(logical_cpu);FIELD(logical_cpu_max);FIELD(max_mem);values[@"returnedNaturalWords"]=@(count);}record(@"host_info(HOST_BASIC_INFO)",@"system_configuration",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  {const double start=stamp();host_sched_info_data_t v{};mach_msg_type_number_t count=HOST_SCHED_INFO_COUNT;const auto host=mach_host_self();const auto code=host_info(host,HOST_SCHED_INFO,(host_info_t)&v,&count);mach_port_deallocate(mach_task_self(),host);NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS){FIELD(min_timeout);FIELD(min_quantum);values[@"returnedNaturalWords"]=@(count);}record(@"host_info(HOST_SCHED_INFO)",@"system_configuration",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  {const double start=stamp();kernel_resource_sizes_data_t v{};mach_msg_type_number_t count=HOST_RESOURCE_SIZES_COUNT;const auto host=mach_host_self();const auto code=host_info(host,HOST_RESOURCE_SIZES,(host_info_t)&v,&count);mach_port_deallocate(mach_task_self(),host);NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS){FIELD(task);FIELD(thread);FIELD(port);FIELD(memory_region);FIELD(memory_object);values[@"returnedNaturalWords"]=@(count);}record(@"host_info(HOST_RESOURCE_SIZES)",@"system_configuration",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  {const double start=stamp();record(@"libproc_self_dynamic_kqueues",@"process_dynamic_event_queues",start,darwinDynamicQueueSources(),nil);}
  {const double start=stamp();record(@"libproc_self_kqueues",@"process_event_queues",start,darwinQueueSources(),nil);}
  {const double start=stamp();record(@"coalition_resource_usage",@"own_app_resource_coalition",start,coalitionSources(),nil);}
  {const double start=stamp();record(@"iokit_service_catalog",@"driver_source_discovery",start,registryServiceCatalog(),nil);}
  {const double start=stamp();record(@"xnu_structured_statistics",@"system_resource_statistics",start,structuredSysctlSources(),nil);}
  {const double start=stamp();record(@"owned_vm_objects",@"task_owned_vm_objects",start,ownedVMObjectSources(),nil);}
  {const double start=stamp();record(@"xnu_direct_scalar_sysctls",@"system_resource_accounting_and_policy",start,scalarSysctlSources(),nil);}
  {const double start=stamp();record(@"libproc_self_realtime_faults",@"process_realtime_fault_history",start,darwinRealtimeFaultSources(),nil);}
  {const double start=stamp();record(@"libproc_self_task_workqueue",@"process_darwin_abi",start,darwinProcessSources(),nil);}
  {const double start=stamp();mach_task_basic_info_data_t v{};mach_msg_type_number_t count=MACH_TASK_BASIC_INFO_COUNT;
    const auto code=task_info(mach_task_self(),MACH_TASK_BASIC_INFO,(task_info_t)&v,&count);NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS){FIELD(virtual_size);FIELD(resident_size);FIELD(resident_size_max);FIELD(user_time.seconds);FIELD(user_time.microseconds);FIELD(system_time.seconds);FIELD(system_time.microseconds);FIELD(policy);FIELD(suspend_count);values[@"returnedNaturalWords"]=@(count);values[@"timeScope"]=@"terminated threads; seconds and microseconds";}
    record(@"task_info(MACH_TASK_BASIC_INFO)",@"process",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);}
  {const double start=stamp();task_thread_times_info_data_t v{};mach_msg_type_number_t count=TASK_THREAD_TIMES_INFO_COUNT;
    const auto code=task_info(mach_task_self(),TASK_THREAD_TIMES_INFO,(task_info_t)&v,&count);NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS){FIELD(user_time.seconds);FIELD(user_time.microseconds);FIELD(system_time.seconds);FIELD(system_time.microseconds);values[@"returnedNaturalWords"]=@(count);values[@"timeScope"]=@"live threads; seconds and microseconds; running-task snapshot is not atomic";}
    record(@"task_info(TASK_THREAD_TIMES_INFO)",@"process_live_threads",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);}
  { const double start=stamp(); task_kernelmemory_info_data_t v{};mach_msg_type_number_t count=TASK_KERNELMEMORY_INFO_COUNT;
    const auto code=task_info(mach_task_self(),TASK_KERNELMEMORY_INFO,(task_info_t)&v,&count);NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS) { FIELD(total_palloc);FIELD(total_pfree);FIELD(total_salloc);FIELD(total_sfree); values[@"returnedNaturalWords"]=@(count); }
    record(@"task_info(TASK_KERNELMEMORY_INFO)",@"process",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  { const double start=stamp(); task_affinity_tag_info_data_t v{};mach_msg_type_number_t count=TASK_AFFINITY_TAG_INFO_COUNT;
    const auto code=task_info(mach_task_self(),TASK_AFFINITY_TAG_INFO,(task_info_t)&v,&count);NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS) { FIELD(set_count);FIELD(min);FIELD(max);FIELD(task_count); values[@"returnedNaturalWords"]=@(count); }
    record(@"task_info(TASK_AFFINITY_TAG_INFO)",@"process",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  { const double start=stamp(); task_extmod_info_data_t v{};mach_msg_type_number_t count=TASK_EXTMOD_INFO_COUNT;
    const auto code=task_info(mach_task_self(),TASK_EXTMOD_INFO,(task_info_t)&v,&count);NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS) { FIELD(extmod_statistics.task_for_pid_count);FIELD(extmod_statistics.task_for_pid_caller_count);FIELD(extmod_statistics.thread_creation_count);FIELD(extmod_statistics.thread_creation_caller_count);FIELD(extmod_statistics.thread_set_state_count);FIELD(extmod_statistics.thread_set_state_caller_count); values[@"returnedNaturalWords"]=@(count); }
    record(@"task_info(TASK_EXTMOD_INFO)",@"process",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  { const double start=stamp(); task_flags_info_data_t v{};mach_msg_type_number_t count=TASK_FLAGS_INFO_COUNT;
    const auto code=task_info(mach_task_self(),TASK_FLAGS_INFO,(task_info_t)&v,&count);NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS) { FIELD(flags); values[@"returnedNaturalWords"]=@(count); }
    record(@"task_info(TASK_FLAGS_INFO)",@"process",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  { const int flavors[]={TASK_CATEGORY_POLICY,TASK_BASE_QOS_POLICY,TASK_OVERRIDE_QOS_POLICY};
    NSArray *names=@[@"TASK_CATEGORY_POLICY",@"TASK_BASE_QOS_POLICY",@"TASK_OVERRIDE_QOS_POLICY"];
    NSArray *keys=@[@[@"role"],@[@"task_latency_qos_tier",@"task_throughput_qos_tier"],@[@"task_latency_qos_tier",@"task_throughput_qos_tier"]];
    for(unsigned i=0;i<3;++i) {const double start=stamp();integer_t words[2]{};mach_msg_type_number_t count=(mach_msg_type_number_t)[keys[i] count];boolean_t defaults=FALSE;
      const auto code=task_policy_get(mach_task_self(),flavors[i],words,&count,&defaults);NSMutableDictionary *values=[NSMutableDictionary new];
      if(code==KERN_SUCCESS) {for(NSUInteger j=0;j<std::min<NSUInteger>(count,[keys[i] count]);++j) values[keys[i][j]]=signedExact(words[j]);values[@"defaultPolicy"]=@(defaults);values[@"returnedNaturalWords"]=@(count);}
      record([NSString stringWithFormat:@"task_policy_get(%@)",names[i]],@"process_policy",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
    }
  }
  { const double start=stamp();integer_t priority=0;mach_msg_type_number_t count=1;
    const auto code=task_info(mach_task_self(),TASK_SCHED_TIMESHARE_INFO,&priority,&count);
    record(@"task_info(TASK_SCHED_TIMESHARE_INFO)",@"process_base_priority",start,code==KERN_SUCCESS&&count>=1?@{@"base_priority":signedExact(priority),@"returnedNaturalWords":@(count)}:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  { // XNU task_policy_private.h: 16 integer words; reserved tail is not telemetry.
    const double start=stamp();integer_t words[16]{};mach_msg_type_number_t count=16;boolean_t defaults=FALSE;
    const auto code=task_policy_get(mach_task_self(),TASK_SUPPRESSION_POLICY,words,&count,&defaults);
    NSArray *keys=@[@"active",@"lowpri_cpu",@"timer_throttle",@"disk_throttle",@"cpu_limit",@"suspend",@"throughput_qos",@"suppressed_cpu",@"background_sockets"];
    NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS){for(NSUInteger i=0;i<std::min<NSUInteger>(count,keys.count);++i)values[keys[i]]=signedExact(words[i]);values[@"returnedNaturalWords"]=@(count);values[@"defaultPolicy"]=@(defaults);values[@"semantics"]=@"Requested suppression policy; cpu_limit and suspend are zero placeholders in reviewed XNU. Not measured throttling. Private struct ABI.";}
    record(@"task_policy_get(TASK_SUPPRESSION_POLICY)",@"process_policy",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  for (const int flavor : {TASK_VM_INFO, TASK_VM_INFO_PURGEABLE}) { const double start=stamp(); task_vm_info_data_t v{}; mach_msg_type_number_t count=TASK_VM_INFO_COUNT;
    const auto code=task_info(mach_task_self(),flavor,(task_info_t)&v,&count);
    NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS) {
      FIELD(virtual_size);
      FIELD(region_count);
      FIELD(page_size);
      FIELD(resident_size);
      FIELD(resident_size_peak);
      FIELD(device);
      FIELD(device_peak);
      FIELD(internal);
      FIELD(internal_peak);
      FIELD(external);
      FIELD(external_peak);
      FIELD(reusable);
      FIELD(reusable_peak);
      FIELD(purgeable_volatile_pmap);
      FIELD(purgeable_volatile_resident);
      FIELD(purgeable_volatile_virtual);
      FIELD(compressed);
      FIELD(compressed_peak);
      FIELD(compressed_lifetime);
      FIELD(phys_footprint);
      FIELD(min_address);
      FIELD(max_address);
      FIELD(ledger_phys_footprint_peak);
      FIELD(ledger_purgeable_nonvolatile);
      FIELD(ledger_purgeable_novolatile_compressed);
      FIELD(ledger_purgeable_volatile);
      FIELD(ledger_purgeable_volatile_compressed);
      FIELD(ledger_tag_network_nonvolatile);
      FIELD(ledger_tag_network_nonvolatile_compressed);
      FIELD(ledger_tag_network_volatile);
      FIELD(ledger_tag_network_volatile_compressed);
      FIELD(ledger_tag_media_footprint);
      FIELD(ledger_tag_media_footprint_compressed);
      FIELD(ledger_tag_media_nofootprint);
      FIELD(ledger_tag_media_nofootprint_compressed);
      FIELD(ledger_tag_graphics_footprint);
      FIELD(ledger_tag_graphics_footprint_compressed);
      FIELD(ledger_tag_graphics_nofootprint);
      FIELD(ledger_tag_graphics_nofootprint_compressed);
      FIELD(ledger_tag_neural_footprint);
      FIELD(ledger_tag_neural_footprint_compressed);
      FIELD(ledger_tag_neural_nofootprint);
      FIELD(ledger_tag_neural_nofootprint_compressed);
      FIELD(limit_bytes_remaining);
      FIELD(decompressions);
      FIELD(ledger_swapins);
      FIELD(ledger_tag_neural_nofootprint_total);
      FIELD(ledger_tag_neural_nofootprint_peak);
      values[@"returnedNaturalWords"]=@(count);
    } record(flavor==TASK_VM_INFO?@"task_info(TASK_VM_INFO)":@"task_info(TASK_VM_INFO_PURGEABLE)",@"process",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  { const double start=stamp(); task_events_info_data_t v{}; mach_msg_type_number_t count=TASK_EVENTS_INFO_COUNT;
    const auto code=task_info(mach_task_self(),TASK_EVENTS_INFO,(task_info_t)&v,&count);
    NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS) {
      FIELD(faults);
      FIELD(pageins);
      FIELD(cow_faults);
      FIELD(messages_sent);
      FIELD(messages_received);
      FIELD(syscalls_mach);
      FIELD(syscalls_unix);
      FIELD(csw);
      values[@"returnedNaturalWords"]=@(count);
    } record(@"task_info(TASK_EVENTS_INFO)",@"process",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  { const double start=stamp(); task_absolutetime_info_data_t v{}; mach_msg_type_number_t count=TASK_ABSOLUTETIME_INFO_COUNT;
    const auto code=task_info(mach_task_self(),TASK_ABSOLUTETIME_INFO,(task_info_t)&v,&count);
    NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS) {
      FIELD(total_user);
      FIELD(total_system);
      FIELD(threads_user);
      FIELD(threads_system);
      values[@"returnedNaturalWords"]=@(count);
    } record(@"task_info(TASK_ABSOLUTETIME_INFO)",@"process",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  { const double start=stamp(); task_power_info_data_t v{}; mach_msg_type_number_t count=TASK_POWER_INFO_COUNT;
    const auto code=task_info(mach_task_self(),TASK_POWER_INFO,(task_info_t)&v,&count);
    NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS) {
      FIELD(total_user);
      FIELD(total_system);
      FIELD(task_interrupt_wakeups);
      FIELD(task_platform_idle_wakeups);
      FIELD(task_timer_wakeups_bin_1);
      FIELD(task_timer_wakeups_bin_2);
      values[@"returnedNaturalWords"]=@(count);
    } record(@"task_info(TASK_POWER_INFO)",@"process",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  { const double start=stamp(); struct rusage_info_v6 v{}; int version=6,code=-1;
    for(;version>=2;--version) { memset(&v,0,sizeof(v)); code=proc_pid_rusage(getpid(),version,(rusage_info_t *)&v); if(code==0) break; }
    const int saved=errno; NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==0) { values[@"returnedVersion"]=@(version);
      if(version>=2) values[@"ri_user_time"]=exact(v.ri_user_time);
      if(version>=2) values[@"ri_system_time"]=exact(v.ri_system_time);
      if(version>=2) values[@"ri_pkg_idle_wkups"]=exact(v.ri_pkg_idle_wkups);
      if(version>=2) values[@"ri_interrupt_wkups"]=exact(v.ri_interrupt_wkups);
      if(version>=2) values[@"ri_pageins"]=exact(v.ri_pageins);
      if(version>=2) values[@"ri_wired_size"]=exact(v.ri_wired_size);
      if(version>=2) values[@"ri_resident_size"]=exact(v.ri_resident_size);
      if(version>=2) values[@"ri_phys_footprint"]=exact(v.ri_phys_footprint);
      if(version>=2) values[@"ri_proc_start_abstime"]=exact(v.ri_proc_start_abstime);
      if(version>=2) values[@"ri_proc_exit_abstime"]=exact(v.ri_proc_exit_abstime);
      if(version>=2) values[@"ri_child_user_time"]=exact(v.ri_child_user_time);
      if(version>=2) values[@"ri_child_system_time"]=exact(v.ri_child_system_time);
      if(version>=2) values[@"ri_child_pkg_idle_wkups"]=exact(v.ri_child_pkg_idle_wkups);
      if(version>=2) values[@"ri_child_interrupt_wkups"]=exact(v.ri_child_interrupt_wkups);
      if(version>=2) values[@"ri_child_pageins"]=exact(v.ri_child_pageins);
      if(version>=2) values[@"ri_child_elapsed_abstime"]=exact(v.ri_child_elapsed_abstime);
      if(version>=2) values[@"ri_diskio_bytesread"]=exact(v.ri_diskio_bytesread);
      if(version>=2) values[@"ri_diskio_byteswritten"]=exact(v.ri_diskio_byteswritten);
      if(version>=3) values[@"ri_cpu_time_qos_default"]=exact(v.ri_cpu_time_qos_default);
      if(version>=3) values[@"ri_cpu_time_qos_maintenance"]=exact(v.ri_cpu_time_qos_maintenance);
      if(version>=3) values[@"ri_cpu_time_qos_background"]=exact(v.ri_cpu_time_qos_background);
      if(version>=3) values[@"ri_cpu_time_qos_utility"]=exact(v.ri_cpu_time_qos_utility);
      if(version>=3) values[@"ri_cpu_time_qos_legacy"]=exact(v.ri_cpu_time_qos_legacy);
      if(version>=3) values[@"ri_cpu_time_qos_user_initiated"]=exact(v.ri_cpu_time_qos_user_initiated);
      if(version>=3) values[@"ri_cpu_time_qos_user_interactive"]=exact(v.ri_cpu_time_qos_user_interactive);
      if(version>=3) values[@"ri_billed_system_time"]=exact(v.ri_billed_system_time);
      if(version>=3) values[@"ri_serviced_system_time"]=exact(v.ri_serviced_system_time);
      if(version>=4) values[@"ri_logical_writes"]=exact(v.ri_logical_writes);
      if(version>=4) values[@"ri_lifetime_max_phys_footprint"]=exact(v.ri_lifetime_max_phys_footprint);
      if(version>=4) values[@"ri_instructions"]=exact(v.ri_instructions);
      if(version>=4) values[@"ri_cycles"]=exact(v.ri_cycles);
      if(version>=4) values[@"ri_billed_energy"]=exact(v.ri_billed_energy);
      if(version>=4) values[@"ri_serviced_energy"]=exact(v.ri_serviced_energy);
      if(version>=4) values[@"ri_interval_max_phys_footprint"]=exact(v.ri_interval_max_phys_footprint);
      if(version>=4) values[@"ri_runnable_time"]=exact(v.ri_runnable_time);
      if(version>=5) values[@"ri_flags"]=exact(v.ri_flags);
      if(version>=6) values[@"ri_user_ptime"]=exact(v.ri_user_ptime);
      if(version>=6) values[@"ri_system_ptime"]=exact(v.ri_system_ptime);
      if(version>=6) values[@"ri_pinstructions"]=exact(v.ri_pinstructions);
      if(version>=6) values[@"ri_pcycles"]=exact(v.ri_pcycles);
      if(version>=6) values[@"ri_energy_nj"]=exact(v.ri_energy_nj);
      if(version>=6) values[@"ri_penergy_nj"]=exact(v.ri_penergy_nj);
      if(version>=6) values[@"ri_secure_time_in_system"]=exact(v.ri_secure_time_in_system);
      if(version>=6) values[@"ri_secure_ptime_in_system"]=exact(v.ri_secure_ptime_in_system);
      if(version>=6) values[@"ri_neural_footprint"]=exact(v.ri_neural_footprint);
      if(version>=6) values[@"ri_lifetime_max_neural_footprint"]=exact(v.ri_lifetime_max_neural_footprint);
      if(version>=6) values[@"ri_interval_max_neural_footprint"]=exact(v.ri_interval_max_neural_footprint);
    } record(@"proc_pid_rusage",@"process_and_explicit_child_fields",start,code==0?values:nil,code==0?nil:[NSString stringWithFormat:@"errno=%d",saved]);
  }
  for(const int who : {RUSAGE_SELF,RUSAGE_CHILDREN}) { const double start=stamp(); struct rusage v{}; const int code=getrusage(who,&v); const int saved=errno;
    NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==0) {
      values[@"ru_utime_sec"]=signedExact(v.ru_utime.tv_sec); values[@"ru_utime_usec"]=signedExact(v.ru_utime.tv_usec);
      values[@"ru_stime_sec"]=signedExact(v.ru_stime.tv_sec); values[@"ru_stime_usec"]=signedExact(v.ru_stime.tv_usec);
      values[@"ru_maxrss"]=signedExact(v.ru_maxrss);
      values[@"ru_ixrss"]=signedExact(v.ru_ixrss);
      values[@"ru_idrss"]=signedExact(v.ru_idrss);
      values[@"ru_isrss"]=signedExact(v.ru_isrss);
      values[@"ru_minflt"]=signedExact(v.ru_minflt);
      values[@"ru_majflt"]=signedExact(v.ru_majflt);
      values[@"ru_nswap"]=signedExact(v.ru_nswap);
      values[@"ru_inblock"]=signedExact(v.ru_inblock);
      values[@"ru_oublock"]=signedExact(v.ru_oublock);
      values[@"ru_msgsnd"]=signedExact(v.ru_msgsnd);
      values[@"ru_msgrcv"]=signedExact(v.ru_msgrcv);
      values[@"ru_nsignals"]=signedExact(v.ru_nsignals);
      values[@"ru_nvcsw"]=signedExact(v.ru_nvcsw);
      values[@"ru_nivcsw"]=signedExact(v.ru_nivcsw);
    } record(who==RUSAGE_SELF?@"getrusage(RUSAGE_SELF)":@"getrusage(RUSAGE_CHILDREN)",who==RUSAGE_SELF?@"process":@"waited_for_children",start,code==0?values:nil,code==0?nil:[NSString stringWithFormat:@"errno=%d",saved]);
  }
  { const double start=stamp(); vm_statistics64_data_t v{}; mach_msg_type_number_t count=HOST_VM_INFO64_COUNT;
    const auto host=mach_host_self(); const auto code=host_statistics64(host,HOST_VM_INFO64,(host_info64_t)&v,&count); mach_port_deallocate(mach_task_self(),host);
    NSMutableDictionary *values=[NSMutableDictionary new]; if(code==KERN_SUCCESS) {
      FIELD(free_count);
      FIELD(active_count);
      FIELD(inactive_count);
      FIELD(wire_count);
      FIELD(zero_fill_count);
      FIELD(reactivations);
      FIELD(pageins);
      FIELD(pageouts);
      FIELD(faults);
      FIELD(cow_faults);
      FIELD(lookups);
      FIELD(hits);
      FIELD(purges);
      FIELD(purgeable_count);
      FIELD(speculative_count);
      FIELD(decompressions);
      FIELD(compressions);
      FIELD(swapins);
      FIELD(swapouts);
      FIELD(compressor_page_count);
      FIELD(throttled_count);
      FIELD(external_page_count);
      FIELD(internal_page_count);
      FIELD(total_uncompressed_pages_in_compressor);
      values[@"returnedNaturalWords"]=@(count); values[@"pageSizeBytes"]=exact(vm_kernel_page_size);
    } record(@"host_statistics64(HOST_VM_INFO64)",@"system",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  { const double start=stamp(); host_cpu_load_info_data_t v{}; mach_msg_type_number_t count=HOST_CPU_LOAD_INFO_COUNT;
    const auto host=mach_host_self(); const auto code=host_statistics(host,HOST_CPU_LOAD_INFO,(host_info_t)&v,&count); mach_port_deallocate(mach_task_self(),host);
    NSDictionary *values=code==KERN_SUCCESS && count>=HOST_CPU_LOAD_INFO_COUNT ? @{@"userTicks":exact(v.cpu_ticks[CPU_STATE_USER]),@"systemTicks":exact(v.cpu_ticks[CPU_STATE_SYSTEM]),@"idleTicks":exact(v.cpu_ticks[CPU_STATE_IDLE]),@"niceTicks":exact(v.cpu_ticks[CPU_STATE_NICE])}:nil;
    record(@"host_statistics(HOST_CPU_LOAD_INFO)",@"system",start,values,values?nil:[NSString stringWithFormat:@"kern_return_t=%d count=%u",code,count]);
  }
  {const double start=stamp();processor_set_name_t set=MACH_PORT_NULL;const auto host=mach_host_self();const auto lookup=processor_set_default(host,&set);mach_port_deallocate(mach_task_self(),host);
    processor_set_load_info_data_t v{};mach_msg_type_number_t count=PROCESSOR_SET_LOAD_INFO_COUNT;
    const auto code=lookup==KERN_SUCCESS?processor_set_statistics(set,PROCESSOR_SET_LOAD_INFO,(processor_set_info_t)&v,&count):lookup;
    if(set!=MACH_PORT_NULL)mach_port_deallocate(mach_task_self(),set);NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS){FIELD(task_count);FIELD(thread_count);FIELD(load_average);FIELD(mach_factor);values[@"loadScale"]=@(LOAD_SCALE);values[@"returnedNaturalWords"]=@(count);}
    record(@"processor_set_statistics(PROCESSOR_SET_LOAD_INFO)",@"system_default_processor_set",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"lookup=%d kern_return_t=%d",lookup,code]);
  }
  { const double start=stamp(); task_power_info_v2_data_t v{};mach_msg_type_number_t count=TASK_POWER_INFO_V2_COUNT;
    const auto code=task_info(mach_task_self(),TASK_POWER_INFO_V2,(task_info_t)&v,&count);
    NSMutableDictionary *values=[NSMutableDictionary new];if(code==KERN_SUCCESS) {
      FIELD(cpu_energy.total_user);FIELD(cpu_energy.total_system);FIELD(cpu_energy.task_interrupt_wakeups);
      FIELD(cpu_energy.task_platform_idle_wakeups);FIELD(cpu_energy.task_timer_wakeups_bin_1);FIELD(cpu_energy.task_timer_wakeups_bin_2);
      FIELD(gpu_energy.task_gpu_utilisation);
#if defined(__arm__) || defined(__arm64__)
      FIELD(task_energy);
#endif
      FIELD(task_ptime);FIELD(task_pset_switches);values[@"returnedNaturalWords"]=@(count);
    }record(@"task_info(TASK_POWER_INFO_V2)",@"process_opaque_native_accounting",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }  { const double start=stamp(); task_power_info_v2_data_t v{};mach_msg_type_number_t count=TASK_POWER_INFO_V2_COUNT;
    const auto host=mach_host_self();const auto code=host_statistics(host,HOST_EXPIRED_TASK_INFO,(host_info_t)&v,&count);mach_port_deallocate(mach_task_self(),host);
    NSMutableDictionary *values=[NSMutableDictionary new];if(code==KERN_SUCCESS) {
      FIELD(cpu_energy.total_user);FIELD(cpu_energy.total_system);FIELD(cpu_energy.task_interrupt_wakeups);
      FIELD(cpu_energy.task_platform_idle_wakeups);FIELD(cpu_energy.task_timer_wakeups_bin_1);FIELD(cpu_energy.task_timer_wakeups_bin_2);
      FIELD(gpu_energy.task_gpu_utilisation);
#if defined(__arm__) || defined(__arm64__)
      FIELD(task_energy);
#endif
      FIELD(task_ptime);FIELD(task_pset_switches);values[@"returnedNaturalWords"]=@(count);
    }record(@"host_statistics(HOST_EXPIRED_TASK_INFO)",@"system_terminated_tasks_opaque_native_accounting",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }
  {const double start=stamp();vm_extmod_statistics_data_t v{};mach_msg_type_number_t count=HOST_EXTMOD_INFO64_COUNT;
    const auto host=mach_host_self();const auto code=host_statistics64(host,HOST_EXTMOD_INFO64,(host_info64_t)&v,&count);mach_port_deallocate(mach_task_self(),host);NSMutableDictionary *values=[NSMutableDictionary new];
    if(code==KERN_SUCCESS){FIELD(task_for_pid_count);FIELD(task_for_pid_caller_count);FIELD(thread_creation_count);FIELD(thread_creation_caller_count);FIELD(thread_set_state_count);FIELD(thread_set_state_caller_count);values[@"returnedNaturalWords"]=@(count);}
    record(@"host_statistics64(HOST_EXTMOD_INFO64)",@"system_external_task_modification_counts",start,code==KERN_SUCCESS?values:nil,code==KERN_SUCCESS?nil:[NSString stringWithFormat:@"kern_return_t=%d",code]);
  }

  { const double start=stamp();natural_t n=0;processor_info_array_t info=nullptr;mach_msg_type_number_t count=0;
    const auto host=mach_host_self();const auto code=host_processor_info(host,PROCESSOR_CPU_LOAD_INFO,&n,&info,&count);mach_port_deallocate(mach_task_self(),host);
    NSMutableArray *cpus=[NSMutableArray new];const bool valid=code==KERN_SUCCESS && count>=size_t(n)*CPU_STATE_MAX;
    if(valid) for(natural_t i=0;i<n;++i) {auto tick=info+i*CPU_STATE_MAX;
      [cpus addObject:@{@"logicalCpu":@(i),@"userTicks":exact((uint32_t)tick[CPU_STATE_USER]),@"systemTicks":exact((uint32_t)tick[CPU_STATE_SYSTEM]),@"idleTicks":exact((uint32_t)tick[CPU_STATE_IDLE]),@"niceTicks":exact((uint32_t)tick[CPU_STATE_NICE])}];}
    if(info) vm_deallocate(mach_task_self(),(vm_address_t)info,count*sizeof(integer_t));
    record(@"host_processor_info(PROCESSOR_CPU_LOAD_INFO)",@"system_logical_cpu",start,valid?@{@"cpus":cpus}:nil,valid?nil:[NSString stringWithFormat:@"kern_return_t=%d count=%u",code,count]);
  }
  { const double start=stamp();vm_address_t address=0;natural_t depth=0;NSMutableArray *regions=[NSMutableArray new];
    NSString *end=@"record_limit";kern_return_t last=KERN_SUCCESS;
    // Bounded, read-only metadata walk. Changes to the map can race the scan;
    // aliases are separate entries, not unique physical memory.
    for(unsigned calls=0;calls<4096;++calls) {
      if(!_foreground.load()||_closed.load()) {end=@"interrupted";break;}
      if(stamp()-start>250) {end=@"time_limit";break;}
      vm_size_t size=0;vm_region_submap_info_data_64_t v{};mach_msg_type_number_t count=VM_REGION_SUBMAP_INFO_COUNT_64;
      last=vm_region_recurse_64(mach_task_self(),&address,&size,&depth,(vm_region_recurse_info_t)&v,&count);
      if(last!=KERN_SUCCESS) {end=last==KERN_INVALID_ADDRESS?@"end_of_map":@"query_failed";break;}
      if(count<VM_REGION_SUBMAP_INFO_V0_COUNT_64) {end=@"short_reply";break;}
      if(v.is_submap) { if(depth>=64) {end=@"depth_limit";break;} ++depth;continue; }
      NSMutableDictionary *values=[NSMutableDictionary new];
      FIELD(protection);
      FIELD(max_protection);
      FIELD(inheritance);
      FIELD(offset);
      FIELD(user_tag);
      FIELD(pages_resident);
      FIELD(pages_shared_now_private);
      FIELD(pages_swapped_out);
      FIELD(pages_dirtied);
      FIELD(ref_count);
      FIELD(shadow_depth);
      FIELD(external_pager);
      FIELD(share_mode);
      FIELD(is_submap);
      FIELD(behavior);
      FIELD(object_id);
      FIELD(user_wired_count);
      FIELD(pages_reusable);
      FIELD(object_id_full);
      values[@"address"]=exact(address);values[@"sizeBytes"]=exact(size);values[@"depth"]=@(depth);values[@"returnedNaturalWords"]=@(count);[regions addObject:values];
      if(!size||address>UINT64_MAX-size) {end=@"address_limit";break;} address+=size;
    }
    record(@"vm_region_recurse_64",@"process_map_entries",start,@{@"regions":regions,@"termination":end,@"complete":@([end isEqualToString:@"end_of_map"]),@"lastReturnCode":@(last),@"pageSizeBytes":exact(vm_page_size)},[end isEqualToString:@"query_failed"]?@"map query failed; partial rows retained":nil);
  }
  {const double start=stamp();uint8_t bytes[256]{};size_t size=sizeof(bytes);const int code=sysctlbyname("hw.optional.arm.caps",bytes,&size,nullptr,0);const int saved=errno;NSMutableDictionary *bits=[NSMutableDictionary new];
    if(code==0){
      if(CAP_BIT_FEAT_FlagM/8<size)bits[@"FEAT_FlagM"]=@((bytes[CAP_BIT_FEAT_FlagM/8]>>(CAP_BIT_FEAT_FlagM%8))&1);
      if(CAP_BIT_FEAT_FlagM2/8<size)bits[@"FEAT_FlagM2"]=@((bytes[CAP_BIT_FEAT_FlagM2/8]>>(CAP_BIT_FEAT_FlagM2%8))&1);
      if(CAP_BIT_FEAT_FHM/8<size)bits[@"FEAT_FHM"]=@((bytes[CAP_BIT_FEAT_FHM/8]>>(CAP_BIT_FEAT_FHM%8))&1);
      if(CAP_BIT_FEAT_DotProd/8<size)bits[@"FEAT_DotProd"]=@((bytes[CAP_BIT_FEAT_DotProd/8]>>(CAP_BIT_FEAT_DotProd%8))&1);
      if(CAP_BIT_FEAT_SHA3/8<size)bits[@"FEAT_SHA3"]=@((bytes[CAP_BIT_FEAT_SHA3/8]>>(CAP_BIT_FEAT_SHA3%8))&1);
      if(CAP_BIT_FEAT_RDM/8<size)bits[@"FEAT_RDM"]=@((bytes[CAP_BIT_FEAT_RDM/8]>>(CAP_BIT_FEAT_RDM%8))&1);
      if(CAP_BIT_FEAT_LSE/8<size)bits[@"FEAT_LSE"]=@((bytes[CAP_BIT_FEAT_LSE/8]>>(CAP_BIT_FEAT_LSE%8))&1);
      if(CAP_BIT_FEAT_SHA256/8<size)bits[@"FEAT_SHA256"]=@((bytes[CAP_BIT_FEAT_SHA256/8]>>(CAP_BIT_FEAT_SHA256%8))&1);
      if(CAP_BIT_FEAT_SHA512/8<size)bits[@"FEAT_SHA512"]=@((bytes[CAP_BIT_FEAT_SHA512/8]>>(CAP_BIT_FEAT_SHA512%8))&1);
      if(CAP_BIT_FEAT_SHA1/8<size)bits[@"FEAT_SHA1"]=@((bytes[CAP_BIT_FEAT_SHA1/8]>>(CAP_BIT_FEAT_SHA1%8))&1);
      if(CAP_BIT_FEAT_AES/8<size)bits[@"FEAT_AES"]=@((bytes[CAP_BIT_FEAT_AES/8]>>(CAP_BIT_FEAT_AES%8))&1);
      if(CAP_BIT_FEAT_PMULL/8<size)bits[@"FEAT_PMULL"]=@((bytes[CAP_BIT_FEAT_PMULL/8]>>(CAP_BIT_FEAT_PMULL%8))&1);
      if(CAP_BIT_FEAT_SPECRES/8<size)bits[@"FEAT_SPECRES"]=@((bytes[CAP_BIT_FEAT_SPECRES/8]>>(CAP_BIT_FEAT_SPECRES%8))&1);
      if(CAP_BIT_FEAT_SB/8<size)bits[@"FEAT_SB"]=@((bytes[CAP_BIT_FEAT_SB/8]>>(CAP_BIT_FEAT_SB%8))&1);
      if(CAP_BIT_FEAT_FRINTTS/8<size)bits[@"FEAT_FRINTTS"]=@((bytes[CAP_BIT_FEAT_FRINTTS/8]>>(CAP_BIT_FEAT_FRINTTS%8))&1);
      if(CAP_BIT_FEAT_LRCPC/8<size)bits[@"FEAT_LRCPC"]=@((bytes[CAP_BIT_FEAT_LRCPC/8]>>(CAP_BIT_FEAT_LRCPC%8))&1);
      if(CAP_BIT_FEAT_LRCPC2/8<size)bits[@"FEAT_LRCPC2"]=@((bytes[CAP_BIT_FEAT_LRCPC2/8]>>(CAP_BIT_FEAT_LRCPC2%8))&1);
      if(CAP_BIT_FEAT_FCMA/8<size)bits[@"FEAT_FCMA"]=@((bytes[CAP_BIT_FEAT_FCMA/8]>>(CAP_BIT_FEAT_FCMA%8))&1);
      if(CAP_BIT_FEAT_JSCVT/8<size)bits[@"FEAT_JSCVT"]=@((bytes[CAP_BIT_FEAT_JSCVT/8]>>(CAP_BIT_FEAT_JSCVT%8))&1);
      if(CAP_BIT_FEAT_PAuth/8<size)bits[@"FEAT_PAuth"]=@((bytes[CAP_BIT_FEAT_PAuth/8]>>(CAP_BIT_FEAT_PAuth%8))&1);
      if(CAP_BIT_FEAT_PAuth2/8<size)bits[@"FEAT_PAuth2"]=@((bytes[CAP_BIT_FEAT_PAuth2/8]>>(CAP_BIT_FEAT_PAuth2%8))&1);
      if(CAP_BIT_FEAT_FPAC/8<size)bits[@"FEAT_FPAC"]=@((bytes[CAP_BIT_FEAT_FPAC/8]>>(CAP_BIT_FEAT_FPAC%8))&1);
      if(CAP_BIT_FEAT_DPB/8<size)bits[@"FEAT_DPB"]=@((bytes[CAP_BIT_FEAT_DPB/8]>>(CAP_BIT_FEAT_DPB%8))&1);
      if(CAP_BIT_FEAT_DPB2/8<size)bits[@"FEAT_DPB2"]=@((bytes[CAP_BIT_FEAT_DPB2/8]>>(CAP_BIT_FEAT_DPB2%8))&1);
      if(CAP_BIT_FEAT_BF16/8<size)bits[@"FEAT_BF16"]=@((bytes[CAP_BIT_FEAT_BF16/8]>>(CAP_BIT_FEAT_BF16%8))&1);
      if(CAP_BIT_FEAT_I8MM/8<size)bits[@"FEAT_I8MM"]=@((bytes[CAP_BIT_FEAT_I8MM/8]>>(CAP_BIT_FEAT_I8MM%8))&1);
      if(CAP_BIT_FEAT_WFxT/8<size)bits[@"FEAT_WFxT"]=@((bytes[CAP_BIT_FEAT_WFxT/8]>>(CAP_BIT_FEAT_WFxT%8))&1);
      if(CAP_BIT_FEAT_RPRES/8<size)bits[@"FEAT_RPRES"]=@((bytes[CAP_BIT_FEAT_RPRES/8]>>(CAP_BIT_FEAT_RPRES%8))&1);
      if(CAP_BIT_FEAT_ECV/8<size)bits[@"FEAT_ECV"]=@((bytes[CAP_BIT_FEAT_ECV/8]>>(CAP_BIT_FEAT_ECV%8))&1);
      if(CAP_BIT_FEAT_AFP/8<size)bits[@"FEAT_AFP"]=@((bytes[CAP_BIT_FEAT_AFP/8]>>(CAP_BIT_FEAT_AFP%8))&1);
      if(CAP_BIT_FEAT_LSE2/8<size)bits[@"FEAT_LSE2"]=@((bytes[CAP_BIT_FEAT_LSE2/8]>>(CAP_BIT_FEAT_LSE2%8))&1);
      if(CAP_BIT_FEAT_CSV2/8<size)bits[@"FEAT_CSV2"]=@((bytes[CAP_BIT_FEAT_CSV2/8]>>(CAP_BIT_FEAT_CSV2%8))&1);
      if(CAP_BIT_FEAT_CSV3/8<size)bits[@"FEAT_CSV3"]=@((bytes[CAP_BIT_FEAT_CSV3/8]>>(CAP_BIT_FEAT_CSV3%8))&1);
      if(CAP_BIT_FEAT_DIT/8<size)bits[@"FEAT_DIT"]=@((bytes[CAP_BIT_FEAT_DIT/8]>>(CAP_BIT_FEAT_DIT%8))&1);
      if(CAP_BIT_FEAT_FP16/8<size)bits[@"FEAT_FP16"]=@((bytes[CAP_BIT_FEAT_FP16/8]>>(CAP_BIT_FEAT_FP16%8))&1);
      if(CAP_BIT_FEAT_SSBS/8<size)bits[@"FEAT_SSBS"]=@((bytes[CAP_BIT_FEAT_SSBS/8]>>(CAP_BIT_FEAT_SSBS%8))&1);
      if(CAP_BIT_FEAT_BTI/8<size)bits[@"FEAT_BTI"]=@((bytes[CAP_BIT_FEAT_BTI/8]>>(CAP_BIT_FEAT_BTI%8))&1);
      if(CAP_BIT_FEAT_SME/8<size)bits[@"FEAT_SME"]=@((bytes[CAP_BIT_FEAT_SME/8]>>(CAP_BIT_FEAT_SME%8))&1);
      if(CAP_BIT_FEAT_SME2/8<size)bits[@"FEAT_SME2"]=@((bytes[CAP_BIT_FEAT_SME2/8]>>(CAP_BIT_FEAT_SME2%8))&1);
      if(CAP_BIT_FEAT_SME_F64F64/8<size)bits[@"FEAT_SME_F64F64"]=@((bytes[CAP_BIT_FEAT_SME_F64F64/8]>>(CAP_BIT_FEAT_SME_F64F64%8))&1);
      if(CAP_BIT_FEAT_SME_I16I64/8<size)bits[@"FEAT_SME_I16I64"]=@((bytes[CAP_BIT_FEAT_SME_I16I64/8]>>(CAP_BIT_FEAT_SME_I16I64%8))&1);
      if(CAP_BIT_AdvSIMD/8<size)bits[@"AdvSIMD"]=@((bytes[CAP_BIT_AdvSIMD/8]>>(CAP_BIT_AdvSIMD%8))&1);
      if(CAP_BIT_AdvSIMD_HPFPCvt/8<size)bits[@"AdvSIMD_HPFPCvt"]=@((bytes[CAP_BIT_AdvSIMD_HPFPCvt/8]>>(CAP_BIT_AdvSIMD_HPFPCvt%8))&1);
      if(CAP_BIT_CRC32/8<size)bits[@"CRC32"]=@((bytes[CAP_BIT_CRC32/8]>>(CAP_BIT_CRC32%8))&1);
      if(CAP_BIT_SME_F32F32/8<size)bits[@"SME_F32F32"]=@((bytes[CAP_BIT_SME_F32F32/8]>>(CAP_BIT_SME_F32F32%8))&1);
      if(CAP_BIT_SME_BI32I32/8<size)bits[@"SME_BI32I32"]=@((bytes[CAP_BIT_SME_BI32I32/8]>>(CAP_BIT_SME_BI32I32%8))&1);
      if(CAP_BIT_SME_B16F32/8<size)bits[@"SME_B16F32"]=@((bytes[CAP_BIT_SME_B16F32/8]>>(CAP_BIT_SME_B16F32%8))&1);
      if(CAP_BIT_SME_F16F32/8<size)bits[@"SME_F16F32"]=@((bytes[CAP_BIT_SME_F16F32/8]>>(CAP_BIT_SME_F16F32%8))&1);
      if(CAP_BIT_SME_I8I32/8<size)bits[@"SME_I8I32"]=@((bytes[CAP_BIT_SME_I8I32/8]>>(CAP_BIT_SME_I8I32%8))&1);
      if(CAP_BIT_SME_I16I32/8<size)bits[@"SME_I16I32"]=@((bytes[CAP_BIT_SME_I16I32/8]>>(CAP_BIT_SME_I16I32%8))&1);
    }
    record(@"sysctl:hw.optional.arm.caps",@"userspace_cpu_capabilities",start,code==0?@{@"returnedBytes":@(size),@"rawBase64":[[NSData dataWithBytes:bytes length:size] base64EncodedStringWithOptions:0],@"knownBits":bits}:nil,code==0?nil:[NSString stringWithFormat:@"errno=%d",saved]);
  }
  for(NSString *key in @[@"hw.machine",@"kern.osrelease",@"kern.osversion",@"kern.version"]) {
    const double start=stamp();char value[1024]={};size_t size=sizeof(value);const int code=sysctlbyname(key.UTF8String,value,&size,nullptr,0);const int saved=errno;
    record([@"sysctl:" stringByAppendingString:key],@"environment",start,code==0?@{@"text":[[NSString alloc] initWithBytes:value length:strnlen(value,sizeof(value)) encoding:NSUTF8StringEncoding]?:@"",@"truncated":@NO}:nil,code==0?nil:[NSString stringWithFormat:@"errno=%d",saved]);
  }
  // Read-only XNU source probes, not a portable Apple memory-budget API.
  {const double start=stamp();NSDictionary *v=appleLedgerSources();record(@"ledger(own_task)",@"native_task_ledger_template_and_entries",start,v,v[@"error"]);}
  { // XNU kern_memorystatus.h: read-only own-process commands 19 and 24.
    using GetStatus=int(*)(uint32_t,int32_t,uint32_t,void *,size_t);
    static auto getStatus=(GetStatus)dlsym(RTLD_DEFAULT,"memorystatus_control");
    const uint32_t commands[]={19,24};NSArray *labels=@[@"GET_PROCESS_IS_FREEZABLE",@"GET_PROCESS_IS_FROZEN"];
    for(unsigned i=0;i<2;++i){const double start=stamp();errno=0;const int value=getStatus?getStatus(commands[i],getpid(),0,nullptr,0):-1;const int saved=getStatus?errno:ENOSYS;
      record([NSString stringWithFormat:@"memorystatus_control(%@)",labels[i]],@"own_process_freezer_flags",start,value>=0?@{@"raw":signedExact(value),@"command":@(commands[i]),@"semantics":i==0?@"OS freeze-disabled preference inverted; not proof that all freezing eligibility conditions hold":@"Native frozen accounting flag; not evidence this executing thread is currently suspended"}:nil,value>=0?nil:[NSString stringWithFormat:@"errno=%d",saved]);
    }
  }
  for(NSString *key in @[@"kern.memorystatus_available_pages",@"kern.memorystatus_level",@"kern.memorystatus_vm_pressure_level",@"kern.memorystatus.kill_on_sustained_pressure_count"]) {
    const double start=stamp();uint64_t v=0;size_t size=sizeof(v);const int code=sysctlbyname(key.UTF8String,&v,&size,nullptr,0);const int saved=errno;
    record([@"sysctl:" stringByAppendingString:key],@"system_memory_pressure",start,code==0?@{@"raw":exact(v),@"returnedBytes":@(size)}:nil,code==0?nil:[NSString stringWithFormat:@"errno=%d",saved]);
  }
  for(NSString *key in @[@"hw.memsize",@"hw.ncpu",@"hw.activecpu",@"hw.physicalcpu",@"hw.logicalcpu",@"hw.pagesize",@"hw.cachelinesize",@"hw.l1icachesize",@"hw.l1dcachesize",@"hw.l2cachesize",@"hw.l3cachesize",@"hw.cpufrequency",@"hw.tbfrequency",@"hw.perflevel0.physicalcpu",@"hw.perflevel1.physicalcpu"]) {
    const double start=stamp(); uint64_t v=0; size_t size=sizeof(v); const int code=sysctlbyname(key.UTF8String,&v,&size,nullptr,0);const int saved=errno;
    record([@"sysctl:" stringByAppendingString:key],@"system_configuration",start,code==0?@{@"raw":exact(v),@"returnedBytes":@(size)}:nil,code==0?nil:[NSString stringWithFormat:@"errno=%d",saved]);
  }
  for(int level=0;level<4;++level) for(NSString *field in @[@"physicalcpu",@"physicalcpu_max",@"logicalcpu",@"logicalcpu_max",@"cpusperl2",@"l1icachesize",@"l1dcachesize",@"l2cachesize",@"l3cachesize"]) {
    if([field isEqualToString:@"physicalcpu"]&&level<2)continue;
    NSString *key=[NSString stringWithFormat:@"hw.perflevel%d.%@",level,field];const double start=stamp();uint64_t value=0;size_t size=sizeof(value);const int code=sysctlbyname(key.UTF8String,&value,&size,nullptr,0);const int saved=errno;
    record([@"sysctl:" stringByAppendingString:key],@"cpu_performance_level_configuration",start,code==0?@{@"raw":exact(value),@"returnedBytes":@(size)}:nil,code==0?nil:[NSString stringWithFormat:@"errno=%d",saved]);
  }
  {const double start=stamp();NSMutableArray *rows=[NSMutableArray new];
    const clockid_t clocks[]={CLOCK_REALTIME,CLOCK_MONOTONIC,CLOCK_MONOTONIC_RAW,CLOCK_MONOTONIC_RAW_APPROX,CLOCK_UPTIME_RAW,CLOCK_UPTIME_RAW_APPROX,CLOCK_PROCESS_CPUTIME_ID,CLOCK_THREAD_CPUTIME_ID};
    NSArray *names=@[@"CLOCK_REALTIME",@"CLOCK_MONOTONIC",@"CLOCK_MONOTONIC_RAW",@"CLOCK_MONOTONIC_RAW_APPROX",@"CLOCK_UPTIME_RAW",@"CLOCK_UPTIME_RAW_APPROX",@"CLOCK_PROCESS_CPUTIME_ID",@"CLOCK_THREAD_CPUTIME_ID"];
    for(NSUInteger i=0;i<names.count;++i){timespec value{},resolution{};const int code=clock_gettime(clocks[i],&value),saved=code?errno:0;const int rc=clock_getres(clocks[i],&resolution),re=rc?errno:0;
      [rows addObject:@{@"name":names[i],@"seconds":code?(id)NSNull.null:signedExact(value.tv_sec),@"nanoseconds":code?(id)NSNull.null:signedExact(value.tv_nsec),@"errno":@(saved),@"resolutionSeconds":rc?(id)NSNull.null:signedExact(resolution.tv_sec),@"resolutionNanoseconds":rc?(id)NSNull.null:signedExact(resolution.tv_nsec),@"resolutionErrno":@(re)}];}
    record(@"clock_gettime_and_resolution",@"system_process_and_calling_collector_thread",start,@{@"clocks":rows},nil);
  }
  {const double start=stamp();const auto raw=bench::intervalTimerSources();NSError *error=nil;NSDictionary *values=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:raw.data() length:raw.size()] options:0 error:&error];record(@"getitimer",@"process_interval_timers",start,values,error.localizedDescription);}
  {const double start=stamp();NSURL *url=[NSURL fileURLWithPath:NSHomeDirectory()];NSMutableArray *rows=[NSMutableArray new];
    for(NSURLResourceKey key in @[NSURLVolumeTotalCapacityKey,NSURLVolumeAvailableCapacityKey,NSURLVolumeAvailableCapacityForImportantUsageKey,NSURLVolumeAvailableCapacityForOpportunisticUsageKey,NSURLVolumeMaximumFileSizeKey,NSURLVolumeIsReadOnlyKey,NSURLVolumeSupportsSparseFilesKey,NSURLVolumeSupportsVolumeSizesKey]) {
      id value=nil;NSError *error=nil;BOOL success=[url getResourceValue:&value forKey:key error:&error];[rows addObject:@{@"key":key,@"value":[value isKindOfClass:NSNumber.class]?[value stringValue]:(value?:NSNull.null),@"success":@(success),@"error":error.localizedDescription?:NSNull.null}];
    }record(@"NSURL_volume_capacity",@"app_home_volume_policy_estimates",start,@{@"resources":rows},nil);
  }
  {const double start=stamp();const auto raw=bench::posixResourceLimits(NSHomeDirectory().UTF8String);NSError *error=nil;NSDictionary *values=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:raw.data() length:raw.size()] options:0 error:&error];record(@"sysconf_pathconf_resource_limits",@"process_system_filesystem_constraints",start,values,error.localizedDescription);}
  {const double start=stamp();record(@"getfsstat(MNT_NOWAIT)",@"mounted_filesystem_cached_resources",start,mountedFilesystemSources(),nil);}
  {const double start=stamp();record(@"getattrlist(app_home_volume)",@"filesystem_native_resource_attributes",start,volumeResourceSources(),nil);}
  {const double start=stamp();struct statfs v{};const int code=statfs(NSHomeDirectory().UTF8String,&v);const int saved=errno;
    record(@"statfs(app_home)",@"filesystem",start,code==0?@{@"blockSize":exact(v.f_bsize),@"optimalIoBytes":signedExact(v.f_iosize),@"blocks":exact(v.f_blocks),@"freeBlocks":exact(v.f_bfree),@"availableBlocks":exact(v.f_bavail),@"files":exact(v.f_files),@"freeFiles":exact(v.f_ffree),@"type":exact(v.f_type),@"subtype":exact(v.f_fssubtype),@"flags":exact(v.f_flags),@"filesystemType":[NSString stringWithUTF8String:v.f_fstypename]}:nil,code==0?nil:[NSString stringWithFormat:@"errno=%d",saved]);
  }
  { const double start=stamp(); struct ifaddrs *interfaces=nullptr; const int code=getifaddrs(&interfaces); const int saved=errno;
    NSMutableArray *rows=[NSMutableArray new];
    if(code==0) for(auto it=interfaces;it;it=it->ifa_next) {
      if(!it->ifa_addr||it->ifa_addr->sa_family!=AF_LINK||!it->ifa_data) continue;
      const auto &v=*(struct if_data *)it->ifa_data;
      // Intentionally exclude addresses. Counters are interface-wide and may wrap.
      [rows addObject:@{@"name":[NSString stringWithUTF8String:it->ifa_name],@"flags":@(it->ifa_flags),@"mtu":exact(v.ifi_mtu),@"baudrate":exact(v.ifi_baudrate),@"ibytes":exact(v.ifi_ibytes),@"obytes":exact(v.ifi_obytes),@"ipackets":exact(v.ifi_ipackets),@"opackets":exact(v.ifi_opackets),@"ierrors":exact(v.ifi_ierrors),@"oerrors":exact(v.ifi_oerrors),@"collisions":exact(v.ifi_collisions),@"iqdrops":exact(v.ifi_iqdrops),@"imcasts":exact(v.ifi_imcasts),@"omcasts":exact(v.ifi_omcasts),@"noproto":exact(v.ifi_noproto),@"type":exact(v.ifi_type),@"typeLength":exact(v.ifi_typelen),@"physical":exact(v.ifi_physical),@"addressLength":exact(v.ifi_addrlen),@"headerLength":exact(v.ifi_hdrlen),@"receiveQuota":exact(v.ifi_recvquota),@"transmitQuota":exact(v.ifi_xmitquota),@"lastChangeSeconds":signedExact(v.ifi_lastchange.tv_sec),@"lastChangeMicroseconds":signedExact(v.ifi_lastchange.tv_usec)}];
    } if(interfaces) freeifaddrs(interfaces);
    record(@"getifaddrs(AF_LINK)",@"network_interface_system",start,code==0?@{@"interfaces":rows}:nil,code==0?nil:[NSString stringWithFormat:@"errno=%d",saved]);
  }
  {const double start=stamp();const auto raw=bench::appleInterfaceSources();NSError *error=nil;NSDictionary *values=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:raw.data() length:raw.size()] options:0 error:&error];record(@"NET_RT_IFLIST2",@"network_interface_system_64bit",start,values,error.localizedDescription);}
  {const double start=stamp();const auto raw=bench::descriptorSources();NSError *error=nil;NSDictionary *values=[NSJSONSerialization JSONObjectWithData:[NSData dataWithBytes:raw.data() length:raw.size()] options:0 error:&error];record(@"native_descriptor_sources",@"process_descriptor_range",start,values,error.localizedDescription);}
  { const double start=stamp(); struct statvfs v{}; const int code=statvfs(NSHomeDirectory().UTF8String,&v); const int saved=errno;
    record(@"statvfs(app_home)",@"filesystem",start,code==0?@{@"blockSize":exact(v.f_bsize),@"fragmentSize":exact(v.f_frsize),@"blocks":exact(v.f_blocks),@"freeBlocks":exact(v.f_bfree),@"availableBlocks":exact(v.f_bavail),@"files":exact(v.f_files),@"freeFiles":exact(v.f_ffree),@"availableFiles":exact(v.f_favail),@"flags":exact(v.f_flag),@"maximumNameLength":exact(v.f_namemax)}:nil,code==0?nil:[NSString stringWithFormat:@"errno=%d",saved]);
  }
  { const double start=stamp(); DIR *dir=opendir("/dev/fd");const int saved=errno; uint64_t n=0;
    if(dir) {const int own=dirfd(dir);while(auto e=readdir(dir)) {char *end=nullptr; const long fd=strtol(e->d_name,&end,10); if(*e->d_name && !*end && fd>=0 && fd!=own) ++n;}closedir(dir);}
    record(@"opendir(/dev/fd)",@"process",start,dir?@{@"openDescriptorsExcludingScan":exact(n)}:nil,dir?nil:[NSString stringWithFormat:@"errno=%d",saved]);
  }
  { const double start=stamp();struct rlimit limit{};const int code=getrlimit(RLIMIT_NOFILE,&limit);const int saved=errno;
    uint64_t count=0,scanned=0;bool timeLimit=false;int scanError=0;
    const uint64_t bound=code==0?std::min<uint64_t>(limit.rlim_cur,16384):0;
    for(;scanned<bound;++scanned) {
      if(stamp()-start>50) {timeLimit=true;break;}
      errno=0;const int result=fcntl((int)scanned,F_GETFD);
      if(result>=0) ++count;else if(errno!=EBADF) {scanError=errno;break;}
    }
    record(@"fcntl(F_GETFD) bounded scan",@"process_descriptor_range",start,code==0?@{@"openCount":exact(count),@"scannedExclusive":exact(scanned),@"softLimit":exact(limit.rlim_cur),@"softLimitFullyScanned":@(scanned==limit.rlim_cur),@"timeLimit":@(timeLimit),@"scanErrno":@(scanError)}:nil,code==0?nil:[NSString stringWithFormat:@"errno=%d",saved]);
  }
  {const double start=stamp();record(@"malloc_registered_zone_statistics",@"process_allocator_zones",start,benchAllocator::capture(),nil);}
  {const double start=stamp();malloc_statistics_t v{};malloc_zone_statistics(nullptr,&v);
    record(@"malloc_zone_statistics(NULL)",@"process_allocator",start,@{@"blocks_in_use":exact(v.blocks_in_use),@"size_in_use":exact(v.size_in_use),@"max_size_in_use":exact(v.max_size_in_use),@"size_allocated":exact(v.size_allocated)},nil);}
  {const double start=stamp();NSDictionary *values=threadScheduling();record(@"thread_info_and_policy",@"process_threads",start,values,values[@"error"]==NSNull.null?nil:[NSString stringWithFormat:@"task_threads error=%@",values[@"error"]]);}
  { const double start=stamp();mach_port_name_array_t names=nullptr;mach_port_type_array_t types=nullptr;mach_msg_type_number_t nameCount=0,typeCount=0;
    const auto code=mach_port_names(mach_task_self(),&names,&nameCount,&types,&typeCount);
    NSMutableArray *ports=[NSMutableArray new];
    NSUInteger detailCount=0;
    if(code==KERN_SUCCESS) for(mach_msg_type_number_t i=0;i<std::min(nameCount,typeCount);++i) {
      NSMutableDictionary *row=[@{@"name":exact(names[i]),@"typeMask":exact(types[i])} mutableCopy];
      if(i<512&&stamp()-start<100) {
        NSMutableArray *refs=[NSMutableArray new];
        for(const auto right : {MACH_PORT_RIGHT_SEND,MACH_PORT_RIGHT_SEND_ONCE,MACH_PORT_RIGHT_RECEIVE,MACH_PORT_RIGHT_PORT_SET,MACH_PORT_RIGHT_DEAD_NAME}) {
          if(!(types[i]&MACH_PORT_TYPE(right)))continue;
          mach_port_urefs_t n=0;const auto rc=mach_port_get_refs(mach_task_self(),names[i],right,&n);
          [refs addObject:@{@"right":@(right),@"returnCode":@(rc),@"userReferences":rc==KERN_SUCCESS?exact(n):(id)NSNull.null}];
        }row[@"rightReferences"]=refs;
      }else row[@"rightReferencesError"]=@"detail scan limit";
      if((types[i]&MACH_PORT_TYPE_RECEIVE)&&detailCount<512&&stamp()-start<100) {
        ++detailCount;mach_port_info_ext_t v{};mach_msg_type_number_t count=MACH_PORT_INFO_EXT_COUNT;const auto status=mach_port_get_attributes(mach_task_self(),names[i],MACH_PORT_INFO_EXT,(mach_port_info_t)&v,&count);NSMutableDictionary *values=[NSMutableDictionary new];
        if(status==KERN_SUCCESS){FIELD(mpie_status.mps_pset);FIELD(mpie_status.mps_seqno);FIELD(mpie_status.mps_mscount);FIELD(mpie_status.mps_qlimit);FIELD(mpie_status.mps_msgcount);FIELD(mpie_status.mps_sorights);FIELD(mpie_status.mps_srights);FIELD(mpie_status.mps_pdrequest);FIELD(mpie_status.mps_nsrequest);FIELD(mpie_status.mps_flags);FIELD(mpie_boost_cnt);}
        row[@"receiveStatus"]=@{@"returnCode":@(status),@"returnedNaturalWords":@(count),@"values":status==KERN_SUCCESS?values:(id)NSNull.null};
        natural_t slots=0;mach_msg_type_number_t slotCount=1;
        const auto slotCode=mach_port_get_attributes(mach_task_self(),names[i],MACH_PORT_DNREQUESTS_SIZE,(mach_port_info_t)&slots,&slotCount);
        row[@"deadNameRequestTable"]=@{@"returnCode":@(slotCode),@"returnedNaturalWords":@(slotCount),@"allocatedSlots":slotCode==KERN_SUCCESS&&slotCount>=1?exact(slots):(id)NSNull.null};

      }else if(types[i]&MACH_PORT_TYPE_RECEIVE)row[@"receiveStatus"]=@{@"error":@"detail scan limit"};
      [ports addObject:row];
    }
    if(names) vm_deallocate(mach_task_self(),(vm_address_t)names,nameCount*sizeof(mach_port_name_t));
    if(types) vm_deallocate(mach_task_self(),(vm_address_t)types,typeCount*sizeof(mach_port_type_t));
    record(@"mach_port_names",@"process_port_namespace",start,code==KERN_SUCCESS?@{@"ports":ports,@"nameCount":@(nameCount),@"typeCount":@(typeCount)}:nil,code==KERN_SUCCESS && nameCount==typeCount?nil:[NSString stringWithFormat:@"kern_return_t=%d names=%u types=%u",code,nameCount,typeCount]);
  }
  for(NSNumber *resource in @[@(RLIMIT_NOFILE),@(RLIMIT_STACK),@(RLIMIT_AS),@(RLIMIT_CPU),@(RLIMIT_MEMLOCK),@(RLIMIT_FSIZE),@(RLIMIT_DATA),@(RLIMIT_CORE),@(RLIMIT_NPROC)]) {
    const double start=stamp(); struct rlimit v{};const int code=getrlimit(resource.intValue,&v);const int saved=errno;
    record([NSString stringWithFormat:@"getrlimit(%d)",resource.intValue],@"process_limit",start,code==0?@{@"soft":exact(v.rlim_cur),@"hard":exact(v.rlim_max),@"infinity":exact(RLIM_INFINITY)}:nil,code==0?nil:[NSString stringWithFormat:@"errno=%d",saved]);
  }
  { const double start=stamp(); __block NSDictionary *values;
    dispatch_sync(dispatch_get_main_queue(),^{ values=@{@"batteryLevel":@(UIDevice.currentDevice.batteryLevel),@"batteryState":@(UIDevice.currentDevice.batteryState),@"lowPowerMode":@(NSProcessInfo.processInfo.lowPowerModeEnabled),@"thermalState":@(NSProcessInfo.processInfo.thermalState)}; });
    record(@"UIDevice_and_ProcessInfo",@"battery_and_system",start,values,nil);
  }
  record(@"owned_mapping_page_probe",@"explicit_probe_last_result",stamp(),_pageProbe?:@{@"state":@"not_requested"},nil);
  record(@"MetricKit.delivery_status",@"delayed_os_reports",stamp(),@{@"payloadsReceived":exact(_metricKit.received),@"captureState":[NSString stringWithUTF8String:_metricKit.state.c_str()],@"path":[NSString stringWithUTF8String:_metricKit.writer.filePath().c_str()]},nil);
  { mach_timebase_info_data_t timebase{};mach_timebase_info(&timebase);
    record(@"clocks",@"environment",stamp(),@{@"machAbsoluteTime":exact(mach_absolute_time()),@"machContinuousTime":exact(mach_continuous_time()),@"timebaseNumer":@(timebase.numer),@"timebaseDenom":@(timebase.denom)},nil);
  }
  if(!_foreground.load()||_closed.load()) throw std::runtime_error("Source sampling interrupted");
  NSDictionary *row=@{@"captureSchema":@1,@"platform":@"ios",@"appVersion":[NSBundle.mainBundle objectForInfoDictionaryKey:@"CFBundleShortVersionString"]?:@"unknown",@"processId":@(getpid()),@"sequence":@(++_sequence),@"sampledAtMs":@(NSDate.date.timeIntervalSince1970*1000.),@"clockSource":@"NSProcessInfo.systemUptime",@"osVersion":UIDevice.currentDevice.systemVersion,@"sources":sources};
  NSError *jsonError=nil; NSData *json=[NSJSONSerialization dataWithJSONObject:row options:0 error:&jsonError];
  if(!json) throw std::runtime_error(jsonError.localizedDescription.UTF8String);
  NSString *directory=[NSSearchPathForDirectoriesInDomains(NSDocumentDirectory,NSUserDomainMask,YES).firstObject stringByAppendingPathComponent:@"source-captures"];
  // Separate stream; shared directory cap includes thread files.
  static bench::SourceCapture capture(64*1024*1024,128*1024*1024,"signals");
  auto state=capture.append(directory.UTF8String,std::string((const char *)json.bytes,json.length));
  NSUInteger unavailable=0;for(NSDictionary *source in sources) if(source[@"error"]!=NSNull.null) ++unavailable;
  NSDictionary *summary=@{@"platform":@"ios",@"sequence":@(_sequence),@"sources":@(sources.count),@"unavailable":@(unavailable),@"state":[NSString stringWithUTF8String:state.c_str()],@"path":[NSString stringWithUTF8String:capture.filePath().c_str()]};
  NSLog(@"WfloatSignals %@",[[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:summary options:0 error:nil] encoding:NSUTF8StringEncoding]);
  resolve(summary);
 } catch(const std::exception &e) { reject(@"SIGNALS_FAILED",[NSString stringWithUTF8String:e.what()],nil); }
}
- (void)invalidate { _closed.store(true);[_frameProbe stop];if(_pressureSource)dispatch_source_cancel(_pressureSource);[MXMetricManager.sharedManager removeSubscriber:self];[NSNotificationCenter.defaultCenter removeObserver:self];BOOL previous=_batteryWasEnabled;dispatch_async(dispatch_get_main_queue(),^{UIDevice.currentDevice.batteryMonitoringEnabled=previous;}); }
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
@end
