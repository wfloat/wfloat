#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#include <mach/mach.h>
#include <unistd.h>
#include <atomic>
#include <climits>

@interface BenchPageFaults : NSObject <RCTBridgeModule, RCTInvalidating> {
  std::atomic<bool> _foreground;
  std::atomic<bool> _closed;
  uint64_t _sequence;
  dispatch_queue_t _queue;
}
@end

@implementation BenchPageFaults
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return YES; }
- (instancetype)init {
  if ((self = [super init])) {
    _queue = dispatch_queue_create("com.wfloat.bench.pagefaults", DISPATCH_QUEUE_SERIAL);
    _foreground.store(UIApplication.sharedApplication.applicationState == UIApplicationStateActive);
    _closed.store(false);
    _sequence = 0;
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(resumed:)
      name:UIApplicationDidBecomeActiveNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(paused:)
      name:UIApplicationWillResignActiveNotification object:nil];
  }
  return self;
}
- (dispatch_queue_t)methodQueue { return _queue; }
- (void)resumed:(NSNotification *)notification { _foreground.store(true); }
- (void)paused:(NSNotification *)notification { _foreground.store(false); }
RCT_EXPORT_METHOD(read:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (_closed.load() || !_foreground.load()) {
    reject(@"PAGE_FAULTS_PAUSED", @"Page-fault sampling requires the foreground app", nil); return;
  }
  task_events_info_data_t info = {};
  mach_msg_type_number_t count = TASK_EVENTS_INFO_COUNT;
  const double before = NSProcessInfo.processInfo.systemUptime * 1000.0;
  const auto status = task_info(mach_task_self(), TASK_EVENTS_INFO,
    reinterpret_cast<task_info_t>(&info), &count);
  const double after = NSProcessInfo.processInfo.systemUptime * 1000.0;
  const auto pageBytes = sysconf(_SC_PAGESIZE);
  if (status != KERN_SUCCESS || count < TASK_EVENTS_INFO_COUNT) {
    reject(@"PAGE_FAULTS_READ_FAILED", [NSString stringWithFormat:@"task_info failed (%d, count %u)", status, count], nil); return;
  }
  // XNU clamps these counters to INT32_MAX. A flat exhausted counter must
  // never appear as a trustworthy zero rate. Reject negative legacy overflow too.
  if (info.faults < 0 || info.pageins < 0 || info.faults >= INT32_MAX ||
      info.pageins >= INT32_MAX || pageBytes <= 0) {
    reject(@"PAGE_FAULTS_COUNTER_LIMIT", @"Invalid or exhausted Mach event counter", nil); return;
  }
  NSDictionary *row = @{
    @"kind": @"ios_vm_events",
    @"counters": @{ @"vmFaults": @(info.faults), @"pageIns": @(info.pageins) },
    @"source": @"task_info(TASK_EVENTS_INFO):faults,pageins",
    @"pageSizeBytes": @(pageBytes),
    @"queryStartedUptimeMs": @(before),
    @"queryFinishedUptimeMs": @(after),
    @"sampledAtMs": @(NSDate.date.timeIntervalSince1970 * 1000.0),
    @"processId": @(getpid()),
    @"sequence": @(++_sequence),
    @"osVersion": UIDevice.currentDevice.systemVersion
  };
  NSData *json = [NSJSONSerialization dataWithJSONObject:row options:0 error:nil];
  if (json) NSLog(@"WfloatPageFaults %@", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
  resolve(row);
}
- (void)invalidate {
  _closed.store(true);
  [NSNotificationCenter.defaultCenter removeObserver:self];
}
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
@end
