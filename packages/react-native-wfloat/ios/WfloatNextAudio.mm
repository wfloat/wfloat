#import "WfloatNextAudio.h"
#import <AVFoundation/AVFoundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTLog.h>
#include <cmath>
#include <atomic>
#include <memory>

static NSString *Policy(NSDictionary *options) {
  NSString *policy = options[@"backgroundBehavior"] ?: @"pauseUntilResumed";
  if (![@[@"continue", @"pauseAndAutoResume", @"pauseUntilResumed"] containsObject:policy]) WFNextFail(@"Invalid backgroundBehavior");
  if ([policy isEqual:@"continue"] && ![[NSBundle.mainBundle objectForInfoDictionaryKey:@"UIBackgroundModes"] containsObject:@"audio"])
    WFNextFail(@"backgroundBehavior continue requires the host app's audio background capability");
  return policy;
}
static NSString *Focus(NSDictionary *options) {
  NSString *focus = options[@"audioFocus"] ?: @"interruptOthers";
  if (![@[@"interruptOthers", @"duckOthers", @"mixWithOthers"] containsObject:focus]) WFNextFail(@"Invalid audioFocus");
  return focus;
}
static AVAudioPCMBuffer *PCM(NSArray *samples, double rate) {
  if (!std::isfinite(rate) || rate < 8000 || rate > 192000 || ![samples isKindOfClass:NSArray.class] || samples.count > UINT32_MAX)
    WFNextFail(@"Invalid PCM samples or sample rate");
  AVAudioFormat *format = [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32 sampleRate:rate channels:1 interleaved:NO];
  AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:(AVAudioFrameCount)MAX(1, samples.count)];
  buffer.frameLength = (AVAudioFrameCount)samples.count;
  for (NSUInteger i = 0; i < samples.count; i++) {
    if (![samples[i] isKindOfClass:NSNumber.class] || !std::isfinite([samples[i] doubleValue])) WFNextFail(@"PCM contains a nonfinite or nonnumeric sample");
    buffer.floatChannelData[0][i] = [samples[i] floatValue];
  }
  return buffer;
}

@interface WFNextPlayback : NSObject
@property AVAudioEngine *engine;
@property AVAudioPlayerNode *node;
@property NSString *policy;
@property NSString *focus;
@property(copy) WFNextEmit emit;
@property double rate;
@property double offset;
@property double stoppedPosition;
@property uint64_t scheduled;
@property NSUInteger pending;
@property BOOL paused;
@property BOOL interrupted;
@property BOOL drained;
@property BOOL failed;
@property BOOL started;
@property dispatch_source_t positionTimer;
@end
@implementation WFNextPlayback
@end

