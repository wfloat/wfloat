#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#include "../../cpp/ContextSwitchCounters.h"
#include "../../cpp/WaitWakeProbe.h"
#include <unistd.h>

@interface BenchContextSwitches : NSObject <RCTBridgeModule, RCTInvalidating> {
  std::atomic<bool> _foreground, _closed;
  uint64_t _sequence;
  dispatch_queue_t _queue;
  bench::WaitWakeProbe _probe;
}
@end
@implementation BenchContextSwitches
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return YES; }
- (instancetype)init {
  if ((self = [super init])) {
    _queue = dispatch_queue_create("com.wfloat.bench.contextswitches", DISPATCH_QUEUE_SERIAL);
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
- (void)paused:(NSNotification *)notification { _foreground.store(false); _probe.cancel(); }
RCT_EXPORT_METHOD(read:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  try {
    if (_closed.load() || !_foreground.load()) throw std::runtime_error("Context-switch sampling requires the foreground app");
    const double before = NSProcessInfo.processInfo.systemUptime * 1000.0;
    const auto counters = bench::readContextSwitchCounters();
    const double after = NSProcessInfo.processInfo.systemUptime * 1000.0;
    if (_closed.load() || !_foreground.load()) throw std::runtime_error("Context-switch sampling was interrupted");
    const auto probe = _probe.snapshot();
    NSDictionary *row = @{
      @"platform": @"ios", @"source": @"task_info(TASK_EVENTS_INFO):csw",
      @"clockSource": @"NSProcessInfo.systemUptime", @"counters": @{ @"total": @(counters.total) },
      @"queryStartedUptimeMs": @(before), @"queryFinishedUptimeMs": @(after),
      @"sampledAtMs": @(NSDate.date.timeIntervalSince1970 * 1000.0),
      @"processId": @(getpid()), @"sequence": @(++_sequence), @"osVersion": UIDevice.currentDevice.systemVersion,
      @"probe": @{ @"running": @(probe.running), @"wakes": @(probe.wakes),
        @"elapsedMs": @(probe.elapsedMs), @"runSequence": @(probe.runSequence) }
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:row options:0 error:nil];
    if (json) NSLog(@"WfloatContextSwitches %@", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
    resolve(row);
  } catch (const std::exception &error) {
    reject(@"CONTEXT_SWITCHES_FAILED", [NSString stringWithUTF8String:error.what()], nil);
  }
}
RCT_EXPORT_METHOD(startProbe:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  try {
    const auto token = _probe.token();
    if (_closed.load() || !_foreground.load()) throw std::runtime_error("Wait/wake check requires the foreground app");
    _probe.start(token); resolve(nil);
  } catch (const std::exception &error) { reject(@"WAIT_WAKE_FAILED", [NSString stringWithUTF8String:error.what()], nil); }
}
RCT_EXPORT_METHOD(stopProbe:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) { _probe.cancel(); resolve(nil); }
- (void)invalidate { _closed.store(true); _probe.cancel(); [NSNotificationCenter.defaultCenter removeObserver:self]; }
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
@end
