#pragma once
#import <UIKit/UIKit.h>
static NSDictionary *displaySignalSources() {
  __block NSDictionary *result=nil;
  void (^read)(void)=^{
    NSMutableArray *rows=[NSMutableArray new];NSMutableSet<UIScreen *> *seen=[NSMutableSet new];
    for(UIScene *scene in UIApplication.sharedApplication.connectedScenes)if([scene isKindOfClass:UIWindowScene.class])[seen addObject:((UIWindowScene *)scene).screen];
    for(UIScreen *screen in seen){
      NSMutableArray *modes=[NSMutableArray new];for(UIScreenMode *m in screen.availableModes)[modes addObject:@{@"width":@(m.size.width),@"height":@(m.size.height),@"pixelAspectRatio":@(m.pixelAspectRatio)}];
      NSMutableDictionary *row=[@{@"boundsPoints":@[@(screen.bounds.size.width),@(screen.bounds.size.height)],@"nativePixels":@[@(screen.nativeBounds.size.width),@(screen.nativeBounds.size.height)],@"scale":@(screen.scale),@"nativeScale":@(screen.nativeScale),@"maximumFramesPerSecond":@(screen.maximumFramesPerSecond),@"brightness":@(screen.brightness),@"wantsSoftwareDimming":@(screen.wantsSoftwareDimming),@"captured":@(screen.isCaptured),@"availableModes":modes} mutableCopy];
      if(screen.currentMode)row[@"currentMode"]=@[@(screen.currentMode.size.width),@(screen.currentMode.size.height)];
      if(@available(iOS 16.0,*)){row[@"currentEDRHeadroom"]=@(screen.currentEDRHeadroom);row[@"potentialEDRHeadroom"]=@(screen.potentialEDRHeadroom);row[@"referenceDisplayModeStatus"]=@(screen.referenceDisplayModeStatus);}
      [rows addObject:row];
    }
    result=@{@"screens":rows,@"scope":@"screens attached to app window scenes; brightness is an OS level, not measured nits; maximum refresh is capability, not actual frame rate"};
  };
  if(NSThread.isMainThread)read();else dispatch_sync(dispatch_get_main_queue(),read);
  return result;
}
