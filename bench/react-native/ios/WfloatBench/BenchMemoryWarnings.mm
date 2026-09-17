#import "BenchMemoryWarnings.h"
#import <UIKit/UIKit.h>
#import <React/RCTEventEmitter.h>
#include <TargetConditionals.h>
#include <atomic>
#include <unistd.h>

static NSString *const WarningRecorded = @"WfloatMemoryWarningRecorded";

@interface WfloatMemoryWarningStore : NSObject
@property(nonatomic, copy) NSString *observationId;
@property(nonatomic) double startedAtMs, startedUptimeMs;
@property(nonatomic) uint64_t count;
@property(nonatomic, copy) NSDictionary *lastWarning;
@property(nonatomic, strong) id observer;
+ (instancetype)shared;
- (NSDictionary *)snapshot;
- (void)receivedWarning;
- (void)logSnapshot:(NSDictionary *)row kind:(NSString *)kind;
@end

@implementation WfloatMemoryWarningStore
+ (instancetype)shared {
  NSAssert(NSThread.isMainThread, @"Memory warning store requires the main thread");
  static WfloatMemoryWarningStore *store;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ store = [WfloatMemoryWarningStore new]; });
  return store;
}
- (instancetype)init {
  if ((self = [super init])) {
    _observationId = NSUUID.UUID.UUIDString;
    _startedAtMs = NSDate.date.timeIntervalSince1970 * 1000.0;
    _startedUptimeMs = NSProcessInfo.processInfo.systemUptime * 1000.0;
    __weak WfloatMemoryWarningStore *weakSelf = self;
    _observer = [NSNotificationCenter.defaultCenter addObserverForName:UIApplicationDidReceiveMemoryWarningNotification
      object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *notification) {
        [weakSelf receivedWarning];
      }];
    [self logSnapshot:[self snapshot] kind:@"observation_started"];
  }
  return self;
}
- (NSDictionary *)snapshot {
  return @{
    @"source": @"UIApplication.didReceiveMemoryWarningNotification",
    @"scope": @"warnings_delivered_to_app", @"platform": @"ios",
    @"osVersion": UIDevice.currentDevice.systemVersion,
    @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
    @"clockSource": @"NSProcessInfo.systemUptime", @"processId": @(getpid()),
    @"observationId": _observationId,
    @"observationStartedAtMs": @(_startedAtMs), @"observationStartedUptimeMs": @(_startedUptimeMs),
    @"warningCount": @(_count), @"lastWarning": _lastWarning ?: (id)NSNull.null,
    @"snapshotAtMs": @(NSDate.date.timeIntervalSince1970 * 1000.0),
    @"snapshotUptimeMs": @(NSProcessInfo.processInfo.systemUptime * 1000.0)
  };
}
- (void)receivedWarning {
  // Receipt time on the native main queue; UIKit does not provide an OS-origin timestamp.
  const double receivedUptimeMs = NSProcessInfo.processInfo.systemUptime * 1000.0;
  const double receivedAtMs = NSDate.date.timeIntervalSince1970 * 1000.0;
  NSString *state;
  switch (UIApplication.sharedApplication.applicationState) {
    case UIApplicationStateActive: state = @"active"; break;
    case UIApplicationStateInactive: state = @"inactive"; break;
    case UIApplicationStateBackground: state = @"background"; break;
    default: state = @"unknown";
  }
  _lastWarning = @{@"sequence": @(++_count), @"receivedAtMs": @(receivedAtMs),
    @"receivedUptimeMs": @(receivedUptimeMs), @"applicationState": state};
  NSDictionary *row = [self snapshot];
  [self logSnapshot:row kind:@"warning_received"];
  [NSNotificationCenter.defaultCenter postNotificationName:WarningRecorded object:self userInfo:@{@"snapshot": row}];
}
- (void)logSnapshot:(NSDictionary *)row kind:(NSString *)kind {
  NSData *data = [NSJSONSerialization dataWithJSONObject:row options:0 error:nil];
  if (!data) return;
  NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  const NSUInteger parts = (json.length + 599) / 600;
  for (NSUInteger part = 0; part < parts; ++part)
    NSLog(@"WfloatMemoryWarningChunk pid=%d observation=%@ count=%llu kind=%@ part=%lu/%lu %@",
      getpid(), _observationId, (unsigned long long)_count, kind,
      (unsigned long)(part + 1), (unsigned long)parts,
      [json substringWithRange:NSMakeRange(part * 600, MIN(600, json.length - part * 600))]);
}
@end

void WfloatStartMemoryWarningObservation(void) { [WfloatMemoryWarningStore shared]; }

@interface BenchMemoryWarnings : RCTEventEmitter {
  std::atomic<bool> _closed;
}
@end

@implementation BenchMemoryWarnings
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return YES; }
- (dispatch_queue_t)methodQueue { return dispatch_get_main_queue(); }
- (instancetype)init {
  if ((self = [super init])) _closed.store(false);
  return self;
}
- (NSArray<NSString *> *)supportedEvents { return @[@"WfloatMemoryWarning"]; }
- (void)startObserving {
  if (_closed.load()) return;
  [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(recorded:)
    name:WarningRecorded object:[WfloatMemoryWarningStore shared]];
}
- (void)stopObserving { [NSNotificationCenter.defaultCenter removeObserver:self]; }
- (void)recorded:(NSNotification *)notification {
  if (!_closed.load()) [self sendEventWithName:@"WfloatMemoryWarning" body:notification.userInfo[@"snapshot"]];
}
RCT_EXPORT_METHOD(read:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (_closed.load()) { reject(@"MEMORY_WARNINGS_CLOSED", @"Memory warning bridge is closed", nil); return; }
  resolve([[WfloatMemoryWarningStore shared] snapshot]);
}
- (void)invalidate { _closed.store(true); [self stopObserving]; [super invalidate]; }
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
@end
