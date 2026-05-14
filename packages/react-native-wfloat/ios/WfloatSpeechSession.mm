#import "WfloatSpeechSession.h"

#import <AVFoundation/AVFoundation.h>
#import <string.h>

static NSString *const WfloatSpeechSessionErrorDomain = @"WfloatSpeechSessionErrorDomain";
static const NSTimeInterval WfloatSpeechProgressTickIntervalSec = 0.05;

static void WfloatDispatchSyncOnMain(void (^block)(void)) {
  if (NSThread.isMainThread) {
    block();
    return;
  }

  dispatch_sync(dispatch_get_main_queue(), block);
}

@interface WfloatSpeechChunk : NSObject
@property (nonatomic, assign) AVAudioFramePosition startFrame;
@property (nonatomic, assign) double progress;
@property (nonatomic, assign) NSInteger textHighlightStart;
@property (nonatomic, assign) NSInteger textHighlightEnd;
@property (nonatomic, assign) NSInteger textHighlightSegment;
@property (nonatomic, copy) NSString *text;
@end

@implementation WfloatSpeechChunk
@end

@interface WfloatSpeechSession ()
@property (nonatomic, copy, readonly) WfloatSpeechProgressHandler progressHandler;
@property (nonatomic, copy, readonly)
    WfloatSpeechPlaybackFinishedHandler playbackFinishedHandler;
@property (nonatomic, strong) AVAudioEngine *audioEngine;
@property (nonatomic, strong) AVAudioPlayerNode *playerNode;
@property (nonatomic, strong) AVAudioFormat *audioFormat;
@property (nonatomic, strong) NSMutableArray<WfloatSpeechChunk *> *chunks;
@property (nonatomic, assign) AVAudioFramePosition scheduledFrameCursor;
@property (nonatomic, assign) NSInteger lastEmittedChunkIndex;
@property (nonatomic, assign) NSUInteger pendingScheduledBufferCount;
@property (nonatomic, assign) BOOL userPaused;
@property (nonatomic, assign) BOOL playbackFinishedEmitted;
@property (nonatomic, assign) BOOL cancelled;
@property (nonatomic, assign) BOOL generationComplete;
@property (nonatomic, strong, nullable) dispatch_source_t playbackTimer;
@property (nonatomic, strong, nullable) id interruptionObserver;
@end

@implementation WfloatSpeechSession

- (instancetype)initWithRequestId:(NSInteger)requestId
                       sampleRate:(int32_t)sampleRate
                      startPaused:(BOOL)startPaused
                  progressHandler:(WfloatSpeechProgressHandler)progressHandler
          playbackFinishedHandler:
              (WfloatSpeechPlaybackFinishedHandler)playbackFinishedHandler {
  self = [super init];
  if (self) {
    _requestId = requestId;
    _sampleRate = sampleRate;
    _progressHandler = [progressHandler copy];
    _playbackFinishedHandler = [playbackFinishedHandler copy];
    _chunks = [NSMutableArray array];
    _lastEmittedChunkIndex = -1;
    _userPaused = startPaused;

    __weak WfloatSpeechSession *weakSelf = self;
    _interruptionObserver = [[NSNotificationCenter defaultCenter]
        addObserverForName:AVAudioSessionInterruptionNotification
                    object:[AVAudioSession sharedInstance]
                     queue:[NSOperationQueue mainQueue]
                usingBlock:^(NSNotification *_Nonnull note) {
                  NSDictionary *userInfo = note.userInfo;
                  NSNumber *typeValue = userInfo[AVAudioSessionInterruptionTypeKey];
                  if (typeValue.integerValue == AVAudioSessionInterruptionTypeBegan) {
                    [weakSelf pause];
                  }
                }];
  }

  return self;
}

- (void)dealloc {
  [self cancel];
}

- (BOOL)isPlaying {
  __block BOOL isPlaying = NO;
  WfloatDispatchSyncOnMain(^{
    isPlaying = !self.cancelled && !self.userPaused && self.playerNode.isPlaying;
  });
  return isPlaying;
}

