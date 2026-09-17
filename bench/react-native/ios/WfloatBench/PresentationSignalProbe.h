#pragma once
#import <UIKit/UIKit.h>
#import <Metal/Metal.h>
#import <QuartzCore/CAMetalLayer.h>

// Simulator SDKs can omit these device declarations. Check the actual object
// before calling; absent selectors are recorded, never synthesized timestamps.
@protocol BenchPresentedDrawable <MTLDrawable>
@property(nonatomic,readonly) CFTimeInterval presentedTime;
@property(nonatomic,readonly) NSUInteger drawableID;
- (void)addPresentedHandler:(MTLDrawablePresentedHandler)handler;
@end

@interface BenchPresentationView : UIView
@end
@implementation BenchPresentationView
+ (Class)layerClass {return CAMetalLayer.class;}
@end

// One owned drawable; callbacks and presentedTime have distinct meanings.
@interface BenchPresentationSignalProbe : NSObject {
  CAMetalLayer *_layer;
  UIView *_view;
  NSMutableDictionary *_state;
  NSUInteger _generation;
  dispatch_queue_t _worker;
}
- (void)start;
- (void)stop:(NSString *)reason;
- (NSDictionary *)snapshot;
@end
@implementation BenchPresentationSignalProbe
- (instancetype)init {if((self=[super init])){_state=[@{@"state":@"not_requested"} mutableCopy];_worker=dispatch_queue_create("com.wfloat.presentation-probe",DISPATCH_QUEUE_SERIAL);}return self;}
- (NSDictionary *)snapshot {@synchronized(self){return [_state copy];}}
- (void)stop:(NSString *)reason {
  NSAssert(NSThread.isMainThread,@"main thread required");++_generation;
  [_view removeFromSuperview];_view=nil;_layer=nil;
  @synchronized(self){if([@[@"starting",@"submitted"] containsObject:_state[@"state"]]){_state[@"state"]=reason;_state[@"finishedMediaTimeSeconds"]=@(CACurrentMediaTime());}}
}
- (void)start {
  NSAssert(NSThread.isMainThread,@"main thread required");[self stop:@"replaced"];const NSUInteger token=++_generation;
  @synchronized(self){_state=[@{@"state":@"starting",@"startedMediaTimeSeconds":@(CACurrentMediaTime()),@"scope":@"Explicit owned Metal-backed UIView in the window safe area; native drawable dimensions retained. OS presentedTime in host seconds, distinct from callback time and command-buffer GPU time. Zero means not presented or dropped; no panel-photon or whole-app frame-rate claim."} mutableCopy];}
  UIWindow *window=nil;
  for(UIScene *scene in UIApplication.sharedApplication.connectedScenes)if(scene.activationState==UISceneActivationStateForegroundActive&&[scene isKindOfClass:UIWindowScene.class]){for(UIWindow *candidate in ((UIWindowScene *)scene).windows)if(candidate.isKeyWindow){window=candidate;break;}if(window)break;}
  id<MTLDevice> device=MTLCreateSystemDefaultDevice();
  if(!window||!device){[self stop:!window?@"no_foreground_window":@"no_metal_device"];return;}
  BenchPresentationView *view=[[BenchPresentationView alloc] initWithFrame:CGRectMake(window.safeAreaInsets.left+8,window.safeAreaInsets.top+8,32,32)];view.userInteractionEnabled=NO;view.opaque=YES;view.contentScaleFactor=window.screen.scale;
  CAMetalLayer *layer=(CAMetalLayer *)view.layer;layer.device=device;layer.pixelFormat=MTLPixelFormatBGRA8Unorm;layer.drawableSize=CGSizeMake(32*window.screen.scale,32*window.screen.scale);layer.opaque=YES;layer.framebufferOnly=YES;layer.allowsNextDrawableTimeout=YES;
  _view=view;_layer=layer;[window addSubview:view];[window bringSubviewToFront:view];[view layoutIfNeeded];
  @synchronized(self){_state[@"viewContext"]=@{@"windowHidden":@(window.hidden),@"windowAlpha":@(window.alpha),@"windowLevel":@(window.windowLevel),@"windowBounds":NSStringFromCGRect(window.bounds),@"viewFrame":NSStringFromCGRect(view.frame),@"drawableSize":NSStringFromCGSize(layer.drawableSize),@"attachedToWindow":@(view.window==window),@"layerClass":NSStringFromClass(layer.class),@"screenCaptured":@(window.screen.isCaptured),@"screenBrightness":@(window.screen.brightness)};}
  __weak BenchPresentationSignalProbe *weakSelf=self;
  // Allow the newly attached layer to reach the compositor before acquiring.
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,100*NSEC_PER_MSEC),_worker,^{
    @autoreleasepool {
      id<CAMetalDrawable> drawable=[layer nextDrawable];id<MTLCommandQueue> queue=[device newCommandQueue];id<MTLCommandBuffer> command=[queue commandBuffer];
      if(!drawable||!command){dispatch_async(dispatch_get_main_queue(),^{BenchPresentationSignalProbe *owner=weakSelf;if(owner&&owner->_generation==token)[owner stop:!drawable?@"drawable_unavailable":@"command_unavailable"];});return;}
      if(![drawable respondsToSelector:@selector(addPresentedHandler:)]||![drawable respondsToSelector:@selector(presentedTime)]||![drawable respondsToSelector:@selector(drawableID)]){dispatch_async(dispatch_get_main_queue(),^{BenchPresentationSignalProbe *owner=weakSelf;if(owner&&owner->_generation==token)[owner stop:@"presentation_selectors_unavailable"];});return;}
      MTLRenderPassDescriptor *pass=[MTLRenderPassDescriptor renderPassDescriptor];pass.colorAttachments[0].texture=drawable.texture;pass.colorAttachments[0].loadAction=MTLLoadActionClear;pass.colorAttachments[0].storeAction=MTLStoreActionStore;pass.colorAttachments[0].clearColor=MTLClearColorMake(0.12,0.35,0.29,1);
      id<MTLRenderCommandEncoder> encoder=[command renderCommandEncoderWithDescriptor:pass];
      if(!encoder){dispatch_async(dispatch_get_main_queue(),^{BenchPresentationSignalProbe *owner=weakSelf;if(owner&&owner->_generation==token)[owner stop:@"encoder_unavailable"];});return;}[encoder endEncoding];
      [(id<BenchPresentedDrawable>)drawable addPresentedHandler:^(id<MTLDrawable> native){
        id<BenchPresentedDrawable> presented=(id<BenchPresentedDrawable>)native;
        NSDictionary *record=@{@"drawableClass":NSStringFromClass([native class]),@"drawableId":[NSString stringWithFormat:@"%llu",(unsigned long long)presented.drawableID],@"presentedTimeSeconds":@(presented.presentedTime),@"callbackMediaTimeSeconds":@(CACurrentMediaTime())};
        dispatch_async(dispatch_get_main_queue(),^{BenchPresentationSignalProbe *owner=weakSelf;if(owner&&owner->_generation==token){
          @synchronized(owner){owner->_state[@"presentation"]=record;}
          // Apple permits retaining the drawable to query presentation properties.
          // Keep the view alive too, so cleanup cannot prevent a later presentation.
          dispatch_after(dispatch_time(DISPATCH_TIME_NOW,250*NSEC_PER_MSEC),dispatch_get_main_queue(),^{BenchPresentationSignalProbe *current=weakSelf;if(current&&current->_generation==token){double time=presented.presentedTime;@synchronized(current){current->_state[@"presentationAfterCallback"]=@{@"presentedTimeSeconds":@(time),@"readMediaTimeSeconds":@(CACurrentMediaTime())};}[current stop:time>0?@"completed":@"unpresented_or_dropped"];}});
        }});
      }];
      [command addCompletedHandler:^(id<MTLCommandBuffer> completed){
        NSDictionary *record=@{@"status":@(completed.status),@"error":completed.error?@{@"domain":completed.error.domain,@"code":@(completed.error.code)}:(id)NSNull.null,@"gpuStartTimeSeconds":@(completed.GPUStartTime),@"gpuEndTimeSeconds":@(completed.GPUEndTime),@"callbackMediaTimeSeconds":@(CACurrentMediaTime())};
        dispatch_async(dispatch_get_main_queue(),^{BenchPresentationSignalProbe *owner=weakSelf;if(owner&&(owner->_generation==token||(owner->_generation==token+1&&[@[@"completed",@"unpresented_or_dropped"] containsObject:owner->_state[@"state"]]))){@synchronized(owner){owner->_state[@"commandCompletion"]=record;}if(owner->_generation==token&&completed.status==MTLCommandBufferStatusError)[owner stop:@"command_failed"];}});
      }];
      // Commit on main only if this generation still owns the layer.
      dispatch_async(dispatch_get_main_queue(),^{BenchPresentationSignalProbe *owner=weakSelf;if(owner&&owner->_generation==token){@synchronized(owner){owner->_state[@"state"]=@"submitted";owner->_state[@"submitMediaTimeSeconds"]=@(CACurrentMediaTime());}[command presentDrawable:drawable];[command commit];}});
    }
  });
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW,3*NSEC_PER_SEC),dispatch_get_main_queue(),^{BenchPresentationSignalProbe *owner=weakSelf;if(owner&&owner->_generation==token)[owner stop:@"timed_out"];});
}
@end
