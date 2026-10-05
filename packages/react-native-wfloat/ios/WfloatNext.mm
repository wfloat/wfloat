#import "WfloatNext.h"
#import "WfloatNextAssets.h"
#import "WfloatNextAudio.h"
#import <React/RCTInvalidating.h>
#include <wfloat-next/NextRuntime.h>
#include <atomic>
#include <memory>

@interface WFNextRequest : NSObject {
@public std::atomic<bool> cancelled;
}
@end
@implementation WFNextRequest
- (instancetype)init { if ((self = [super init])) cancelled.store(false); return self; }
@end

// Keep queued cancellation reachable while another download or model mutation owns a lock.
static void WFNextAcquire(id lock, WFNextRequest *token) {
  while (![lock tryLock]) {
    if (token->cancelled.load()) WFNextFail(@"Cancelled");
    [NSThread sleepForTimeInterval:0.01];
  }
}
@interface WfloatNext () <RCTInvalidating>
@end
@implementation WfloatNext {
  std::shared_ptr<wfloat_next::Runtime> _runtime;
  WfloatNextAssets *_assets;
  WfloatNextAudio *_audio;
  NSRecursiveLock *_assetLock;
  NSLock *_modelMutation;
  NSMutableDictionary<NSString *, NSArray *> *_modelPaths;
  NSMutableDictionary<NSString *, WFNextRequest *> *_requests;
  dispatch_queue_t _workers;
  dispatch_queue_t _routing;
  dispatch_queue_t _playbackWorkers;
  dispatch_queue_t _events;
  dispatch_group_t _running;
  BOOL _invalid;
}
RCT_EXPORT_MODULE(WfloatNext)
+ (BOOL)requiresMainQueueSetup { return YES; }
- (instancetype)init {
  if ((self = [super init])) {
    _runtime = std::make_shared<wfloat_next::Runtime>();
    _audio = [WfloatNextAudio new]; _assetLock = [WfloatNextAssets sharedLock]; _modelMutation = [NSLock new];
    _modelPaths = [NSMutableDictionary new]; _requests = [NSMutableDictionary new];
    _workers = dispatch_queue_create("com.wfloat.next.requests", DISPATCH_QUEUE_CONCURRENT);
    _routing = dispatch_queue_create("com.wfloat.next.routing", DISPATCH_QUEUE_SERIAL);
    _playbackWorkers = dispatch_queue_create("com.wfloat.next.playback-requests", DISPATCH_QUEUE_SERIAL);
    _events = dispatch_queue_create("com.wfloat.next.events", DISPATCH_QUEUE_SERIAL);
    _running = dispatch_group_create();
  }
  return self;
}
- (void)event:(NSString *)payload request:(NSString *)requestId {
  dispatch_async(_events, ^{
    @synchronized (self) { if (self->_invalid) return; }
    [self emitOnEvent:@{@"requestId":requestId, @"payload":payload}];
  });
}
- (void)request:(NSString *)requestId command:(NSString *)command resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  WFNextRequest *token = [WFNextRequest new];
  @synchronized (self) {
    if (_invalid || _requests[requestId]) { reject(@"wfloat_next", @"Module invalidated or requestId already active", nil); return; }
    _requests[requestId] = token;
    dispatch_group_enter(_running);
  }
  auto runtime = _runtime.get();
  __block id parsed = nil;
  dispatch_block_t work = ^{
    @autoreleasepool {
      @try {
        try {
          if (![parsed isKindOfClass:NSDictionary.class] || ![parsed[@"op"] isKindOfClass:NSString.class]) WFNextFail(@"Invalid request JSON command");
          NSDictionary *c = parsed; NSString *op = c[@"op"];
          if (token->cancelled.load()) WFNextFail(@"Cancelled");
          WFNextCancelled cancelled = ^BOOL { return token->cancelled.load(); };
          __weak WfloatNext *weakSelf = self;
          WFNextEmit emit = ^(NSDictionary *event) { [weakSelf event:WFNextJSON(event) request:requestId]; };
          NSString *result;
          if ([op hasPrefix:@"asset"] || [op isEqual:@"prepareEspeak"]) {
            WFNextAcquire(self->_assetLock, token);
            @try {
              if (!self->_assets) self->_assets = [WfloatNextAssets new];
              result = WFNextJSON([self->_assets perform:c emit:emit cancelled:cancelled]);
            } @finally { [self->_assetLock unlock]; }
          } else if ([op hasPrefix:@"mic"] || [op hasPrefix:@"playback"] || [op isEqual:@"decodeAudio"]) {
            result = WFNextJSON([self->_audio perform:c emit:emit cancelled:cancelled]);
          } else {
            BOOL mutation = [op isEqual:@"load"] || [op isEqual:@"unload"];
            NSString *instance = c[@"instanceId"];
            __block NSArray *pins = nil;
            if (mutation) WFNextAcquire(self->_modelMutation, token);
            @try {
              if ([op isEqual:@"load"]) {
                if (![instance isKindOfClass:NSString.class] || self->_modelPaths[instance]) WFNextFail(@"Invalid or already loaded instanceId");
                if (![c[@"paths"] isKindOfClass:NSDictionary.class]) WFNextFail(@"load requires asset paths");
                pins = [c[@"paths"] allValues];
                for (id path in pins) if (![path isKindOfClass:NSString.class] || ![path isAbsolutePath]) WFNextFail(@"Model paths must be absolute paths");
                WFNextAcquire(self->_assetLock, token);
                @try { if (!self->_assets) self->_assets = [WfloatNextAssets new]; [self->_assets pinPaths:pins]; }
                @finally { [self->_assetLock unlock]; }
              }
              try {
                std::string value = runtime->request(command.UTF8String,
                  [weakSelf, requestId](const std::string& payload) { [weakSelf event:[[NSString alloc] initWithBytes:payload.data() length:payload.size() encoding:NSUTF8StringEncoding] request:requestId]; },
                  [token]() { return token->cancelled.load(); });
                result = [[NSString alloc] initWithBytes:value.data() length:value.size() encoding:NSUTF8StringEncoding];
              } catch (...) {
                if (pins) { [self->_assetLock lock]; [self->_assets unpinPaths:pins]; [self->_assetLock unlock]; }
                throw;
              }
              if (pins) self->_modelPaths[instance] = pins;
              if ([op isEqual:@"unload"]) {
                [self->_assetLock lock]; [self->_assets unpinPaths:self->_modelPaths[instance] ?: @[]]; [self->_assetLock unlock];
                [self->_modelPaths removeObjectForKey:instance];
              }
            } @finally { if (mutation) [self->_modelMutation unlock]; }
          }
          dispatch_async(self->_events, ^{ @synchronized (self) { [self->_requests removeObjectForKey:requestId]; } resolve(result); });
        } catch (const std::exception& e) {
          NSString *message = @(e.what()); NSString *code = token->cancelled.load() ? @"cancelled" : @"wfloat_next";
          dispatch_async(self->_events, ^{ @synchronized (self) { [self->_requests removeObjectForKey:requestId]; } reject(code, message, nil); });
        }
      } @catch (NSException *e) {
        NSString *code = token->cancelled.load() ? @"cancelled" : @"wfloat_next";
        dispatch_async(self->_events, ^{ @synchronized (self) { [self->_requests removeObjectForKey:requestId]; } reject(code, e.reason ?: e.name, nil); });
      }
      @finally {
        dispatch_group_leave(self->_running);
      }
    }
  };
  // Parse off the JS thread in arrival order, then keep playback commands in
  // that order across handles (pause A/start B, or close A/start B). Inference
  // and microphone permission waits remain independently concurrent.
  dispatch_async(_routing, ^{
    @autoreleasepool {
      @try { parsed = [NSJSONSerialization JSONObjectWithData:[command dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil]; }
      @catch (NSException *e) { parsed = nil; }
      BOOL playback = [parsed isKindOfClass:NSDictionary.class] && [parsed[@"op"] isKindOfClass:NSString.class] && [parsed[@"op"] hasPrefix:@"playback"];
      dispatch_async(playback ? self->_playbackWorkers : self->_workers, work);
    }
  });
}
- (void)cancel:(NSString *)requestId { @synchronized (self) { WFNextRequest *r = _requests[requestId]; if (r) r->cancelled.store(true); } }
- (void)invalidate {
  @synchronized (self) {
    if (_invalid) return; _invalid = YES;
    for (WFNextRequest *r in _requests.allValues) r->cancelled.store(true);
  }
  [_audio invalidate];
  // Runtime destruction must follow every in-flight native worker, without blocking RN teardown.
  dispatch_group_notify(_running, _workers, ^{
    self->_runtime.reset();
    [self->_assetLock lock];
    for (NSArray *paths in self->_modelPaths.allValues) [self->_assets unpinPaths:paths];
    [self->_modelPaths removeAllObjects]; [self->_assetLock unlock];
  });
}
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:(const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeWfloatNextSpecJSI>(params);
}
@end