- (BOOL)scheduleAudioSamples:(const float *)samples
                  frameCount:(NSInteger)frameCount
                    progress:(double)progress
                        text:(NSString *)text
              highlightStart:(NSInteger)highlightStart
                highlightEnd:(NSInteger)highlightEnd
            highlightSegment:(NSInteger)highlightSegment
           silencePaddingSec:(double)silencePaddingSec
                       error:(NSError **)error {
  if (self.cancelled || frameCount <= 0 || samples == nullptr) {
    return YES;
  }

  __block BOOL didSucceed = YES;
  __block NSError *scheduleError = nil;

  WfloatDispatchSyncOnMain(^{
    if (self.cancelled) {
      return;
    }

    if (![self setupAudioGraphIfNeeded:&scheduleError]) {
      didSucceed = NO;
      return;
    }

    AVAudioPCMBuffer *audioBuffer =
        [self audioBufferWithSamples:samples frameCount:frameCount];
    if (!audioBuffer) {
      didSucceed = NO;
      scheduleError = [NSError errorWithDomain:WfloatSpeechSessionErrorDomain
                                          code:201
                                      userInfo:@{
                                        NSLocalizedDescriptionKey :
                                            @"Failed to create the audio buffer for generated speech.",
                                      }];
      return;
    }

    WfloatSpeechChunk *chunk = [[WfloatSpeechChunk alloc] init];
    chunk.startFrame = self.scheduledFrameCursor;
    chunk.progress = progress;
    chunk.textHighlightStart = highlightStart;
    chunk.textHighlightEnd = highlightEnd;
    chunk.textHighlightSegment = highlightSegment;
    chunk.text = text;
    [self.chunks addObject:chunk];

    [self scheduleBuffer:audioBuffer];
    self.scheduledFrameCursor += audioBuffer.frameLength;

    if (silencePaddingSec > 0) {
      AVAudioFrameCount silenceFrameCount =
          (AVAudioFrameCount)llround(silencePaddingSec * self.sampleRate);
      if (silenceFrameCount > 0) {
        AVAudioPCMBuffer *silenceBuffer = [self silentBufferWithFrameCount:silenceFrameCount];
        if (silenceBuffer) {
          [self scheduleBuffer:silenceBuffer];
          self.scheduledFrameCursor += silenceBuffer.frameLength;
        }
      }
    }

    [self startPlaybackTimerIfNeeded];
    if (!self.userPaused && !self.playerNode.isPlaying) {
      [self.playerNode play];
    }
  });

  if (!didSucceed && error) {
    *error = scheduleError;
  }

  return didSucceed;
}

- (void)markGenerationComplete {
  WfloatDispatchSyncOnMain(^{
    if (self.cancelled) {
      return;
    }

    self.generationComplete = YES;
    [self maybeEmitPlaybackFinished];
  });
}

- (void)play {
  WfloatDispatchSyncOnMain(^{
    if (self.cancelled) {
      return;
    }

    self.userPaused = NO;

    NSError *playError = nil;
    if (![self setupAudioGraphIfNeeded:&playError]) {
      return;
    }

    if (self.chunks.count > 0 && !self.playerNode.isPlaying) {
      [self.playerNode play];
    }

    [self emitActiveChunkStateChanged];
  });
}

- (void)pause {
  WfloatDispatchSyncOnMain(^{
    if (self.cancelled) {
      return;
    }

    self.userPaused = YES;
    if (self.playerNode.isPlaying) {
      [self.playerNode pause];
    }

    [self emitActiveChunkStateChanged];
  });
}

- (void)cancel {
  WfloatDispatchSyncOnMain(^{
    if (self.cancelled) {
      return;
    }

    self.cancelled = YES;
    [self teardownAudioGraph];
  });
}

- (AVAudioPCMBuffer *)audioBufferWithSamples:(const float *)samples
                                  frameCount:(NSInteger)frameCount {
  AVAudioFormat *format = self.audioFormat;
  if (!format || frameCount <= 0 || samples == nullptr) {
    return nil;
  }

  AVAudioPCMBuffer *buffer =
      [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:(AVAudioFrameCount)frameCount];
  if (!buffer) {
    return nil;
  }

  buffer.frameLength = (AVAudioFrameCount)frameCount;
  float *channelData = buffer.floatChannelData[0];
  if (!channelData) {
    return nil;
  }

  memcpy(channelData, samples, (size_t)frameCount * sizeof(float));
  return buffer;
}

- (AVAudioPCMBuffer *)silentBufferWithFrameCount:(AVAudioFrameCount)frameCount {
  AVAudioFormat *format = self.audioFormat;
  if (!format || frameCount == 0) {
    return nil;
  }

  AVAudioPCMBuffer *buffer =
      [[AVAudioPCMBuffer alloc] initWithPCMFormat:format frameCapacity:frameCount];
  if (!buffer) {
    return nil;
  }

  buffer.frameLength = frameCount;
  float *channelData = buffer.floatChannelData[0];
  if (!channelData) {
    return nil;
  }

  memset(channelData, 0, (size_t)frameCount * sizeof(float));
  return buffer;
}

