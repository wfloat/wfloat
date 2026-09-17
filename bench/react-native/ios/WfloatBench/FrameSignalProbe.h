#pragma once
#import <QuartzCore/QuartzCore.h>
#import "PresentationSignalProbe.h"
// Main-run-loop callback timing, not per-frame GPU execution or presentation proof.
@interface BenchFrameSignalProbe : NSObject {
  CADisplayLink *_link;
  NSMutableDictionary *_state;
  NSUInteger _generation;
  BenchPresentationSignalProbe *_presentation;
}
- (void)start;
- (void)stop;
- (NSDictionary *)snapshot;
@end
@implementation BenchFrameSignalProbe
- (instancetype)init {if((self=[super init])){_state=[@{@"state":@"not_requested"} mutableCopy];_presentation=[BenchPresentationSignalProbe new];}return self;}
- (NSDictionary *)snapshot {@synchronized(self){NSMutableDictionary *copy=[NSJSONSerialization JSONObjectWithData:[NSJSONSerialization dataWithJSONObject:_state options:0 error:nil] options:NSJSONReadingMutableContainers error:nil];copy[@"presentationProbe"]=[_presentation snapshot];return copy;}}
- (void)finish:(NSString *)reason {
  if(!_link)return;[_link invalidate];_link=nil;++_generation;
  [_presentation stop:reason];
  @synchronized(self){_state[@"state"]=reason;_state[@"finishedAtMs"]=@(NSDate.date.timeIntervalSince1970*1000.);}
}
- (void)start {
  dispatch_async(dispatch_get_main_queue(),^{
    [self finish:@"replaced"];const NSUInteger token=++self->_generation;
    @synchronized(self){self->_state=[@{@"state":@"recording",@"startedAtMs":@(NSDate.date.timeIntervalSince1970*1000.),@"scope":@"main run loop display-link callbacks",@"frames":[NSMutableArray new]} mutableCopy];}
    self->_link=[CADisplayLink displayLinkWithTarget:self selector:@selector(frame:)];[self->_link addToRunLoop:NSRunLoop.mainRunLoop forMode:NSRunLoopCommonModes];
    [self->_presentation start];
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW,3*NSEC_PER_SEC),dispatch_get_main_queue(),^{if(self->_generation==token)[self finish:@"completed"];});
  });
}
- (void)frame:(CADisplayLink *)link {
  @synchronized(self){NSMutableArray *rows=_state[@"frames"];if(rows.count>=256){_state[@"frameLimitReached"]=@YES;return;}
    NSMutableDictionary *row=[@{@"timestampSeconds":@(link.timestamp),@"targetTimestampSeconds":@(link.targetTimestamp),@"durationSeconds":@(link.duration),@"callbackMediaTimeSeconds":@(CACurrentMediaTime()),@"preferredFramesPerSecond":@(link.preferredFramesPerSecond)} mutableCopy];
    if(@available(iOS 15.0,*)){const auto range=link.preferredFrameRateRange;row[@"preferredFrameRateRange"]=@{@"minimum":@(range.minimum),@"maximum":@(range.maximum),@"preferred":@(range.preferred)};}
    [rows addObject:row];
  }
}
- (void)stop {dispatch_async(dispatch_get_main_queue(),^{[self finish:@"cancelled"];});}
@end
