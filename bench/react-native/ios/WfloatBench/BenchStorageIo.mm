#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#include "../../cpp/StorageIo.h"

@interface BenchStorageIo : NSObject <RCTBridgeModule, RCTInvalidating> {
  bench::StorageIoCheck _check;
  std::atomic<bool> _foreground, _closed, _busy;
  dispatch_queue_t _collector, _worker;
}
@end
@implementation BenchStorageIo
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return YES; }
- (instancetype)init {
  if ((self = [super init])) {
    _collector = dispatch_queue_create("com.wfloat.bench.storageio", DISPATCH_QUEUE_SERIAL);
    _worker = dispatch_queue_create("com.wfloat.bench.storagecheck", DISPATCH_QUEUE_SERIAL);
    _foreground.store(UIApplication.sharedApplication.applicationState == UIApplicationStateActive);
    _closed.store(false); _busy.store(false);
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(resumed:) name:UIApplicationDidBecomeActiveNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(paused:) name:UIApplicationWillResignActiveNotification object:nil];
  }
  return self;
}
- (dispatch_queue_t)methodQueue { return _collector; }
- (void)resumed:(NSNotification *)notification { _foreground.store(true); }
- (void)paused:(NSNotification *)notification { _foreground.store(false); _check.cancel(); }
- (NSMutableDictionary *)decode:(const std::string &)text {
  NSData *data = [[NSString stringWithUTF8String:text.c_str()] dataUsingEncoding:NSUTF8StringEncoding];
  NSMutableDictionary *row = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:nil];
  if (!row) throw std::runtime_error("Invalid native storage JSON");
  row[@"osVersion"] = UIDevice.currentDevice.systemVersion;
  return row;
}
- (NSString *)encode:(NSDictionary *)row {
  NSData *data = [NSJSONSerialization dataWithJSONObject:row options:0 error:nil];
  if (!data) throw std::runtime_error("Could not serialize storage reading");
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}
RCT_EXPORT_METHOD(read:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  try {
    if (_closed.load() || !_foreground.load()) throw std::runtime_error("Storage sampling requires the foreground app");
    NSString *json = [self encode:[self decode:bench::storageIoSnapshot().json()]];
    if (_closed.load() || !_foreground.load()) throw std::runtime_error("Storage sampling was interrupted");
    NSLog(@"WfloatStorageIo %@", json); resolve(json);
  } catch (const std::exception &error) { reject(@"STORAGE_READ_FAILED", [NSString stringWithUTF8String:error.what()], nil); }
}
RCT_EXPORT_METHOD(run:(BOOL)reduceCaching resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (_busy.exchange(true)) { reject(@"STORAGE_BUSY", @"Storage check is already running", nil); return; }
  const auto token = _check.token();
  if (_closed.load() || !_foreground.load()) { _busy.store(false); reject(@"STORAGE_PAUSED", @"Storage check requires the foreground app", nil); return; }
  NSString *directory = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject;
  if (!directory) { _busy.store(false); reject(@"STORAGE_CHECK_FAILED", @"App cache directory is unavailable", nil); return; }
  dispatch_async(_worker, ^{
    @try {
      try {
        if (self->_closed.load() || !self->_foreground.load()) self->_check.cancel();
        const auto result = self->_check.run(directory.fileSystemRepresentation, token, reduceCaching);
        if (self->_closed.load() || !self->_foreground.load()) throw std::runtime_error("Storage check was interrupted");
        NSMutableDictionary *row = [self decode:result.json()];
        for (NSMutableDictionary *snapshot in row[@"snapshots"]) snapshot[@"osVersion"] = UIDevice.currentDevice.systemVersion;
        NSString *json = [self encode:row];
        const NSUInteger parts = (json.length + 599) / 600;
        for (NSUInteger part = 0; part < parts; ++part)
          NSLog(@"WfloatStorageCheck pid=%d run=%llu part=%lu/%lu %@", getpid(), (unsigned long long)result.runSequence,
            (unsigned long)(part + 1), (unsigned long)parts, [json substringWithRange:NSMakeRange(part * 600, MIN(600, json.length - part * 600))]);
        resolve(json);
      } catch (const std::exception &error) { reject(@"STORAGE_CHECK_FAILED", [NSString stringWithUTF8String:error.what()], nil); }
    } @finally { self->_busy.store(false); }
  });
}
RCT_EXPORT_METHOD(cancel:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) { _check.cancel(); resolve(nil); }
- (void)invalidate { _closed.store(true); _check.cancel(); [NSNotificationCenter.defaultCenter removeObserver:self]; }
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
@end
