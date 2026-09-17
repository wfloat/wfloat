#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#include "../../cpp/MachThreadCount.h"
#include "../../cpp/MachThreadCpu.h"
#include <atomic>
#include "../../cpp/SourceCapture.h"
#include <TargetConditionals.h>
#include <unistd.h>

@interface BenchThreads : NSObject <RCTBridgeModule, RCTInvalidating> {
  std::atomic<bool> _foreground, _closed;
  uint64_t _sequence;
  uint64_t _cpuSequence;
  dispatch_queue_t _queue;
  bench::SourceCapture _capture;
}
@end

@implementation BenchThreads
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return YES; }
- (instancetype)init {
  if ((self = [super init])) {
    _queue = dispatch_queue_create("com.wfloat.bench.threads", DISPATCH_QUEUE_SERIAL);
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
- (void)paused:(NSNotification *)notification { _foreground.store(false); }
RCT_EXPORT_METHOD(read:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (_closed.load() || !_foreground.load()) {
    reject(@"THREADS_PAUSED", @"Thread sampling requires the foreground app", nil); return;
  }
  try {
    const double before = NSProcessInfo.processInfo.systemUptime * 1000.0;
    const auto count = bench::readMachThreadCount();
    const double after = NSProcessInfo.processInfo.systemUptime * 1000.0;
    if (_closed.load() || !_foreground.load()) {
      reject(@"THREADS_PAUSED", @"Thread sampling was interrupted", nil); return;
    }
    NSDictionary *row = @{
      @"platform": @"ios", @"threadCount": @(count),
      @"source": @"task_threads(mach_task_self()):count",
      @"clockSource": @"NSProcessInfo.systemUptime",
      @"queryStartedUptimeMs": @(before), @"queryFinishedUptimeMs": @(after),
      @"sampledAtMs": @(NSDate.date.timeIntervalSince1970 * 1000.0),
      @"processId": @(getpid()), @"sequence": @(++_sequence),
      @"osVersion": UIDevice.currentDevice.systemVersion
    };
    NSData *json = [NSJSONSerialization dataWithJSONObject:row options:0 error:nil];
    if (json) NSLog(@"WfloatThreads %@", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
    resolve(row);
  } catch (const std::exception &error) {
    reject(@"THREADS_READ_FAILED", [NSString stringWithUTF8String:error.what()], nil);
  }
}
RCT_EXPORT_METHOD(readCpu:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (_closed.load() || !_foreground.load()) {
    reject(@"THREAD_CPU_PAUSED", @"Thread CPU sampling requires the foreground app", nil); return;
  }
  try {
    auto now = [] { return NSProcessInfo.processInfo.systemUptime * 1000.0; };
    const double before = now();
    const auto reading = bench::readMachThreadCpu(now);
    const double after = now();
    if (_closed.load() || !_foreground.load()) {
      reject(@"THREAD_CPU_PAUSED", @"Thread CPU sampling was interrupted", nil); return;
    }
    NSMutableArray *threads = [NSMutableArray array], *errors = [NSMutableArray array];
    for (const auto &t : reading.threads) [threads addObject:@{
      @"threadId": [NSString stringWithUTF8String:t.id.c_str()], @"startTimeTicks": NSNull.null,
      @"name": NSNull.null, @"userTime": @(t.userUs), @"systemTime": @(t.systemUs),
      @"runState": @(t.runState),
      @"sourceObservation": @{
        @"THREAD_BASIC_INFO": @{@"user_time": @{@"seconds": @(t.basic.user_time.seconds), @"microseconds": @(t.basic.user_time.microseconds)},
          @"system_time": @{@"seconds": @(t.basic.system_time.seconds), @"microseconds": @(t.basic.system_time.microseconds)},
          @"cpu_usage": @(t.basic.cpu_usage), @"policy": @(t.basic.policy), @"run_state": @(t.basic.run_state),
          @"flags": @(t.basic.flags), @"suspend_count": @(t.basic.suspend_count), @"sleep_time": @(t.basic.sleep_time)},
        @"THREAD_IDENTIFIER_INFO": @{@"thread_id": [NSString stringWithFormat:@"%llu", (unsigned long long)t.identifier.thread_id],
          @"thread_handle": [NSString stringWithFormat:@"%llu", (unsigned long long)t.identifier.thread_handle],
          @"dispatch_qaddr": [NSString stringWithFormat:@"%llu", (unsigned long long)t.identifier.dispatch_qaddr]}},
      @"queryStartedUptimeMs": @(t.startedMs), @"queryFinishedUptimeMs": @(t.finishedMs)}];
    for (const auto &error : reading.errors) [errors addObject:@{
      @"threadId": NSNull.null, @"reason": [NSString stringWithUTF8String:error.c_str()]}];
    NSDictionary *metadata = @{
      @"appVersion": NSBundle.mainBundle.infoDictionary[@"CFBundleShortVersionString"] ?: @"unknown",
      @"platform": @"ios", @"source": @"thread_info(THREAD_BASIC_INFO,THREAD_IDENTIFIER_INFO)",
      @"runStateSource": @"thread_info(THREAD_BASIC_INFO).run_state",
      @"runStateEnvironment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"counterUnit": @"microseconds", @"counterUnitsPerSecond": @1000000,
      @"clockSource": @"NSProcessInfo.systemUptime", @"queryStartedUptimeMs": @(before),
      @"queryFinishedUptimeMs": @(after), @"sampledAtMs": @(NSDate.date.timeIntervalSince1970 * 1000.0),
      @"processId": @(getpid()), @"sequence": @(++_cpuSequence),
      @"osVersion": UIDevice.currentDevice.systemVersion, @"enumeratedThreadCount": @(reading.enumerated)};
    auto log = [](NSDictionary *row) {
      NSMutableDictionary *compact = [row mutableCopy];
      if (row[@"thread"]) { NSMutableDictionary *thread = [row[@"thread"] mutableCopy]; [thread removeObjectForKey:@"sourceObservation"]; compact[@"thread"] = thread; }
      NSData *json = [NSJSONSerialization dataWithJSONObject:compact options:0 error:nil];
      if (json) NSLog(@"WfloatThreadCpu %@", [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding]);
    };
    for (NSDictionary *thread in threads) log(@{@"event": @"thread", @"processId": @(getpid()),
      @"sequence": @(_cpuSequence), @"thread": thread});
    for (NSDictionary *error in errors) log(@{@"event": @"error", @"processId": @(getpid()),
      @"sequence": @(_cpuSequence), @"error": error});
    NSMutableDictionary *header = [metadata mutableCopy];
    [header addEntriesFromDictionary:@{@"event": @"sample", @"readThreadCount": @(threads.count), @"errorCount": @(errors.count)}];
    log(header);
    NSMutableDictionary *row = [metadata mutableCopy];
    [row addEntriesFromDictionary:@{@"threads": threads, @"errors": errors}];
    row[@"captureSchema"] = @1;
    NSData *json = [NSJSONSerialization dataWithJSONObject:row options:0 error:nil];
    NSString *directory = [NSSearchPathForDirectoriesInDomains(NSDocumentDirectory, NSUserDomainMask, YES).firstObject stringByAppendingPathComponent:@"source-captures"];
    std::string status = json ? _capture.append(directory.UTF8String, std::string((const char *)json.bytes, json.length)) : "serialization_failed";
    row[@"capture"] = @{@"state": [NSString stringWithUTF8String:status.c_str()], @"path": [NSString stringWithUTF8String:_capture.filePath().c_str()]};
    resolve(row);
  } catch (const std::exception &error) {
    reject(@"THREAD_CPU_READ_FAILED", [NSString stringWithUTF8String:error.what()], nil);
  }
}
- (void)invalidate { _closed.store(true); [NSNotificationCenter.defaultCenter removeObserver:self]; }
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
@end
