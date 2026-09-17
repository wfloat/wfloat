#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#include "../../cpp/FileFaultProbe.h"

@interface BenchFileFaultProbe : NSObject <RCTBridgeModule, RCTInvalidating> {
  bench::FileFaultProbe _probe;
  std::atomic<bool> _foreground, _closed, _busy;
  dispatch_queue_t _worker;
}
@end

@implementation BenchFileFaultProbe
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return YES; }
- (instancetype)init {
  if ((self = [super init])) {
    _worker = dispatch_queue_create("com.wfloat.bench.filefaultprobe", DISPATCH_QUEUE_SERIAL);
    _foreground.store(UIApplication.sharedApplication.applicationState == UIApplicationStateActive);
    _closed.store(false); _busy.store(false);
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(resumed:)
      name:UIApplicationDidBecomeActiveNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(paused:)
      name:UIApplicationWillResignActiveNotification object:nil];
  }
  return self;
}
- (void)resumed:(NSNotification *)notification { _foreground.store(true); }
- (void)paused:(NSNotification *)notification { _foreground.store(false); _probe.cancel(); }
RCT_EXPORT_METHOD(run:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  if (_busy.exchange(true)) { reject(@"FILE_PROBE_BUSY", @"A file probe is already running", nil); return; }
  const auto token = _probe.token();
  if (_closed.load() || !_foreground.load()) {
    _busy.store(false);
    reject(@"FILE_PROBE_PAUSED", @"The file probe requires the foreground app", nil); return;
  }
  NSString *directory = NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES).firstObject;
  if (!directory) {
    _busy.store(false); reject(@"FILE_PROBE_FAILED", @"App cache directory is unavailable", nil); return;
  }
  // Run on a separate queue so Stop can reach the native cancellation token.
  // The block retains this module until its file and mapping have been released.
  dispatch_async(_worker, ^{
    @try {
      try {
        if (self->_closed.load() || !self->_foreground.load()) self->_probe.cancel();
        const auto result = self->_probe.run(directory.fileSystemRepresentation, token);
        NSData *raw = [[NSString stringWithUTF8String:result.json().c_str()] dataUsingEncoding:NSUTF8StringEncoding];
        NSMutableDictionary *row = [NSJSONSerialization JSONObjectWithData:raw options:NSJSONReadingMutableContainers error:nil];
        row[@"osVersion"] = UIDevice.currentDevice.systemVersion;
        NSString *json = [[NSString alloc] initWithData:[NSJSONSerialization dataWithJSONObject:row options:0 error:nil] encoding:NSUTF8StringEncoding];
        // Unified logging truncates long string arguments. Number short chunks
        // so the original JSON can be recovered without losing the second pass.
        const NSUInteger chunkSize = 600;
        const NSUInteger parts = (json.length + chunkSize - 1) / chunkSize;
        for (NSUInteger part = 0; part < parts; ++part) {
          NSRange range = NSMakeRange(part * chunkSize, MIN(chunkSize, json.length - part * chunkSize));
          NSLog(@"WfloatFileFaultProbe pid=%d run=%llu part=%lu/%lu %@",
            getpid(), (unsigned long long)result.runSequence,
            (unsigned long)(part + 1), (unsigned long)parts, [json substringWithRange:range]);
        }
        resolve(json);
      } catch (const std::exception &error) {
        reject(@"FILE_PROBE_FAILED", [NSString stringWithUTF8String:error.what()], nil);
      }
    } @finally { self->_busy.store(false); }
  });
}
RCT_EXPORT_METHOD(cancel:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  _probe.cancel(); resolve(nil);
}
- (void)invalidate { _closed.store(true); _probe.cancel(); [NSNotificationCenter.defaultCenter removeObserver:self]; }
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
@end
