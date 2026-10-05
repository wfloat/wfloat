// Small real-simulator AVFoundation harness. Lifecycle notifications below are synthetic;
// this does not establish physical-device background/interruption behavior.
#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>
#import <React/RCTLog.h>
#import "../WfloatNextAudio.h"
#include <cmath>
// Test executable does not link RN. Only its logging sink is replaced.
void _RCTLogNativeInternal(RCTLogLevel level, const char *file, int line, NSString *format, ...) {}
static void require(BOOL value, NSString *message) { if (!value) WFNextFail(message); }
@interface AudioTestApp : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong) UIWindow *window;
@property WfloatNextAudio *audio;
@property BOOL began;
@end
@implementation AudioTestApp
- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)options {
  self.window = [[UIWindow alloc] initWithFrame:UIScreen.mainScreen.bounds];
  self.window.rootViewController = [UIViewController new]; [self.window makeKeyAndVisible];
  self.audio = [WfloatNextAudio new]; return YES;
}
- (void)applicationDidBecomeActive:(UIApplication *)app {
  if (self.began) return; self.began = YES;
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    @try {
      NSMutableArray *events = [NSMutableArray new];
      WFNextEmit emit = ^(NSDictionary *e) { @synchronized (events) { [events addObject:e]; } };
      WFNextCancelled never = ^BOOL { return NO; };
      id (^run)(NSDictionary *) = ^id(NSDictionary *command) { return [self.audio perform:command emit:emit cancelled:never]; };
      NSString *path = [NSTemporaryDirectory() stringByAppendingPathComponent:@"audio sample.wav"];
      AVAudioFormat *format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:22050 channels:2 interleaved:NO];
      NSError *error = nil;
      AVAudioFile *file = [[AVAudioFile alloc] initForWriting:[NSURL fileURLWithPath:path] settings:format.settings error:&error];
      require(file != nil, error.localizedDescription);
      AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:100]; buffer.frameLength = 100;
      for (int i = 0; i < 100; i++) { buffer.floatChannelData[0][i] = 0.2f; buffer.floatChannelData[1][i] = 0.6f; }
      require([file writeFromBuffer:buffer error:&error], error.localizedDescription); file = nil;
      NSDictionary *decoded = run(@{@"op":@"decodeAudio", @"uri":[NSURL fileURLWithPath:path].absoluteString});
      require([decoded[@"samples"] count] == 100 && [decoded[@"sampleRate"] intValue] == 22050, @"Decode format mismatch");
      require(std::abs([decoded[@"samples"][0] floatValue] - 0.4f) < 0.001f, @"Stereo downmix mismatch");
      NSMutableArray *silence = [NSMutableArray new]; for (int i = 0; i < 16000; i++) [silence addObject:@0];
      require(run(@{@"op":@"playbackPrepare", @"playbackId":@"prepared", @"options":@{}}) == NSNull.null, @"Prepare did not return null");
      require([[self.audio valueForKey:@"players"] count] == 0, @"Prepare allocated an audio graph before PCM");
      require(run(@{@"op":@"playbackPause", @"playbackId":@"prepared"}) == NSNull.null, @"Prepared-only pause rejected");
      run(@{@"op":@"playbackPrepare", @"playbackId":@"prepared", @"options":@{}});
      require([[self.audio valueForKey:@"players"] count] == 0, @"Reprepare allocated an audio graph before PCM");
      run(@{@"op":@"playbackClose", @"playbackId":@"prepared"});
      @try {
        run(@{@"op":@"playbackPrepare", @"playbackId":@"no-capability", @"options":@{@"backgroundBehavior":@"continue"}});
        WFNextFail(@"Prepare accepted missing background capability");
      } @catch (NSException *e) { require([e.reason containsString:@"audio background capability"], e.reason); }
      // This harness deliberately has no audio background capability. Failed
      // starts still get closed by JS, including failures before allocation.
      @try {
        run(@{@"op":@"playbackStart", @"playbackId":@"no-capability", @"samples":silence, @"sampleRate":@16000,
              @"options":@{@"backgroundBehavior":@"continue"}});
        WFNextFail(@"Missing background capability was accepted");
      } @catch (NSException *e) { require([e.reason containsString:@"audio background capability"], e.reason); }
      require(run(@{@"op":@"playbackClose", @"playbackId":@"no-capability"}) == NSNull.null, @"Failed-start cleanup did not return null");
      run(@{@"op":@"playbackClose", @"playbackId":@"no-capability"});
      @try {
        run(@{@"op":@"playbackPosition", @"playbackId":@"no-capability"});
        WFNextFail(@"Unknown playback position was accepted");
      } @catch (NSException *e) { require([e.reason containsString:@"Unknown playbackId"], e.reason); }
      [NSNotificationCenter.defaultCenter postNotificationName:UIApplicationDidEnterBackgroundNotification object:nil];
      run(@{@"op":@"playbackStart", @"playbackId":@"play", @"samples":silence, @"sampleRate":@16000, @"offsetMs":@0,
            @"options":@{@"backgroundBehavior":@"pauseAndAutoResume"}});
      @synchronized (events) { require([events.lastObject[@"state"] isEqual:@"paused"], @"Background start did not report paused"); }
      [NSNotificationCenter.defaultCenter postNotificationName:UIApplicationWillEnterForegroundNotification object:nil];
      [NSThread sleepForTimeInterval:0.2];
      @synchronized (events) {
        BOOL resumed = NO, clock = NO;
        for (NSDictionary *event in events) {
          resumed |= [event[@"state"] isEqual:@"resumed"];
          clock |= [event[@"type"] isEqual:@"playbackPosition"] && [event[@"positionMs"] doubleValue] > 0;
        }
        require(resumed, @"Auto resume did not report resumed");
        require(clock, @"Native playback clock did not emit position events");
      }
      double pos = [run(@{@"op":@"playbackPosition", @"playbackId":@"play"}) doubleValue];
      require(pos > 0 && pos < 1000, @"Native playback clock did not advance");
      run(@{@"op":@"playbackPause", @"playbackId":@"play"});
      double paused = [run(@{@"op":@"playbackPosition", @"playbackId":@"play"}) doubleValue];
      __block NSUInteger pausedEventCount;
      @synchronized (events) { pausedEventCount = events.count; }
      [NSThread sleepForTimeInterval:0.15];
      @synchronized (events) { require(events.count == pausedEventCount, @"Paused playback kept emitting clock events"); }
      double later = [run(@{@"op":@"playbackPosition", @"playbackId":@"play"}) doubleValue];
      require(std::abs(paused-later) < 5, @"Paused playback clock advanced");
      run(@{@"op":@"playbackAppend", @"playbackId":@"play", @"samples":silence});
      run(@{@"op":@"playbackStart", @"playbackId":@"play", @"samples":@[], @"sampleRate":@16000, @"offsetMs":@(paused)});
      [NSThread sleepForTimeInterval:0.2];
      later = [run(@{@"op":@"playbackPosition", @"playbackId":@"play"}) doubleValue];
      require(later > paused && later < 2000, @"Explicit resume lost playback timeline");
      @try {
        run(@{@"op":@"playbackStart", @"playbackId":@"conflict", @"samples":silence, @"sampleRate":@16000, @"offsetMs":@0,
              @"options":@{@"audioFocus":@"mixWithOthers"}});
        WFNextFail(@"Conflicting audio focus silently changed existing playback");
      } @catch (NSException *e) { require([e.reason containsString:@"compatible audioFocus"], e.reason); }
      run(@{@"op":@"playbackClose", @"playbackId":@"conflict"});
      [NSThread sleepForTimeInterval:2.1];
      @synchronized (events) {
        NSDictionary *lastPosition = nil;
        for (NSDictionary *event in events) if ([event[@"type"] isEqual:@"playbackPosition"]) lastPosition = event;
        require(std::abs([lastPosition[@"positionMs"] doubleValue] - 2000) < 1, @"Final drain did not emit the absolute endpoint");
      }
      // An empty queue is not completion: direct speech may still synthesize.
      // Inspect the actual graph, since AVAudioSession has no public isActive.
      id player = [[self.audio valueForKey:@"players"] objectForKey:@"play"];
      AVAudioEngine *engine = [player valueForKey:@"engine"];
      require(engine.isRunning, @"Underrun stopped the render graph");
      @try {
        run(@{@"op":@"playbackStart", @"playbackId":@"gap-conflict", @"samples":silence, @"sampleRate":@16000,
              @"options":@{@"audioFocus":@"mixWithOthers"}});
        WFNextFail(@"Drained ongoing playback lost focus ownership");
      } @catch (NSException *e) { require([e.reason containsString:@"compatible audioFocus"], e.reason); }
      run(@{@"op":@"playbackClose", @"playbackId":@"gap-conflict"});
      [NSNotificationCenter.defaultCenter postNotificationName:UIApplicationDidEnterBackgroundNotification object:nil];
      run(@{@"op":@"playbackPosition", @"playbackId":@"play"}); // Fence queued notification.
      require(!engine.isRunning, @"Background pause did not release drained render graph");
      [NSNotificationCenter.defaultCenter postNotificationName:UIApplicationWillEnterForegroundNotification object:nil];
      run(@{@"op":@"playbackPosition", @"playbackId":@"play"});
      require(engine.isRunning, @"Auto resume did not restore drained render graph");
      run(@{@"op":@"playbackAppend", @"playbackId":@"play", @"samples":silence});
      [NSThread sleepForTimeInterval:0.2];
      later = [run(@{@"op":@"playbackPosition", @"playbackId":@"play"}) doubleValue];
      require(later > 2000 && later < 3000, @"Underrun append lost or skipped the PCM timeline");
      [NSThread sleepForTimeInterval:1.1];
      require(std::abs([run(@{@"op":@"playbackPosition", @"playbackId":@"play"}) doubleValue] - 3000) < 1, @"Underrun append endpoint mismatch");
      run(@{@"op":@"playbackClose", @"playbackId":@"play"});
      require(!engine.isRunning, @"Close did not stop drained render graph");
      run(@{@"op":@"playbackClose", @"playbackId":@"play"});
      NSArray *policies = @[@"interruptOthers", @"duckOthers", @"mixWithOthers"];
      NSMutableArray *longSilence = [NSMutableArray new];
      for (int i = 0; i < 4; i++) [longSilence addObjectsFromArray:silence];
      for (NSString *first in policies) for (NSString *second in policies) {
        run(@{@"op":@"playbackStart", @"playbackId":@"first", @"samples":longSilence, @"sampleRate":@16000,
              @"options":@{@"audioFocus":first}});
        id firstPlayer = [[self.audio valueForKey:@"players"] objectForKey:@"first"];
        AVAudioEngine *firstEngine = [firstPlayer valueForKey:@"engine"];
        AVAudioPlayerNode *firstNode = [firstPlayer valueForKey:@"node"];
        AVAudioSessionCategoryOptions before = AVAudioSession.sharedInstance.categoryOptions;
        run(@{@"op":@"playbackPrepare", @"playbackId":@"second", @"options":@{@"audioFocus":second}});
        require(AVAudioSession.sharedInstance.categoryOptions == before, @"Prepared handle changed active focus");
        if ([first isEqual:second]) {
          run(@{@"op":@"playbackStart", @"playbackId":@"second", @"samples":longSilence, @"sampleRate":@16000,
                @"options":@{@"audioFocus":second}});
        } else {
          @try {
            run(@{@"op":@"playbackStart", @"playbackId":@"second", @"samples":longSilence, @"sampleRate":@16000,
                  @"options":@{@"audioFocus":second}});
            WFNextFail(@"Incompatible overlapping playback accepted");
          } @catch (NSException *e) { require([e.reason containsString:@"compatible audioFocus"], e.reason); }
          require(firstEngine.isRunning && firstNode.isPlaying && ![[firstPlayer valueForKey:@"paused"] boolValue], @"Rejected start modified existing playback");
          require(AVAudioSession.sharedInstance.categoryOptions == before, @"Rejected start changed existing focus");
          run(@{@"op":@"playbackPause", @"playbackId":@"first"});
          run(@{@"op":@"playbackStart", @"playbackId":@"second", @"samples":longSilence, @"sampleRate":@16000,
                @"options":@{@"audioFocus":second}});
          id secondPlayer = [[self.audio valueForKey:@"players"] objectForKey:@"second"];
          AVAudioEngine *secondEngine = [secondPlayer valueForKey:@"engine"];
          AVAudioPlayerNode *secondNode = [secondPlayer valueForKey:@"node"];
          before = AVAudioSession.sharedInstance.categoryOptions;
          @try {
            run(@{@"op":@"playbackStart", @"playbackId":@"first", @"samples":@[], @"sampleRate":@16000});
            WFNextFail(@"Incompatible resume accepted");
          } @catch (NSException *e) { require([e.reason containsString:@"compatible audioFocus"], e.reason); }
          require([[firstPlayer valueForKey:@"paused"] boolValue], @"Rejected resume unpaused old playback");
          require(secondEngine.isRunning && secondNode.isPlaying, @"Rejected resume interrupted current playback");
          require(AVAudioSession.sharedInstance.categoryOptions == before, @"Rejected resume changed current focus");
        }
        run(@{@"op":@"playbackClose", @"playbackId":@"first"});
        run(@{@"op":@"playbackClose", @"playbackId":@"second"});
      }
      [self.audio invalidate];
      puts("PASS: real simulator file URI decode/downmix; native playback clock/pause/append/resume; synthetic background policy; all 6 directional focus conflicts and 3 compatible pairs; paused/prepared exclusion; rejected start/resume preserves current playback; idempotent close; underrun focus ownership and append timeline; prepare without graph"); fflush(stdout); exit(0);
    } @catch (NSException *e) { fprintf(stderr, "FAIL: %s\n", e.reason.UTF8String); fflush(stderr); exit(1); }
  });
}
@end
int main(int argc, char **argv) { @autoreleasepool { return UIApplicationMain(argc, argv, nil, NSStringFromClass(AudioTestApp.class)); } }
