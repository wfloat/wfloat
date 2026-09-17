#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#include "../../cpp/CpuStress.h"

@interface BenchCpu : NSObject <RCTBridgeModule, RCTInvalidating> {
  bench::CpuStress _stress;
  std::atomic<bool> _foreground;
  dispatch_source_t _monitor;
}
@end

@implementation BenchCpu
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return YES; }

- (instancetype)init {
  if ((self = [super init])) {
    _foreground.store(UIApplication.sharedApplication.applicationState == UIApplicationStateActive);
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(becameActive:)
      name:UIApplicationDidBecomeActiveNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(becameInactive:)
      name:UIApplicationWillResignActiveNotification object:nil];
  }
  return self;
}
- (void)becameActive:(NSNotification *)notification { _foreground.store(true); }
- (void)becameInactive:(NSNotification *)notification {
  _foreground.store(false);
  _stress.stop("App moved to the background");
}
- (NSDictionary *)snapshot {
  const auto s = _stress.snapshot();
  return @{@"running": @(s.running), @"stopping": @(s.stopping),
    @"workers": @(s.workers), @"targetWorkers": @(s.targetWorkers),
    @"elapsedMs": @(s.elapsedMs), @"blocks": @(s.blocks), @"checksum": @(s.checksum),
    @"reason": [NSString stringWithUTF8String:s.reason.c_str()]};
}
- (void)observe {
  _stress.observe(static_cast<int>(NSProcessInfo.processInfo.thermalState), _foreground.load());
}
RCT_EXPORT_METHOD(start:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (!_foreground.load() || NSProcessInfo.processInfo.thermalState != NSProcessInfoThermalStateNominal) {
    reject(@"CPU_START_FAILED", @"CPU stress requires the foreground app and a nominal thermal reading", nil);
    return;
  }
  try {
    const int workers = static_cast<int>(std::clamp<NSUInteger>(NSProcessInfo.processInfo.activeProcessorCount, 1, 64));
    if (!_stress.start(workers, 600000)) {
      reject(@"CPU_START_FAILED", @"CPU stress is already running", nil);
      return;
    }
    if (_monitor) dispatch_source_cancel(_monitor);
    _monitor = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0,
      dispatch_queue_create("com.wfloat.bench.thermal-monitor", DISPATCH_QUEUE_SERIAL));
    dispatch_source_set_timer(_monitor, DISPATCH_TIME_NOW, 500 * NSEC_PER_MSEC, 25 * NSEC_PER_MSEC);
    __weak BenchCpu *weakSelf = self;
    dispatch_source_set_event_handler(_monitor, ^{ [weakSelf observe]; });
    dispatch_resume(_monitor);
    resolve([self snapshot]);
  } catch (const std::exception &error) {
    reject(@"CPU_START_FAILED", [NSString stringWithUTF8String:error.what()], nil);
  }
}
RCT_EXPORT_METHOD(read:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  NSDictionary *snapshot = [self snapshot];
  if (![snapshot[@"running"] boolValue] && _monitor) {
    dispatch_source_cancel(_monitor);
    _monitor = nil;
  }
  resolve(snapshot);
}
RCT_EXPORT_METHOD(stop:(double)reason resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  _stress.stop(reason == 3 ? "Thermal state changed" : reason == 4 ? "Thermal read failed" : "Stopped by you");
  resolve(nil);
}
- (void)invalidate {
  _stress.stop("Module closed");
  if (_monitor) { dispatch_source_cancel(_monitor); _monitor = nil; }
  [NSNotificationCenter.defaultCenter removeObserver:self];
}
- (void)dealloc { [self invalidate]; }
@end
