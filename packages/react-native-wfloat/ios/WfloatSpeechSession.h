#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef void (^WfloatSpeechProgressHandler)(NSInteger requestId,
                                            double progress,
                                            BOOL isPlaying,
                                            NSInteger textHighlightStart,
                                            NSInteger textHighlightEnd,
                                            NSString *text,
                                            NSInteger textHighlightSegment);
typedef void (^WfloatSpeechPlaybackFinishedHandler)(NSInteger requestId);

@interface WfloatSpeechSession : NSObject

@property (nonatomic, readonly) NSInteger requestId;
@property (nonatomic, readonly) int32_t sampleRate;
@property (nonatomic, readonly, getter=isCancelled) BOOL cancelled;
@property (nonatomic, readonly, getter=isGenerationComplete) BOOL generationComplete;
@property (nonatomic, readonly, getter=isPlaying) BOOL playing;

- (instancetype)initWithRequestId:(NSInteger)requestId
                       sampleRate:(int32_t)sampleRate
                      startPaused:(BOOL)startPaused
                  progressHandler:(WfloatSpeechProgressHandler)progressHandler
          playbackFinishedHandler:
              (WfloatSpeechPlaybackFinishedHandler)playbackFinishedHandler NS_DESIGNATED_INITIALIZER;

- (instancetype)init NS_UNAVAILABLE;
+ (instancetype)new NS_UNAVAILABLE;

- (BOOL)scheduleAudioSamples:(const float *)samples
                  frameCount:(NSInteger)frameCount
                    progress:(double)progress
                        text:(NSString *)text
              highlightStart:(NSInteger)highlightStart
                highlightEnd:(NSInteger)highlightEnd
              highlightSegment:(NSInteger)highlightSegment
           silencePaddingSec:(double)silencePaddingSec
                       error:(NSError **)error;

- (void)markGenerationComplete;
- (void)play;
- (void)pause;
- (void)cancel;

@end

NS_ASSUME_NONNULL_END