@implementation WfloatNextAudio {
  dispatch_queue_t _queue;
  NSMutableDictionary<NSString *, WFNextPlayback *> *_players;
  NSMutableSet<NSString *> *_terminalCaptures;
  NSMutableArray *_observers;
  AVAudioEngine *_capture;
  NSString *_captureId;
  NSDictionary *_captureOptions;
  NSString *_capturePolicy;
  WFNextEmit _captureEmit;
  BOOL _capturePaused, _captureInterrupted, _background, _invalid;
  NSUInteger _captureEpoch;
  uint64_t _sequence, _retainedSamples;
  NSMutableArray<NSDictionary *> *_retained;
  NSString *_retainedCaptureId;
  NSLock *_retentionLock;
  BOOL _accepting, _tapInstalled;
}
- (instancetype)init {
  if ((self = [super init])) {
    _queue = dispatch_queue_create("com.wfloat.next.audio", DISPATCH_QUEUE_SERIAL);
    _retentionLock = [NSLock new]; _retained = [NSMutableArray new]; _players = [NSMutableDictionary new]; _terminalCaptures = [NSMutableSet new]; _observers = [NSMutableArray new];
    _background = UIApplication.sharedApplication.applicationState == UIApplicationStateBackground;
    __weak WfloatNextAudio *weakSelf = self;
    for (NSString *name in @[UIApplicationDidEnterBackgroundNotification, UIApplicationWillEnterForegroundNotification,
                            AVAudioSessionInterruptionNotification, AVAudioSessionRouteChangeNotification,
                            AVAudioSessionMediaServicesWereResetNotification, AVAudioEngineConfigurationChangeNotification]) {
      id observer = [NSNotificationCenter.defaultCenter addObserverForName:name object:nil queue:nil usingBlock:^(NSNotification *n) {
        WfloatNextAudio *owner = weakSelf;
        if (owner) dispatch_async(owner->_queue, ^{ [owner notification:n]; });
      }];
      [_observers addObject:observer];
    }
  }
  return self;
}
- (NSDictionary *)eventFromPacket:(NSDictionary *)packet {
  NSData *pcm = packet[@"pcm"]; const float *values = (const float *)pcm.bytes;
  NSMutableArray *samples = [NSMutableArray arrayWithCapacity:pcm.length / sizeof(float)];
  for (NSUInteger i = 0; i < pcm.length / sizeof(float); i++) [samples addObject:@(values[i])];
  return @{@"type":@"audio", @"samples":samples, @"sampleRate":packet[@"sampleRate"], @"sequence":packet[@"sequence"]};
}
- (NSArray *)retainedAfter:(uint64_t)sequence {
  [_retentionLock lock]; NSArray *packets = [_retained copy]; [_retentionLock unlock];
  NSMutableArray *events = [NSMutableArray new];
  for (NSDictionary *p in packets) if ([p[@"sequence"] unsignedLongLongValue] > sequence) [events addObject:[self eventFromPacket:p]];
  return events;
}
- (void)warning:(NSString *)message {
  RCTLogWarn(@"%@", message);
  if (_captureEmit) _captureEmit(@{@"type":@"warning", @"message":message});
}
- (void)state:(NSString *)state { if (_captureEmit) _captureEmit(@{@"type":@"captureState", @"state":state}); }
- (void)sessionForCapture:(BOOL)record extraPlayer:(WFNextPlayback *)extra {
  NSString *focus = extra.focus;
  for (WFNextPlayback *p in _players.allValues) if (p.started && !p.paused && !p.failed && p != extra) {
    if (focus && ![focus isEqual:p.focus]) WFNextFail(@"Simultaneous playback requires compatible audioFocus options");
    focus = p.focus;
  }
  AVAudioSession *session = AVAudioSession.sharedInstance;
  if (!record && !focus) {
    NSError *error = nil;
    if (![session setActive:NO withOptions:AVAudioSessionSetActiveOptionNotifyOthersOnDeactivation error:&error])
      RCTLogWarn(@"WfloatNext could not release audio session: %@", error.localizedDescription);
    return;
  }
  BOOL duplex = record || (_captureId && focus);
  AVAudioSessionCategoryOptions options = duplex ? AVAudioSessionCategoryOptionDefaultToSpeaker | AVAudioSessionCategoryOptionAllowBluetooth : 0;
  if ([focus isEqual:@"mixWithOthers"]) options |= AVAudioSessionCategoryOptionMixWithOthers;
  if ([focus isEqual:@"duckOthers"]) options |= AVAudioSessionCategoryOptionDuckOthers | AVAudioSessionCategoryOptionInterruptSpokenAudioAndMixWithOthers;
  NSError *error = nil;
  NSString *category = duplex ? AVAudioSessionCategoryPlayAndRecord : AVAudioSessionCategoryPlayback;
  NSString *mode = (duplex && _capture.inputNode.voiceProcessingEnabled) ? AVAudioSessionModeVoiceChat : AVAudioSessionModeDefault;
  BOOL changed = ![session.category isEqual:category] || ![session.mode isEqual:mode] || session.categoryOptions != options;
  if ((changed && ![session setCategory:category mode:mode options:options error:&error]) || ![session setActive:YES error:&error])
    WFNextFail(error.localizedDescription ?: @"Cannot acquire audio session");
}
- (void)refreshSession { [self sessionForCapture:_capture && !_capturePaused extraPlayer:nil]; }
- (void)pauseCapture {
  BOOL active = _capture && !_capturePaused;
  if (_tapInstalled) { [_capture.inputNode removeTapOnBus:0]; _tapInstalled = NO; }
  [_capture stop];
  [_retentionLock lock]; _accepting = NO; [_retentionLock unlock];
  _capturePaused = YES; if (active) [self state:@"paused"];
}
- (void)failCapture:(NSString *)message {
  [self pauseCapture];
  if (_captureEmit) _captureEmit(@{@"type":@"captureState", @"state":@"failed", @"message":message ?: @"Microphone failed"});
  if (_captureEmit) _captureEmit(@{@"type":@"error", @"message":message ?: @"Microphone failed"});
  if (_captureId) [_terminalCaptures addObject:_captureId];
  _capture = nil; _captureId = nil; _captureEmit = nil;
}
- (void)startCapture {
  [self state:@"starting"];
  if (_background && ![_capturePolicy isEqual:@"continue"]) { _capturePaused = YES; [self state:@"paused"]; return; }
  [self sessionForCapture:YES extraPlayer:nil];
  // Recreate on resume so hardware rate/channel changes are reflected in the tap.
  _capture = [AVAudioEngine new];
  AVAudioInputNode *input = _capture.inputNode;
  if ([_captureOptions[@"voiceProcessing"] boolValue]) {
    NSError *voiceError = nil;
    if (@available(iOS 13.0, *)) {
      if (![input setVoiceProcessingEnabled:YES error:&voiceError]) {
        // Only unsupported/unimplemented AudioUnit errors permit the approved fallback.
        if ([voiceError.domain isEqual:NSOSStatusErrorDomain] && (voiceError.code == kAudioUnitErr_InvalidProperty || voiceError.code == -4 /* unimpErr */))
          [self warning:[@"WfloatNext voiceProcessing is unsupported; recording without it: " stringByAppendingString:voiceError.localizedDescription]];
        else WFNextFail(voiceError.localizedDescription ?: @"Cannot enable microphone voice processing");
      }
    } else [self warning:@"WfloatNext voiceProcessing is unsupported on this iOS version; recording without it"];
  }
  AVAudioFormat *format = [input outputFormatForBus:0];
  if (format.sampleRate <= 0 || format.channelCount == 0 || format.commonFormat != AVAudioPCMFormatFloat32)
    WFNextFail(@"Microphone has no supported float PCM input route");
  [_retentionLock lock]; NSUInteger epoch = ++_captureEpoch; _accepting = YES; [_retentionLock unlock];
  auto warned = std::make_shared<std::atomic<bool>>(false);
  WFNextEmit captureEmit = [_captureEmit copy];
  __weak WfloatNextAudio *weakSelf = self;
  [input installTapOnBus:0 bufferSize:2048 format:format block:^(AVAudioPCMBuffer *buffer, AVAudioTime *time) {
    WfloatNextAudio *owner = weakSelf; if (!owner) return;
    NSMutableData *mono = [NSMutableData dataWithLength:buffer.frameLength * sizeof(float)];
    float *out = (float *)mono.mutableBytes;
    for (AVAudioFrameCount i = 0; i < buffer.frameLength; i++) {
      float sum = 0;
      for (AVAudioChannelCount c = 0; c < buffer.format.channelCount; c++)
        sum += buffer.format.interleaved ? buffer.floatChannelData[0][i * buffer.format.channelCount + c] : buffer.floatChannelData[c][i];
      out[i] = sum / buffer.format.channelCount;
    }
    double rate = buffer.format.sampleRate;
    [owner->_retentionLock lock];
    if (!owner->_accepting || owner->_captureEpoch != epoch) { [owner->_retentionLock unlock]; return; }
    // No implicit capture limit: the caller's session buffering policy owns limits.
    // Warn without pausing or dropping frames when JS acknowledgement falls behind.
    if (owner->_retainedSamples + buffer.frameLength > (uint64_t)(rate * 60) && !warned->exchange(true)) {
      dispatch_async(owner->_queue, ^{
        if (!owner->_invalid && owner->_captureEpoch == epoch)
          [owner warning:@"Microphone delivery is falling behind: more than a minute of audio awaits JS acknowledgement; retained audio increases memory use"];
      });
    }
    NSDictionary *packet = @{@"pcm":mono, @"sampleRate":@(rate), @"sequence":@(++owner->_sequence)};
    [owner->_retained addObject:packet]; owner->_retainedSamples += buffer.frameLength;
    [owner->_retentionLock unlock];
    dispatch_async(owner->_queue, ^{
      if (!owner->_invalid) captureEmit([owner eventFromPacket:packet]);
    });
  }];
  _tapInstalled = YES;
  NSError *error = nil;
  if (![_capture startAndReturnError:&error]) WFNextFail(error.localizedDescription);
  _capturePaused = NO; _captureInterrupted = NO; [self state:@"recording"];
}
- (double)position:(WFNextPlayback *)p {
  if (p.drained) return p.offset + 1000.0 * p.scheduled / p.rate;
  AVAudioTime *time = p.node.lastRenderTime;
  AVAudioTime *player = time ? [p.node playerTimeForNodeTime:time] : nil;
  if (player && player.sampleTime >= 0) p.stoppedPosition = p.offset + MIN((double)p.scheduled, (double)player.sampleTime) * 1000 / p.rate;
  return p.stoppedPosition;
}
- (void)stopPositionClock:(WFNextPlayback *)p {
  if (p.positionTimer) { dispatch_source_cancel(p.positionTimer); p.positionTimer = nil; }
}
- (void)emitPosition:(WFNextPlayback *)p {
  p.emit(@{@"type":@"playbackPosition", @"positionMs":@([self position:p])});
}
- (void)startPositionClock:(WFNextPlayback *)p {
  [self stopPositionClock:p];
  if (p.paused || p.drained || p.failed || _invalid) return;
  dispatch_source_t timer = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, _queue);
  p.positionTimer = timer;
  __weak WfloatNextAudio *weakSelf = self;
  __weak WFNextPlayback *weakPlayer = p;
  dispatch_source_set_timer(timer, dispatch_time(DISPATCH_TIME_NOW, 50 * NSEC_PER_MSEC), 50 * NSEC_PER_MSEC, 5 * NSEC_PER_MSEC);
  dispatch_source_set_event_handler(timer, ^{
    WfloatNextAudio *owner = weakSelf; WFNextPlayback *player = weakPlayer;
    if (!owner || !player || owner->_invalid || player.paused || player.drained || player.failed || ![owner->_players.allValues containsObject:player]) return;
    [owner emitPosition:player];
  });
  dispatch_resume(timer);
}
- (void)pausePlayer:(WFNextPlayback *)p notify:(BOOL)notify {
  [self stopPositionClock:p];
  if (p.paused) return;
  [self position:p]; [p.node pause]; [p.engine pause]; p.paused = YES;
  if (notify) p.emit(@{@"type":@"playbackState", @"state":@"paused"});
}
- (void)failPlayer:(WFNextPlayback *)p message:(NSString *)message {
  [self pausePlayer:p notify:NO]; p.failed = YES; p.interrupted = YES;
  p.emit(@{@"type":@"playbackState", @"state":@"failed", @"message":message ?: @"Playback failed"});
}
- (void)append:(NSArray *)samples player:(WFNextPlayback *)p {
  if (p.failed) WFNextFail(@"Playback has terminally failed");
  AVAudioPCMBuffer *buffer = PCM(samples, p.rate); if (!buffer.frameLength) return;
  BOOL restart = p.drained;
  p.drained = NO; p.scheduled += buffer.frameLength; p.pending++;
  __weak WfloatNextAudio *weakSelf = self;
  __weak WFNextPlayback *weakPlayer = p;
  [p.node scheduleBuffer:buffer completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack completionHandler:^(AVAudioPlayerNodeCompletionCallbackType type) {
    WfloatNextAudio *owner = weakSelf; WFNextPlayback *player = weakPlayer;
    if (!owner || !player) return;
    dispatch_async(owner->_queue, ^{
      if (owner->_invalid || ![owner->_players.allValues containsObject:player]) return;
      if (player.pending) player.pending--;
      if (!player.pending) {
        player.stoppedPosition = player.offset + 1000.0 * player.scheduled / player.rate;
        player.drained = YES; [owner stopPositionClock:player];
        // Freeze the PCM clock while keeping the render graph and session alive
        // for background synthesis. Only JS knows whether this drain is final.
        [player.node pause]; [owner emitPosition:player];
      }
    });
  }];
  if (restart && !p.paused) {
    [self sessionForCapture:_capture && !_capturePaused extraPlayer:p];
    NSError *error = nil; if (![p.engine startAndReturnError:&error]) WFNextFail(error.localizedDescription); [p.node play];
    p.started = YES;
    [self startPositionClock:p];
  }
}
- (void)notification:(NSNotification *)n {
  if (_invalid) return;
  @try {
    if ([n.name isEqual:UIApplicationDidEnterBackgroundNotification]) {
      _background = YES;
      if (![_capturePolicy isEqual:@"continue"]) [self pauseCapture];
      for (WFNextPlayback *p in _players.allValues) if (![p.policy isEqual:@"continue"]) [self pausePlayer:p notify:YES];
    } else if ([n.name isEqual:UIApplicationWillEnterForegroundNotification]) {
      _background = NO;
      if (_captureId && _capturePaused && !_captureInterrupted && [_capturePolicy isEqual:@"pauseAndAutoResume"]) {
        @try { [self startCapture]; } @catch (NSException *e) { [self failCapture:e.reason]; }
      }
      for (WFNextPlayback *p in _players.allValues) if (p.paused && !p.interrupted && [p.policy isEqual:@"pauseAndAutoResume"]) {
        @try {
          if (!p.drained || p.started) { [self sessionForCapture:_capture && !_capturePaused extraPlayer:p]; NSError *error = nil;
            if (![p.engine startAndReturnError:&error]) WFNextFail(error.localizedDescription);
            p.started = YES; if (!p.drained) [p.node play]; }
          p.paused = NO; [self startPositionClock:p]; p.emit(@{@"type":@"playbackState", @"state":@"resumed"});
        } @catch (NSException *e) { [self failPlayer:p message:e.reason]; }
      }
    } else if ([n.name isEqual:AVAudioSessionMediaServicesWereResetNotification]) {
      if (_captureId) [self failCapture:@"Audio media services were reset"];
      for (WFNextPlayback *p in _players.allValues) [self failPlayer:p message:@"Audio media services were reset"];
    } else {
      BOOL interruption = [n.name isEqual:AVAudioSessionInterruptionNotification] && [n.userInfo[AVAudioSessionInterruptionTypeKey] unsignedIntegerValue] == AVAudioSessionInterruptionTypeBegan;
      BOOL unplug = [n.name isEqual:AVAudioSessionRouteChangeNotification] && [n.userInfo[AVAudioSessionRouteChangeReasonKey] unsignedIntegerValue] == AVAudioSessionRouteChangeReasonOldDeviceUnavailable;
      BOOL captureReconfigured = [n.name isEqual:AVAudioEngineConfigurationChangeNotification] && n.object == _capture && !_capture.isRunning && !_capturePaused;
      if (interruption || unplug || captureReconfigured) { _captureInterrupted = YES; [self pauseCapture]; }
      for (WFNextPlayback *p in _players.allValues) if (interruption || unplug || ([n.name isEqual:AVAudioEngineConfigurationChangeNotification] && n.object == p.engine && !p.engine.isRunning && !p.paused)) {
        p.interrupted = YES; [self pausePlayer:p notify:YES];
      }
    }
    [self refreshSession];
  } @catch (NSException *e) { RCTLogWarn(@"WfloatNext audio lifecycle: %@", e.reason); }
}
- (id)decode:(NSDictionary *)c cancelled:(WFNextCancelled)cancelled {
  NSString *uri = c[@"uri"]; NSURL *url = [NSURL URLWithString:uri ?: @""];
  if (!url.isFileURL) WFNextFail(@"decodeAudio requires an accessible file:// URI; remote fetching is app-owned");
  BOOL scoped = [url startAccessingSecurityScopedResource];
  @try {
    NSError *error = nil;
    AVAudioFile *file = [[AVAudioFile alloc] initForReading:url commonFormat:AVAudioPCMFormatFloat32 interleaved:NO error:&error];
    if (!file) WFNextFail(error.localizedDescription);
    AVAudioFormat *format = file.processingFormat;
    AVAudioPCMBuffer *buffer = [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:8192];
    NSMutableArray *samples = [NSMutableArray new];
    while (file.framePosition < file.length) {
      if (cancelled()) WFNextFail(@"Cancelled");
      if (![file readIntoBuffer:buffer error:&error]) WFNextFail(error.localizedDescription);
      if (!buffer.frameLength) break;
      for (AVAudioFrameCount i = 0; i < buffer.frameLength; i++) {
        float sample = 0; for (AVAudioChannelCount ch = 0; ch < format.channelCount; ch++) sample += buffer.floatChannelData[ch][i];
        [samples addObject:@(sample / format.channelCount)];
      }
    }
    return @{@"samples":samples, @"sampleRate":@(format.sampleRate)};
  } @finally { if (scoped) [url stopAccessingSecurityScopedResource]; }
}
- (id)perform:(NSDictionary *)c emit:(WFNextEmit)emit cancelled:(WFNextCancelled)cancelled {
  NSString *op = c[@"op"];
  if ([op isEqual:@"decodeAudio"]) return [self decode:c cancelled:cancelled];
  if ([op isEqual:@"micStart"]) {
    __block NSException *preflight = nil;
    dispatch_sync(_queue, ^{
      @try {
        NSString *cid = c[@"captureId"];
        if (self->_invalid || cancelled()) WFNextFail(@"Cancelled");
        if (![cid isKindOfClass:NSString.class] || !cid.length) WFNextFail(@"captureId is required");
        if ([self->_terminalCaptures containsObject:cid]) WFNextFail(@"Capture has terminally stopped");
        if (self->_captureId && ![self->_captureId isEqual:cid]) WFNextFail(@"A shared microphone capture is already allocated");
        if (!self->_captureId) {
          self->_captureId = cid; self->_captureOptions = c[@"options"] ?: @{}; self->_captureEmit = [emit copy]; self->_capturePaused = YES; self->_captureInterrupted = NO;
          [self->_retentionLock lock];
          self->_retainedCaptureId = cid; self->_sequence = 0; self->_retainedSamples = 0; [self->_retained removeAllObjects];
          [self->_retentionLock unlock];
        }
        [self state:@"starting"];
      } @catch (NSException *e) { preflight = e; }
    });
    if (preflight) @throw preflight;
    @try {
      if (![NSBundle.mainBundle objectForInfoDictionaryKey:@"NSMicrophoneUsageDescription"]) WFNextFail(@"Host app must supply NSMicrophoneUsageDescription");
      dispatch_semaphore_t permission = dispatch_semaphore_create(0);
      __block BOOL granted = NO;
      [AVAudioSession.sharedInstance requestRecordPermission:^(BOOL allowed) { granted = allowed; dispatch_semaphore_signal(permission); }];
      while (dispatch_semaphore_wait(permission, dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC))) {
        if (cancelled()) WFNextFail(@"Cancelled");
        __block BOOL stopped = NO;
        dispatch_sync(_queue, ^{ stopped = self->_invalid || [self->_terminalCaptures containsObject:c[@"captureId"]]; });
        if (stopped) WFNextFail(@"Capture stopped during permission request");
      }
      if (!granted) WFNextFail(@"Microphone permission denied");
    } @catch (NSException *e) {
      dispatch_sync(_queue, ^{
        if ([self->_captureId isEqual:c[@"captureId"]]) [self failCapture:e.reason];
      });
      @throw;
    }
  }
  __block id result = NSNull.null; __block NSException *failure = nil;
  dispatch_sync(_queue, ^{
    @try {
      if (self->_invalid || cancelled()) WFNextFail(@"Cancelled");
      NSString *cid = c[@"captureId"], *pid = c[@"playbackId"];
      if ([op hasPrefix:@"mic"] && (![cid isKindOfClass:NSString.class] || !cid.length)) WFNextFail(@"captureId is required");
      if ([op hasPrefix:@"playback"] && (![pid isKindOfClass:NSString.class] || !pid.length)) WFNextFail(@"playbackId is required");
      if ([op isEqual:@"micStart"]) {
        if ([self->_terminalCaptures containsObject:cid]) WFNextFail(@"Capture has terminally stopped");
        if (self->_captureId && ![self->_captureId isEqual:cid]) WFNextFail(@"A shared microphone capture is already allocated");
        BOOL initial = !self->_captureId;
        if (initial) {
          self->_captureId = cid; self->_captureOptions = c[@"options"] ?: @{}; self->_captureEmit = [emit copy]; self->_capturePaused = YES; self->_captureInterrupted = NO;
        }
        @try {
          self->_capturePolicy = Policy(self->_captureOptions);
          if (self->_capturePaused) [self startCapture];
          result = @{@"state": self->_capturePaused ? @"paused" : @"recording"};
        } @catch (NSException *e) { [self failCapture:e.reason]; [self refreshSession]; @throw; }
      } else if ([op isEqual:@"micStop"]) {
        if ([self->_terminalCaptures containsObject:cid]) { result = [self->_retainedCaptureId isEqual:cid] ? [self retainedAfter:0] : @[]; return; }
        // Also fence a start that has been dispatched but has not reserved capture yet.
        [self->_terminalCaptures addObject:cid];
        if (!self->_captureId) { result = @[]; return; }
        if (![self->_captureId isEqual:cid]) WFNextFail(@"Unknown captureId");
        [self pauseCapture]; result = [self retainedAfter:0]; [self state:@"stopped"]; [self->_terminalCaptures addObject:cid];
        self->_capture = nil; self->_captureId = nil; self->_captureEmit = nil; [self refreshSession];
      } else if ([op isEqual:@"micAck"] || [op isEqual:@"micDrain"]) {
        if (![self->_captureId isEqual:cid] && ![self->_terminalCaptures containsObject:cid]) WFNextFail(@"Unknown captureId");
        if (![self->_retainedCaptureId isEqual:cid]) { result = [op isEqual:@"micDrain"] ? (id)@[] : (id)NSNull.null; return; }
        uint64_t sequence = [c[[op isEqual:@"micAck"] ? @"sequence" : @"afterSequence"] unsignedLongLongValue];
        [self->_retentionLock lock]; uint64_t captured = self->_sequence; [self->_retentionLock unlock];
        if (sequence > captured) WFNextFail(@"Microphone sequence exceeds captured frames");
        if ([op isEqual:@"micAck"]) {
          [self->_retentionLock lock];
          while (self->_retained.count && [self->_retained.firstObject[@"sequence"] unsignedLongLongValue] <= sequence) {
            self->_retainedSamples -= [self->_retained.firstObject[@"pcm"] length] / sizeof(float); [self->_retained removeObjectAtIndex:0];
          }
          [self->_retentionLock unlock];
        } else {
          result = [self retainedAfter:sequence];
        }
      } else if ([op isEqual:@"playbackPrepare"]) {
        // iOS can validate capability before synthesis, but audio activation
        // remains deferred until nonempty PCM actually starts playback.
        NSDictionary *options = c[@"options"] ?: @{};
        Policy(options); Focus(options);
      } else if ([op isEqual:@"playbackStart"]) {
        WFNextPlayback *existing = self->_players[pid];
        if (existing) {
          if (existing.failed) WFNextFail(@"Playback has terminally failed");
          if ([c[@"samples"] count] || [c[@"sampleRate"] doubleValue] != existing.rate) WFNextFail(@"Playback resume must retain its original PCM and sample rate");
          existing.interrupted = NO;
          if (self->_background && ![existing.policy isEqual:@"continue"]) {
            [self pausePlayer:existing notify:YES];
            // Still notify when already paused, so an explicit background resume remains paused in JS.
            existing.emit(@{@"type":@"playbackState", @"state":@"paused"});
          } else {
            if (!existing.drained || existing.started) {
              [self sessionForCapture:self->_capture && !self->_capturePaused extraPlayer:existing];
              NSError *error = nil; if (![existing.engine startAndReturnError:&error]) WFNextFail(error.localizedDescription);
              existing.started = YES; if (!existing.drained) [existing.node play];
            }
            existing.paused = NO; [self startPositionClock:existing]; existing.emit(@{@"type":@"playbackState", @"state":@"resumed"});
          }
          return;
        }
        NSDictionary *options = c[@"options"] ?: @{};
        WFNextPlayback *p = [WFNextPlayback new]; p.policy = Policy(options); p.focus = Focus(options);
        p.rate = [c[@"sampleRate"] doubleValue]; p.offset = [c[@"offsetMs"] doubleValue]; p.stoppedPosition = p.offset;
        if (!std::isfinite(p.offset) || p.offset < 0) WFNextFail(@"Invalid playback offset");
        AVAudioPCMBuffer *validation = PCM(c[@"samples"], p.rate);
        p.emit = [emit copy]; p.engine = [AVAudioEngine new]; p.node = [AVAudioPlayerNode new];
        [p.engine attachNode:p.node]; [p.engine connect:p.node to:p.engine.mainMixerNode format:validation.format];
        p.paused = self->_background && ![p.policy isEqual:@"continue"];
        p.drained = YES; self->_players[pid] = p;
        @try { [self append:c[@"samples"] player:p]; if (p.paused) p.emit(@{@"type":@"playbackState", @"state":@"paused"}); }
        @catch (NSException *e) { [self stopPositionClock:p]; [p.node stop]; [p.engine stop]; [self->_players removeObjectForKey:pid]; [self refreshSession]; @throw; }
      } else {
        WFNextPlayback *p = self->_players[pid];
        // Prepare only validates on iOS: pause/close before PCM have no native
        // resources to release. Close also handles rejected/rolled-back starts.
        if (!p && ([op isEqual:@"playbackClose"] || [op isEqual:@"playbackPause"])) return;
        if (!p) WFNextFail(@"Unknown playbackId");
        if ([op isEqual:@"playbackAppend"]) {
          @try { [self append:c[@"samples"] player:p]; }
          @catch (NSException *e) { [self failPlayer:p message:e.reason]; [self refreshSession]; @throw; }
        }
        else if ([op isEqual:@"playbackPosition"]) result = @([self position:p]);
        else if ([op isEqual:@"playbackPause"]) { p.interrupted = YES; [self pausePlayer:p notify:NO]; [self refreshSession]; }
        else if ([op isEqual:@"playbackClose"]) { [self->_players removeObjectForKey:pid]; [self stopPositionClock:p]; [p.node stop]; [p.engine stop]; [self refreshSession]; }
        else WFNextFail(@"Unknown audio operation");
      }
    } @catch (NSException *e) { failure = e; }
  });
  if (failure) @throw failure;
  return result;
}
- (void)invalidate {
  for (id observer in _observers) [NSNotificationCenter.defaultCenter removeObserver:observer]; [_observers removeAllObjects];
  dispatch_sync(_queue, ^{
    self->_invalid = YES; [self pauseCapture]; self->_capture = nil; self->_captureEmit = nil;
    for (WFNextPlayback *p in self->_players.allValues) { [self stopPositionClock:p]; [p.node stop]; [p.engine stop]; }
    [self->_players removeAllObjects];
    @try { [self refreshSession]; } @catch (NSException *e) { RCTLogWarn(@"WfloatNext teardown: %@", e.reason); }
  });
}
@end
