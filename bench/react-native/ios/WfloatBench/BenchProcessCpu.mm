#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#include "../../cpp/ProcessCpuCounters.h"
#include <unistd.h>
#include <atomic>

@interface BenchProcessCpu : NSObject <RCTBridgeModule, RCTInvalidating> {
  std::atomic<bool> _foreground, _closed;
  uint64_t _sequence;
  dispatch_queue_t _queue;
  BOOL _overheadActive, _previousIdleDisabled;
}
@end

@implementation BenchProcessCpu
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return YES; }
- (instancetype)init {
  if ((self = [super init])) {
    _queue = dispatch_queue_create("com.wfloat.bench.processcpu", DISPATCH_QUEUE_SERIAL);
    _foreground.store(UIApplication.sharedApplication.applicationState == UIApplicationStateActive);
    _closed.store(false); _sequence = 0;
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(resumed:)
      name:UIApplicationDidBecomeActiveNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(paused:)
      name:UIApplicationWillResignActiveNotification object:nil];
  }
  return self;
}
- (dispatch_queue_t)methodQueue { return _queue; }
- (void)resumed:(NSNotification *)notification { _foreground.store(true); }
- (void)keepAwake:(BOOL)active {
  if (active) {
    if (!_overheadActive) _previousIdleDisabled = UIApplication.sharedApplication.idleTimerDisabled;
    UIApplication.sharedApplication.idleTimerDisabled = YES;
  } else if (_overheadActive) UIApplication.sharedApplication.idleTimerDisabled = _previousIdleDisabled;
  _overheadActive = active;
}
- (void)paused:(NSNotification *)notification { _foreground.store(false); [self keepAwake:NO]; }
RCT_EXPORT_METHOD(setOverheadActive:(BOOL)active resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  dispatch_async(dispatch_get_main_queue(), ^{
    if (active && (self->_closed.load() || !self->_foreground.load())) {
      reject(@"OVERHEAD_STATE_FAILED", @"Overhead check requires the foreground app", nil); return;
    }
    [self keepAwake:active]; resolve(nil);
  });
}
RCT_EXPORT_METHOD(recordOverhead:(NSString *)json resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSData *data = [json dataUsingEncoding:NSUTF8StringEncoding];
  id row = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (_closed.load() || data.length > 3500 || ![row isKindOfClass:NSDictionary.class] || !row[@"event"] || !row[@"runId"]) {
    reject(@"OVERHEAD_LOG_FAILED", @"Invalid overhead record", nil); return;
  }
  NSLog(@"WfloatOverhead %@", json); resolve(nil);
}
RCT_EXPORT_METHOD(read:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (_closed.load() || !_foreground.load()) {
    reject(@"PROCESS_CPU_PAUSED", @"CPU sampling requires the foreground app", nil); return;
  }
  try {
    const double before = NSProcessInfo.processInfo.systemUptime * 1000.0;
    const auto usage = bench::readProcessCpuCounters();
    const double after = NSProcessInfo.processInfo.systemUptime * 1000.0;
    if (_closed.load() || !_foreground.load()) {
      reject(@"PROCESS_CPU_PAUSED", @"CPU sampling was interrupted", nil); return;
    }
    NSDictionary *row = @{
      @"userCpuTimeUs": @(usage.userUs), @"systemCpuTimeUs": @(usage.systemUs),
      @"cpuTimeMs": @(usage.totalUs() / 1000.0),
      @"queryStartedUptimeMs": @(before), @"queryFinishedUptimeMs": @(after),
      @"monotonicMs": @(before + (after - before) / 2.0),
      @"clockSource": @"NSProcessInfo.systemUptime",
      @"sampledAtMs": @(NSDate.date.timeIntervalSince1970 * 1000.0),
      @"processId": @(getpid()), @"sequence": @(++_sequence),
      @"source": @"getrusage(RUSAGE_SELF):ru_utime,ru_stime",
      @"platform": @"ios", @"osVersion": UIDevice.currentDevice.systemVersion
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:row options:0 error:nil];
    if (json) NSLog(@"WfloatProcessCpu %@", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
    resolve(row);
  } catch (const std::exception &error) {
    reject(@"PROCESS_CPU_READ_FAILED", [NSString stringWithUTF8String:error.what()], nil);
  }
}
- (void)invalidate {
  _closed.store(true); [NSNotificationCenter.defaultCenter removeObserver:self];
  dispatch_async(dispatch_get_main_queue(), ^{ [self keepAwake:NO]; });
}
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
@end