- (BOOL)setupAudioGraphIfNeeded:(NSError **)error {
  if (!self.audioEngine) {
    self.audioEngine = [[AVAudioEngine alloc] init];
    self.playerNode = [[AVAudioPlayerNode alloc] init];
    self.audioFormat =
        [[AVAudioFormat alloc] initStandardFormatWithSampleRate:self.sampleRate channels:1];
    [self.audioEngine attachNode:self.playerNode];
    [self.audioEngine connect:self.playerNode
                            to:self.audioEngine.mainMixerNode
                        format:self.audioFormat];
    [self.audioEngine prepare];
  }

  AVAudioSession *audioSession = [AVAudioSession sharedInstance];
  if (![audioSession setCategory:AVAudioSessionCategoryPlayback
                           error:error] ||
      ![audioSession setActive:YES error:error]) {
    return NO;
  }

  if (!self.audioEngine.isRunning && ![self.audioEngine startAndReturnError:error]) {
    return NO;
  }

  return YES;
}

- (void)scheduleBuffer:(AVAudioPCMBuffer *)buffer {
  self.pendingScheduledBufferCount += 1;

  __weak WfloatSpeechSession *weakSelf = self;
  [self.playerNode scheduleBuffer:buffer
            completionCallbackType:AVAudioPlayerNodeCompletionDataPlayedBack
                 completionHandler:^(AVAudioPlayerNodeCompletionCallbackType callbackType) {
                   (void)callbackType;
                   dispatch_async(dispatch_get_main_queue(), ^{
                     __strong WfloatSpeechSession *strongSelf = weakSelf;
                     if (!strongSelf || strongSelf.cancelled) {
                       return;
                     }

                     if (strongSelf.pendingScheduledBufferCount > 0) {
                       strongSelf.pendingScheduledBufferCount -= 1;
                     }

                     [strongSelf maybeEmitPlaybackFinished];
                   });
                 }];
}

- (void)startPlaybackTimerIfNeeded {
  if (self.playbackTimer || self.cancelled) {
    return;
  }

  dispatch_source_t timer =
      dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
  dispatch_source_set_timer(timer,
                            dispatch_time(DISPATCH_TIME_NOW, 0),
                            (uint64_t)(WfloatSpeechProgressTickIntervalSec * NSEC_PER_SEC),
                            (uint64_t)(0.01 * NSEC_PER_SEC));

  __weak WfloatSpeechSession *weakSelf = self;
  dispatch_source_set_event_handler(timer, ^{
    [weakSelf tickPlaybackProgress];
  });

  self.playbackTimer = timer;
  dispatch_resume(timer);
}

- (void)stopPlaybackTimer {
  if (!self.playbackTimer) {
    return;
  }

  dispatch_source_cancel(self.playbackTimer);
  self.playbackTimer = nil;
}

- (void)tickPlaybackProgress {
  if (self.cancelled || self.chunks.count == 0) {
    return;
  }

  AVAudioTime *nodeTime = self.playerNode.lastRenderTime;
  if (!nodeTime) {
    return;
  }

  AVAudioTime *playerTime = [self.playerNode playerTimeForNodeTime:nodeTime];
  if (!playerTime) {
    return;
  }

  AVAudioFramePosition sampleTime = MAX((AVAudioFramePosition)0, playerTime.sampleTime);
  while (self.lastEmittedChunkIndex + 1 < (NSInteger)self.chunks.count) {
    WfloatSpeechChunk *nextChunk = self.chunks[(NSUInteger)(self.lastEmittedChunkIndex + 1)];
    if (sampleTime < nextChunk.startFrame) {
      break;
    }

    self.lastEmittedChunkIndex += 1;
    [self emitProgressForChunk:nextChunk];
  }
}

- (void)emitProgressForChunk:(WfloatSpeechChunk *)chunk {
  if (self.cancelled) {
    return;
  }

  self.progressHandler(self.requestId,
                       chunk.progress,
                       self.isPlaying,
                       chunk.textHighlightStart,
                       chunk.textHighlightEnd,
                       chunk.text,
                       chunk.textHighlightSegment);
}

- (void)emitActiveChunkStateChanged {
  if (self.lastEmittedChunkIndex < 0 ||
      self.lastEmittedChunkIndex >= (NSInteger)self.chunks.count) {
    return;
  }

  [self emitProgressForChunk:self.chunks[(NSUInteger)self.lastEmittedChunkIndex]];
}

- (void)maybeEmitPlaybackFinished {
  if (self.cancelled || self.playbackFinishedEmitted || !self.generationComplete ||
      self.pendingScheduledBufferCount > 0) {
    return;
  }

  self.playbackFinishedEmitted = YES;
  NSInteger requestId = self.requestId;
  [self teardownAudioGraph];
  self.playbackFinishedHandler(requestId);
}

- (void)teardownAudioGraph {
  [self stopPlaybackTimer];

  if (self.playerNode.isPlaying) {
    [self.playerNode stop];
  }

  [self.audioEngine stop];
  [self.audioEngine reset];
  self.pendingScheduledBufferCount = 0;

  if (self.interruptionObserver) {
    [[NSNotificationCenter defaultCenter] removeObserver:self.interruptionObserver];
    self.interruptionObserver = nil;
  }
}

@end
