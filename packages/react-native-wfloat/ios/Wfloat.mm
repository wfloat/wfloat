#import "Wfloat.h"
#import "WfloatSpeechSession.h"
#import <AppleArchive/AppleArchive.h>
#import <AVFoundation/AVFoundation.h>
#import <CommonCrypto/CommonDigest.h>
#import <math.h>
#import <sherpa-onnx/c-api/c-api.h>
#import <string.h>
#include <vector>

typedef NS_ENUM(NSInteger, WfloatLoadModelDownloadPhase) {
  WfloatLoadModelDownloadPhaseNone = 0,
  WfloatLoadModelDownloadPhaseModel = 1,
  WfloatLoadModelDownloadPhaseTokens = 2,
  WfloatLoadModelDownloadPhaseEspeakData = 3,
};

static NSString *const WfloatErrorDomain = @"WfloatErrorDomain";
static NSString *const WfloatReadyMarkerFileName = @".ready";

typedef NS_ENUM(NSInteger, WfloatGenerateResult) {
  WfloatGenerateResultCompleted = 0,
  WfloatGenerateResultCancelled = 1,
  WfloatGenerateResultFailed = 2,
};

@interface WfloatDialogueSegment : NSObject
@property (nonatomic, copy) NSString *text;
@property (nonatomic, assign) int32_t sid;
@property (nonatomic, copy) NSString *emotion;
@property (nonatomic, assign) float intensity;
@property (nonatomic, assign) float speed;
@property (nonatomic, assign) float sentenceSilencePaddingSec;
@end

@implementation WfloatDialogueSegment
@end

@interface WfloatPreparedDialogueSegment : NSObject
@property (nonatomic, strong) NSArray<NSString *> *rawTextChunks;
@property (nonatomic, strong) NSArray<NSString *> *textCleanChunks;
@property (nonatomic, copy) NSString *rawText;
@property (nonatomic, assign) int32_t sid;
@property (nonatomic, assign) float speed;
@property (nonatomic, assign) float sentenceSilencePaddingSec;
@end

@implementation WfloatPreparedDialogueSegment
@end

static NSString *WfloatCacheRootDirectory(void) {
  NSArray<NSString *> *paths =
      NSSearchPathForDirectoriesInDomains(NSCachesDirectory, NSUserDomainMask, YES);
  NSString *cacheDirectory = paths.firstObject ?: NSTemporaryDirectory();
  return [cacheDirectory stringByAppendingPathComponent:@"wfloat"];
}

static NSString *WfloatModelCacheRootDirectory(void) {
  return [WfloatCacheRootDirectory() stringByAppendingPathComponent:@"models"];
}

static NSString *WfloatEspeakCacheRootDirectory(void) {
  return [WfloatCacheRootDirectory() stringByAppendingPathComponent:@"espeak"];
}

static NSString *WfloatEspeakWorkRootDirectory(void) {
  return [WfloatCacheRootDirectory() stringByAppendingPathComponent:@"espeak-work"];
}

static double WfloatFramesToSeconds(AVAudioFramePosition frameCount, int32_t sampleRate) {
  if (sampleRate <= 0) {
    return 0;
  }

  return (double)frameCount / (double)sampleRate;
}

@interface Wfloat () <NSURLSessionDownloadDelegate, AVAudioRecorderDelegate>
@property (nonatomic, assign) const SherpaOnnxOfflineTts *tts;
@property (nonatomic, assign) const SherpaOnnxOfflineRecognizer *offlineRecognizer;
@property (nonatomic, assign) const SherpaOnnxOnlineRecognizer *onlineRecognizer;
@property (nonatomic, assign) const SherpaOnnxVoiceActivityDetector *vad;
@property (nonatomic, copy) NSString *loadedModelPath;
@property (nonatomic, copy) NSString *loadedTokensPath;
@property (nonatomic, copy) NSString *loadedDataDir;
@property (nonatomic, copy) NSString *loadedSttModelId;
@property (nonatomic, copy) NSString *loadedSttFamily;
@property (nonatomic, copy) NSString *loadedVadModelId;
@property (nonatomic, copy) NSString *loadedVadFamily;
@property (strong, nonatomic) NSURLSession *loadModelSession;
@property (nonatomic, copy) RCTPromiseResolveBlock loadModelResolve;
@property (nonatomic, copy) RCTPromiseRejectBlock loadModelReject;
@property (nonatomic, copy) NSString *pendingModelId;
@property (nonatomic, copy) NSString *pendingModelURLString;
@property (nonatomic, copy) NSString *pendingTokensURLString;
@property (nonatomic, copy) NSString *pendingEspeakDataURLString;
@property (nonatomic, copy) NSString *pendingEspeakChecksum;
@property (nonatomic, copy) NSString *pendingModelPath;
@property (nonatomic, copy) NSString *pendingTokensPath;
@property (nonatomic, copy) NSString *pendingEspeakDirectoryPath;
@property (nonatomic, copy) NSString *pendingEspeakArchivePath;
@property (nonatomic, copy) NSString *currentDownloadDestinationPath;
@property (nonatomic, assign) WfloatLoadModelDownloadPhase currentDownloadPhase;
@property (nonatomic, assign) BOOL pendingNeedsModelDownload;
@property (nonatomic, assign) BOOL pendingNeedsTokensDownload;
@property (nonatomic, assign) BOOL pendingNeedsEspeakDownload;
@property (nonatomic, assign) NSUInteger completedDownloadCount;
@property (nonatomic, assign) NSUInteger totalPlannedDownloadCount;
@property (nonatomic, assign) float lastEmittedDownloadProgress;
@property (nonatomic, strong) WfloatSpeechSession *speechSession;
@property (nonatomic, strong) NSMutableDictionary<NSNumber *, NSValue *> *sttSessions;
@property (nonatomic, assign) NSInteger nextSttSessionId;
@property (nonatomic, assign) BOOL sttLoadInProgress;
@property (nonatomic, strong) AVAudioRecorder *sttMicrophoneRecorder;
@property (nonatomic, strong) NSURL *sttMicrophoneRecordingURL;
@property (nonatomic, strong) NSDate *sttMicrophoneRecordingStartedAt;
@property (nonatomic, copy) RCTPromiseResolveBlock sttMicrophoneStopResolve;
@property (nonatomic, copy) RCTPromiseRejectBlock sttMicrophoneStopReject;
@property (nonatomic, assign) NSInteger sttMicrophoneRecordingSampleRate;
@property (nonatomic, strong) AVAudioEngine *sttMicrophoneAudioEngine;
@property (nonatomic, strong) AVAudioFormat *sttMicrophoneTargetFormat;
@property (nonatomic, strong) NSDate *sttMicrophoneStartedAt;
@property (nonatomic, assign) NSInteger sttMicrophoneSessionId;
@property (nonatomic, assign) NSInteger sttMicrophoneSampleRate;
@property (nonatomic, assign) NSInteger sttMicrophoneCallbackCount;
@property (nonatomic, assign) NSInteger sttMicrophoneEmittedChunkCount;
@property (nonatomic, assign) NSInteger sttMicrophoneInputChannels;
@property (nonatomic, assign) NSInteger sttMicrophoneLastInputFrameLength;
@property (nonatomic, assign) double sttMicrophoneInputSampleRate;
@property (nonatomic, assign) double sttMicrophoneLastRawRms;
@property (nonatomic, assign) double sttMicrophoneLastNormalizedRms;
@property (nonatomic, assign) double sttMicrophoneMaxRawRms;
@property (nonatomic, assign) double sttMicrophoneMaxNormalizedRms;
@property (nonatomic) dispatch_queue_t workQueue;

@end

@implementation Wfloat
RCT_EXPORT_MODULE()

#ifdef RCT_NEW_ARCH_ENABLED
- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params
{
  return std::make_shared<facebook::react::NativeWfloatSpecJSI>(params);
}
#endif

- (void)dealloc {
  [self.speechSession cancel];
  self.speechSession = nil;
  [self.sttMicrophoneRecorder stop];
  self.sttMicrophoneRecorder = nil;
  [self stopSttMicrophoneCapture];
  [self closeAllSttSessions];

  if (self.tts) {
    SherpaOnnxDestroyOfflineTts(self.tts);
    self.tts = nil;
  }

  if (self.offlineRecognizer) {
    SherpaOnnxDestroyOfflineRecognizer(self.offlineRecognizer);
    self.offlineRecognizer = nil;
  }

  if (self.onlineRecognizer) {
    SherpaOnnxDestroyOnlineRecognizer(self.onlineRecognizer);
    self.onlineRecognizer = nil;
  }

  if (self.vad) {
    SherpaOnnxDestroyVoiceActivityDetector(self.vad);
    self.vad = nil;
  }

  [self.loadModelSession invalidateAndCancel];
}

- (dispatch_queue_t)workQueue {
  if (_workQueue == nil) {
    _workQueue = dispatch_queue_create("com.wfloat.react-native-wfloat.work", DISPATCH_QUEUE_SERIAL);
  }

  return _workQueue;
}

- (NSMutableDictionary<NSNumber *, NSValue *> *)sttSessions {
  if (_sttSessions == nil) {
    _sttSessions = [NSMutableDictionary dictionary];
  }

  return _sttSessions;
}

- (BOOL)ensureDirectoryExistsAtPath:(NSString *)path error:(NSError **)error {
  return [[NSFileManager defaultManager] createDirectoryAtPath:path
                                  withIntermediateDirectories:YES
                                                   attributes:nil
                                                        error:error];
}

- (NSString *)cacheDirectoryForModelId:(NSString *)modelId {
  return [WfloatModelCacheRootDirectory() stringByAppendingPathComponent:modelId];
}

- (NSString *)espeakDirectoryForChecksum:(NSString *)checksum {
  return [WfloatEspeakCacheRootDirectory() stringByAppendingPathComponent:checksum.lowercaseString];
}

- (NSString *)espeakArchivePathForChecksum:(NSString *)checksum {
  NSString *archiveFileName = [NSString stringWithFormat:@"%@.aar", checksum.lowercaseString];
  return [WfloatEspeakWorkRootDirectory() stringByAppendingPathComponent:archiveFileName];
}

- (NSString *)espeakReadyMarkerPathForDirectory:(NSString *)directoryPath {
  return [directoryPath stringByAppendingPathComponent:WfloatReadyMarkerFileName];
}

- (BOOL)isInstalledEspeakDirectoryAtPath:(NSString *)directoryPath {
  BOOL isDirectory = NO;
  BOOL directoryExists =
      [[NSFileManager defaultManager] fileExistsAtPath:directoryPath isDirectory:&isDirectory];
  if (!directoryExists || !isDirectory) {
    return NO;
  }

  return [[NSFileManager defaultManager]
      fileExistsAtPath:[self espeakReadyMarkerPathForDirectory:directoryPath]];
}

- (NSString *)normalizedChecksum:(NSString *)checksum {
  return [[checksum stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]
      lowercaseString];
}

- (void)cleanupDirectoryContentsAtPath:(NSString *)directoryPath {
  NSError *contentsError = nil;
  NSArray<NSString *> *fileNames =
      [[NSFileManager defaultManager] contentsOfDirectoryAtPath:directoryPath error:&contentsError];
  if (contentsError || fileNames.count == 0) {
    return;
  }

  for (NSString *fileName in fileNames) {
    NSString *path = [directoryPath stringByAppendingPathComponent:fileName];
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
  }
}

- (void)cleanupEspeakWorkDirectory {
  NSString *workDirectoryPath = WfloatEspeakWorkRootDirectory();
  [self cleanupDirectoryContentsAtPath:workDirectoryPath];
  [[NSFileManager defaultManager] removeItemAtPath:workDirectoryPath error:nil];
}

- (void)emitLoadModelProgressWithStatus:(NSString *)status progress:(NSNumber *)progress {
#ifdef RCT_NEW_ARCH_ENABLED
  NSMutableDictionary *event = [NSMutableDictionary dictionaryWithObject:status forKey:@"status"];
  if (progress != nil) {
    event[@"progress"] = progress;
  }
  [self emitOnLoadModelProgress:event];
#else
  (void)status;
  (void)progress;
#endif
}

- (void)emitSpeechProgressWithRequestId:(NSInteger)requestId
                               progress:(double)progress
                              isPlaying:(BOOL)isPlaying
                     textHighlightStart:(NSInteger)textHighlightStart
                       textHighlightEnd:(NSInteger)textHighlightEnd
                                   text:(NSString *)text
                   textHighlightSegment:(NSInteger)textHighlightSegment {
#ifdef RCT_NEW_ARCH_ENABLED
  NSMutableDictionary<NSString *, id> *event = [@{
    @"requestId" : @(requestId),
    @"progress" : @(progress),
    @"isPlaying" : @(isPlaying),
    @"textHighlightStart" : @(textHighlightStart),
    @"textHighlightEnd" : @(textHighlightEnd),
    @"text" : text ?: @"",
  } mutableCopy];
  if (textHighlightSegment >= 0) {
    event[@"textHighlightSegment"] = @(textHighlightSegment);
  }
  [self emitOnSpeechProgress:event];
#else
  (void)requestId;
  (void)progress;
  (void)isPlaying;
  (void)textHighlightStart;
  (void)textHighlightEnd;
  (void)text;
  (void)textHighlightSegment;
#endif
}

- (void)emitSpeechPlaybackFinishedWithRequestId:(NSInteger)requestId {
#ifdef RCT_NEW_ARCH_ENABLED
  [self emitOnSpeechPlaybackFinished:@{@"requestId" : @(requestId)}];
#else
  (void)requestId;
#endif
}

- (void)cancelCurrentSpeechSession {
  [self.speechSession cancel];
  self.speechSession = nil;
}

- (BOOL)isCurrentSpeechSession:(WfloatSpeechSession *)session {
  return self.speechSession != nil && self.speechSession == session;
}

- (void)clearPendingLoadModelState {
  [self.loadModelSession invalidateAndCancel];
  self.loadModelSession = nil;
  self.loadModelResolve = nil;
  self.loadModelReject = nil;
  self.pendingModelId = nil;
  self.pendingModelURLString = nil;
  self.pendingTokensURLString = nil;
  self.pendingEspeakDataURLString = nil;
  self.pendingEspeakChecksum = nil;
  self.pendingModelPath = nil;
  self.pendingTokensPath = nil;
  self.pendingEspeakDirectoryPath = nil;
  self.pendingEspeakArchivePath = nil;
  self.currentDownloadDestinationPath = nil;
  self.currentDownloadPhase = WfloatLoadModelDownloadPhaseNone;
  self.pendingNeedsModelDownload = NO;
  self.pendingNeedsTokensDownload = NO;
  self.pendingNeedsEspeakDownload = NO;
  self.completedDownloadCount = 0;
  self.totalPlannedDownloadCount = 0;
  self.lastEmittedDownloadProgress = -1;
  [self cleanupEspeakWorkDirectory];
}

- (void)rejectPendingLoadModelWithCode:(NSString *)code
                               message:(NSString *)message
                                 error:(NSError *)error {
  RCTPromiseRejectBlock reject = self.loadModelReject;
  [self clearPendingLoadModelState];
  if (reject) {
    reject(code, message, error);
  }
}

- (void)resolvePendingLoadModel {
  RCTPromiseResolveBlock resolve = self.loadModelResolve;
  [self clearPendingLoadModelState];
  if (resolve) {
    resolve(nil);
  }
}

- (NSString *)fileNameFromURLString:(NSString *)urlString error:(NSError **)error {
  NSURL *url = [NSURL URLWithString:urlString];
  NSString *fileName = url.lastPathComponent;
  if (fileName.length > 0) {
    return fileName;
  }

  if (error) {
    *error = [NSError errorWithDomain:WfloatErrorDomain
                                 code:100
                             userInfo:@{NSLocalizedDescriptionKey : @"Invalid loadModel asset URL."}];
  }
  return nil;
}

- (NSString *)sha256ForFileAtPath:(NSString *)filePath error:(NSError **)error {
  NSInputStream *inputStream = [NSInputStream inputStreamWithFileAtPath:filePath];
  [inputStream open];

  if (inputStream.streamStatus != NSStreamStatusOpen) {
    if (error) {
      *error = inputStream.streamError ?: [NSError errorWithDomain:WfloatErrorDomain
                                                              code:102
                                                          userInfo:@{
                                                            NSLocalizedDescriptionKey :
                                                                @"Failed to open downloaded asset for checksum verification.",
                                                          }];
    }
    return nil;
  }

  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);

  uint8_t buffer[64 * 1024];
  NSInteger bytesRead = 0;
  while ((bytesRead = [inputStream read:buffer maxLength:sizeof(buffer)]) > 0) {
    CC_SHA256_Update(&context, buffer, (CC_LONG)bytesRead);
  }

  NSError *streamError = inputStream.streamError;
  [inputStream close];

  if (bytesRead < 0 || streamError) {
    if (error) {
      *error = streamError ?: [NSError errorWithDomain:WfloatErrorDomain
                                                  code:103
                                              userInfo:@{
                                                NSLocalizedDescriptionKey :
                                                    @"Failed to read downloaded asset for checksum verification.",
                                              }];
    }
    return nil;
  }

  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);

  NSMutableString *hash = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (NSInteger index = 0; index < CC_SHA256_DIGEST_LENGTH; index += 1) {
    [hash appendFormat:@"%02x", digest[index]];
  }

  return hash;
}

- (NSString *)resolvedEspeakDataDirectoryFromExtractionRoot:(NSString *)extractionRoot
                                                      error:(NSError **)error {
  NSError *contentsError = nil;
  NSArray<NSString *> *contents =
      [[NSFileManager defaultManager] contentsOfDirectoryAtPath:extractionRoot error:&contentsError];
  if (contentsError) {
    if (error) {
      *error = contentsError;
    }
    return nil;
  }

  NSMutableArray<NSString *> *filteredContents = [NSMutableArray array];
  for (NSString *entry in contents) {
    if ([entry hasPrefix:@"."] || [entry isEqualToString:@"__MACOSX"]) {
      continue;
    }

    [filteredContents addObject:entry];
  }

  NSString *namedDirectoryPath = [extractionRoot stringByAppendingPathComponent:@"espeak-ng-data"];
  BOOL isNamedDirectory = NO;
  if ([[NSFileManager defaultManager] fileExistsAtPath:namedDirectoryPath isDirectory:&isNamedDirectory] &&
      isNamedDirectory) {
    return namedDirectoryPath;
  }

  NSMutableArray<NSString *> *childDirectories = [NSMutableArray array];
  for (NSString *entry in filteredContents) {
    NSString *entryPath = [extractionRoot stringByAppendingPathComponent:entry];
    BOOL isDirectory = NO;
    if ([[NSFileManager defaultManager] fileExistsAtPath:entryPath isDirectory:&isDirectory] &&
        isDirectory) {
      [childDirectories addObject:entryPath];
    }
  }

  if (filteredContents.count == 1 && childDirectories.count == 1) {
    return childDirectories.firstObject;
  }

  return extractionRoot;
}

- (BOOL)installEspeakArchiveAtPath:(NSString *)archivePath
                          checksum:(NSString *)checksum
                   destinationPath:(NSString *)destinationPath
                             error:(NSError **)error {
  NSString *computedChecksum = [self sha256ForFileAtPath:archivePath error:error];
  if (computedChecksum.length == 0) {
    return NO;
  }

  NSString *normalizedChecksum = [self normalizedChecksum:checksum];
  if (![computedChecksum isEqualToString:normalizedChecksum]) {
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:104
                               userInfo:@{
                                 NSLocalizedDescriptionKey :
                                     @"Downloaded espeak-ng-data checksum did not match the expected value.",
                               }];
    }
    return NO;
  }

  NSError *filesystemError = nil;
  if (![self ensureDirectoryExistsAtPath:WfloatEspeakWorkRootDirectory() error:&filesystemError]) {
    if (error) {
      *error = filesystemError;
    }
    return NO;
  }

  NSString *temporaryRoot = [WfloatEspeakWorkRootDirectory()
      stringByAppendingPathComponent:[[NSUUID UUID] UUIDString]];
  if (![self ensureDirectoryExistsAtPath:temporaryRoot error:&filesystemError]) {
    if (error) {
      *error = filesystemError;
    }
    return NO;
  }

  AAByteStream fileStream =
      AAFileStreamOpenWithPath(archivePath.fileSystemRepresentation, O_RDONLY, 0);
  if (fileStream == NULL) {
    [[NSFileManager defaultManager] removeItemAtPath:temporaryRoot error:nil];
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:105
                               userInfo:@{
                                 NSLocalizedDescriptionKey :
                                     @"Failed to open espeak-ng-data archive for extraction.",
                               }];
    }
    return NO;
  }

  AAByteStream decompressedStream = AADecompressionInputStreamOpen(fileStream, 0, 0);
  if (decompressedStream == NULL) {
    AAByteStreamClose(fileStream);
    [[NSFileManager defaultManager] removeItemAtPath:temporaryRoot error:nil];
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:106
                               userInfo:@{
                                 NSLocalizedDescriptionKey :
                                     @"Failed to open Apple Archive decompression stream.",
                               }];
    }
    return NO;
  }

  AAArchiveStream decodeStream = AADecodeArchiveInputStreamOpen(decompressedStream, NULL, NULL, 0, 0);
  if (decodeStream == NULL) {
    AAByteStreamClose(decompressedStream);
    AAByteStreamClose(fileStream);
    [[NSFileManager defaultManager] removeItemAtPath:temporaryRoot error:nil];
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:107
                               userInfo:@{
                                 NSLocalizedDescriptionKey :
                                     @"Failed to decode Apple Archive stream.",
                               }];
    }
    return NO;
  }

  AAArchiveStream extractStream =
      AAExtractArchiveOutputStreamOpen(temporaryRoot.fileSystemRepresentation, NULL, NULL, 0, 0);
  if (extractStream == NULL) {
    AAArchiveStreamClose(decodeStream);
    AAByteStreamClose(decompressedStream);
    AAByteStreamClose(fileStream);
    [[NSFileManager defaultManager] removeItemAtPath:temporaryRoot error:nil];
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:108
                               userInfo:@{
                                 NSLocalizedDescriptionKey :
                                     @"Failed to open Apple Archive extraction stream.",
                               }];
    }
    return NO;
  }

  ssize_t processedEntryCount = AAArchiveStreamProcess(decodeStream, extractStream, NULL, NULL, 0, 0);
  int extractCloseStatus = AAArchiveStreamClose(extractStream);
  int decodeCloseStatus = AAArchiveStreamClose(decodeStream);
  int decompressedCloseStatus = AAByteStreamClose(decompressedStream);
  int fileCloseStatus = AAByteStreamClose(fileStream);
  BOOL didExtract = processedEntryCount >= 0 && extractCloseStatus == 0 && decodeCloseStatus == 0 &&
      decompressedCloseStatus == 0 && fileCloseStatus == 0;
  if (!didExtract) {
    NSInteger archiveErrorCode = 0;
    if (processedEntryCount < 0) {
      archiveErrorCode = processedEntryCount;
    } else if (extractCloseStatus != 0) {
      archiveErrorCode = extractCloseStatus;
    } else if (decodeCloseStatus != 0) {
      archiveErrorCode = decodeCloseStatus;
    } else if (decompressedCloseStatus != 0) {
      archiveErrorCode = decompressedCloseStatus;
    } else if (fileCloseStatus != 0) {
      archiveErrorCode = fileCloseStatus;
    }

    [[NSFileManager defaultManager] removeItemAtPath:temporaryRoot error:nil];
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:109
                               userInfo:@{
                                 NSLocalizedDescriptionKey :
                                     [NSString stringWithFormat:
                                                   @"Failed to extract Apple Archive espeak-ng-data asset (code %ld).",
                                                   (long)archiveErrorCode],
                               }];
    }
    return NO;
  }

  NSString *resolvedDataDirectory =
      [self resolvedEspeakDataDirectoryFromExtractionRoot:temporaryRoot error:&filesystemError];
  if (resolvedDataDirectory.length == 0) {
    [[NSFileManager defaultManager] removeItemAtPath:temporaryRoot error:nil];
    if (error) {
      *error = filesystemError ?: [NSError errorWithDomain:WfloatErrorDomain
                                                      code:110
                                                  userInfo:@{
                                                    NSLocalizedDescriptionKey :
                                                        @"Unable to locate extracted espeak-ng-data directory.",
                                                  }];
    }
    return NO;
  }

  [[NSFileManager defaultManager] removeItemAtPath:destinationPath error:nil];
  if (![[NSFileManager defaultManager] moveItemAtPath:resolvedDataDirectory
                                               toPath:destinationPath
                                                error:&filesystemError]) {
    [[NSFileManager defaultManager] removeItemAtPath:temporaryRoot error:nil];
    if (error) {
      *error = filesystemError;
    }
    return NO;
  }

  NSString *readyMarkerPath = [self espeakReadyMarkerPathForDirectory:destinationPath];
  if (![WfloatReadyMarkerFileName writeToFile:readyMarkerPath
                                   atomically:YES
                                     encoding:NSUTF8StringEncoding
                                        error:&filesystemError]) {
    [[NSFileManager defaultManager] removeItemAtPath:destinationPath error:nil];
    if (error) {
      *error = filesystemError;
    }
    return NO;
  }

  if (![resolvedDataDirectory isEqualToString:temporaryRoot]) {
    [[NSFileManager defaultManager] removeItemAtPath:temporaryRoot error:nil];
  }

  return YES;
}

- (BOOL)loadTtsWithModelPath:(NSString *)modelPath
                  tokensPath:(NSString *)tokensPath
                     dataDir:(NSString *)dataDir
                     modelId:(NSString *)modelId
                       error:(NSError **)error {
  if (self.tts && [self.loadedModelPath isEqualToString:modelPath] &&
      [self.loadedTokensPath isEqualToString:tokensPath] &&
      [self.loadedDataDir isEqualToString:dataDir]) {
    return YES;
  }

  SherpaOnnxOfflineTtsConfig config;
  memset(&config, 0, sizeof(config));
  config.model.wfloat.model = [modelPath UTF8String];
  config.model.wfloat.tokens = [tokensPath UTF8String];
  config.model.wfloat.data_dir = [dataDir UTF8String];
  config.model.wfloat.noise_scale = 0.667f;
  config.model.wfloat.noise_scale_w = 0.8f;
  config.model.wfloat.length_scale = 1.0f;
  config.model.num_threads = 1;
  config.model.debug = 0;
  config.model.provider = "cpu";
  config.max_num_sentences = 1;
  config.silence_scale = 0.2f;

  const SherpaOnnxOfflineTts *newTts = SherpaOnnxCreateOfflineTts(&config);
  if (!newTts) {
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:101
                               userInfo:@{
                                NSLocalizedDescriptionKey : @"Failed to initialize TTS model",
                               }];
    }
    return NO;
  }

  if (self.tts) {
    SherpaOnnxDestroyOfflineTts(self.tts);
  }

  self.tts = newTts;
  self.loadedModelPath = modelPath;
  self.loadedTokensPath = tokensPath;
  self.loadedDataDir = dataDir;
  return YES;
}

- (void)closeAllSttSessions {
  [self stopSttMicrophoneCapture];
  for (NSValue *value in self.sttSessions.allValues) {
    const SherpaOnnxOnlineStream *stream =
        (const SherpaOnnxOnlineStream *)value.pointerValue;
    if (stream) {
      SherpaOnnxDestroyOnlineStream(stream);
    }
  }
  [self.sttSessions removeAllObjects];
}

- (const SherpaOnnxOnlineStream *)streamForSessionId:(NSInteger)sessionId {
  NSValue *value = self.sttSessions[@(sessionId)];
  return value ? (const SherpaOnnxOnlineStream *)value.pointerValue : nil;
}

- (void)ensureRecordPermission:(void (^)(BOOL granted))completion {
  AVAudioSession *session = [AVAudioSession sharedInstance];
  AVAudioSessionRecordPermission permission = session.recordPermission;
  switch (permission) {
    case AVAudioSessionRecordPermissionGranted:
      completion(YES);
      return;
    case AVAudioSessionRecordPermissionDenied:
      completion(NO);
      return;
    case AVAudioSessionRecordPermissionUndetermined:
    default:
      [session requestRecordPermission:^(BOOL granted) {
        dispatch_async(dispatch_get_main_queue(), ^{
          completion(granted);
        });
      }];
      return;
  }
}

- (BOOL)configureSharedSessionForRecordingWithSampleRate:(NSInteger)sampleRate
                                                   error:(NSError **)error {
  AVAudioSession *session = [AVAudioSession sharedInstance];
  AVAudioSessionCategoryOptions options =
      AVAudioSessionCategoryOptionDefaultToSpeaker | AVAudioSessionCategoryOptionAllowBluetooth;
  return [session setCategory:AVAudioSessionCategoryPlayAndRecord
                         mode:AVAudioSessionModeMeasurement
                      options:options
                        error:error] &&
         [session setPreferredSampleRate:(double)sampleRate error:error] &&
         [session setActive:YES error:error];
}

- (AVAudioPCMBuffer *)normalizedBufferFromBuffer:(AVAudioPCMBuffer *)buffer
                                      sampleRate:(NSInteger)sampleRate
                                    targetFormat:(AVAudioFormat *)existingTargetFormat
                                           error:(NSError **)error {
  if (buffer.format.commonFormat == AVAudioPCMFormatFloat32 &&
      buffer.format.channelCount == 1 &&
      llround(buffer.format.sampleRate) == sampleRate &&
      buffer.floatChannelData != nil) {
    return buffer;
  }

  AVAudioFormat *targetFormat = existingTargetFormat;
  if (!targetFormat) {
    targetFormat =
        [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32
                                         sampleRate:(double)sampleRate
                                           channels:1
                                        interleaved:NO];
  }
  if (!targetFormat) {
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:401
                               userInfo:@{
                                 NSLocalizedDescriptionKey :
                                     @"Failed to create microphone audio format."
                               }];
    }
    return nil;
  }

  AVAudioConverter *converter =
      [[AVAudioConverter alloc] initFromFormat:buffer.format toFormat:targetFormat];
  if (!converter) {
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:402
                               userInfo:@{
                                 NSLocalizedDescriptionKey :
                                     @"Failed to create microphone audio converter."
                               }];
    }
    return nil;
  }

  double ratio = targetFormat.sampleRate / MAX(buffer.format.sampleRate, 1.0);
  AVAudioFrameCount outputFrameCapacity =
      (AVAudioFrameCount)MAX(1.0, ceil(buffer.frameLength * ratio) + 64.0);
  AVAudioPCMBuffer *outputBuffer =
      [[AVAudioPCMBuffer alloc] initWithPCMFormat:targetFormat
                                    frameCapacity:outputFrameCapacity];
  if (!outputBuffer) {
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:403
                               userInfo:@{
                                 NSLocalizedDescriptionKey :
                                     @"Failed to allocate microphone audio buffer."
                               }];
    }
    return nil;
  }

  __block BOOL suppliedInput = NO;
  AVAudioConverterOutputStatus status =
      [converter convertToBuffer:outputBuffer
                           error:error
              withInputFromBlock:^AVAudioBuffer *_Nullable(
                                     AVAudioPacketCount inNumberOfPackets,
                                     AVAudioConverterInputStatus *_Nonnull outStatus) {
                if (suppliedInput) {
                  *outStatus = AVAudioConverterInputStatus_EndOfStream;
                  return nil;
                }

                suppliedInput = YES;
                *outStatus = AVAudioConverterInputStatus_HaveData;
                return buffer;
              }];
  if (status == AVAudioConverterOutputStatus_Error ||
      outputBuffer.floatChannelData == nil) {
    if (status != AVAudioConverterOutputStatus_Error && error && *error == nil) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:404
                               userInfo:@{
                                 NSLocalizedDescriptionKey :
                                     @"Failed to normalize microphone audio."
                               }];
    }
    return nil;
  }

  return outputBuffer;
}

- (double)rmsForBuffer:(AVAudioPCMBuffer *)buffer {
  if (!buffer || buffer.frameLength == 0) {
    return 0;
  }

  switch (buffer.format.commonFormat) {
    case AVAudioPCMFormatFloat32: {
      float *channelData = buffer.floatChannelData ? buffer.floatChannelData[0] : NULL;
      if (!channelData) {
        return 0;
      }

      double energy = 0;
      for (AVAudioFrameCount index = 0; index < buffer.frameLength; index += 1) {
        double sample = channelData[index];
        energy += sample * sample;
      }
      return sqrt(energy / MAX((double)buffer.frameLength, 1.0));
    }
    case AVAudioPCMFormatInt16: {
      int16_t *channelData = buffer.int16ChannelData ? buffer.int16ChannelData[0] : NULL;
      if (!channelData) {
        return 0;
      }

      double energy = 0;
      for (AVAudioFrameCount index = 0; index < buffer.frameLength; index += 1) {
        double sample = ((double)channelData[index]) / 32768.0;
        energy += sample * sample;
      }
      return sqrt(energy / MAX((double)buffer.frameLength, 1.0));
    }
    case AVAudioPCMFormatInt32: {
      int32_t *channelData = buffer.int32ChannelData ? buffer.int32ChannelData[0] : NULL;
      if (!channelData) {
        return 0;
      }

      double energy = 0;
      for (AVAudioFrameCount index = 0; index < buffer.frameLength; index += 1) {
        double sample = ((double)channelData[index]) / 2147483648.0;
        energy += sample * sample;
      }
      return sqrt(energy / MAX((double)buffer.frameLength, 1.0));
    }
    default:
      return 0;
  }
}

- (void)acceptMicrophoneBuffer:(AVAudioPCMBuffer *)buffer {
  self.sttMicrophoneCallbackCount += 1;
  self.sttMicrophoneLastInputFrameLength = (NSInteger)buffer.frameLength;
  self.sttMicrophoneLastRawRms = [self rmsForBuffer:buffer];
  self.sttMicrophoneMaxRawRms =
      MAX(self.sttMicrophoneMaxRawRms, self.sttMicrophoneLastRawRms);

  AVAudioPCMBuffer *normalizedBuffer =
      [self normalizedBufferFromBuffer:buffer
                            sampleRate:self.sttMicrophoneSampleRate
                          targetFormat:self.sttMicrophoneTargetFormat
                                 error:nil];
  if (!normalizedBuffer || !normalizedBuffer.floatChannelData || normalizedBuffer.frameLength == 0) {
    return;
  }

  self.sttMicrophoneLastNormalizedRms = [self rmsForBuffer:normalizedBuffer];
  self.sttMicrophoneMaxNormalizedRms =
      MAX(self.sttMicrophoneMaxNormalizedRms, self.sttMicrophoneLastNormalizedRms);
  self.sttMicrophoneEmittedChunkCount += 1;

  AVAudioFrameCount frameLength = normalizedBuffer.frameLength;
  float *channelData = normalizedBuffer.floatChannelData[0];
  std::vector<float> samples(channelData, channelData + frameLength);
  NSInteger sessionId = self.sttMicrophoneSessionId;
  NSInteger sampleRate = self.sttMicrophoneSampleRate;

  dispatch_async(self.workQueue, ^{
    const SherpaOnnxOnlineStream *stream = [self streamForSessionId:sessionId];
    if (!stream || !self.onlineRecognizer || samples.empty()) {
      return;
    }

    SherpaOnnxOnlineStreamAcceptWaveform(stream, (int32_t)sampleRate, samples.data(),
                                         (int32_t)samples.size());
    while (SherpaOnnxIsOnlineStreamReady(self.onlineRecognizer, stream)) {
      SherpaOnnxDecodeOnlineStream(self.onlineRecognizer, stream);
    }
  });
}

- (void)resetSttMicrophoneState {
  self.sttMicrophoneAudioEngine = nil;
  self.sttMicrophoneTargetFormat = nil;
  self.sttMicrophoneStartedAt = nil;
  self.sttMicrophoneSessionId = 0;
  self.sttMicrophoneSampleRate = 0;
  self.sttMicrophoneCallbackCount = 0;
  self.sttMicrophoneEmittedChunkCount = 0;
  self.sttMicrophoneInputChannels = 0;
  self.sttMicrophoneLastInputFrameLength = 0;
  self.sttMicrophoneInputSampleRate = 0;
  self.sttMicrophoneLastRawRms = 0;
  self.sttMicrophoneLastNormalizedRms = 0;
  self.sttMicrophoneMaxRawRms = 0;
  self.sttMicrophoneMaxNormalizedRms = 0;
}

- (void)stopSttMicrophoneCapture {
  AVAudioEngine *audioEngine = self.sttMicrophoneAudioEngine;
  if (!audioEngine) {
    return;
  }

  [audioEngine.inputNode removeTapOnBus:0];
  [audioEngine stop];
  [self resetSttMicrophoneState];
}

- (void)resetSttMicrophoneRecordingState {
  self.sttMicrophoneRecorder = nil;
  self.sttMicrophoneRecordingURL = nil;
  self.sttMicrophoneRecordingStartedAt = nil;
  self.sttMicrophoneStopResolve = nil;
  self.sttMicrophoneStopReject = nil;
  self.sttMicrophoneRecordingSampleRate = 0;
}

- (void)removeRecordingAtURL:(NSURL *)recordingURL {
  if (!recordingURL) {
    return;
  }

  [[NSFileManager defaultManager] removeItemAtURL:recordingURL error:nil];
}

- (BOOL)beginSttMicrophoneRecordingWithSampleRate:(NSInteger)sampleRate
                                            error:(NSError **)error {
  if (![self configureSharedSessionForRecordingWithSampleRate:sampleRate error:error]) {
    return NO;
  }

  NSString *fileName =
      [NSString stringWithFormat:@"wfloat-stt-mic-%@.caf", NSUUID.UUID.UUIDString];
  NSURL *recordingURL =
      [NSURL fileURLWithPath:[NSTemporaryDirectory() stringByAppendingPathComponent:fileName]];
  NSDictionary *settings = @{
    AVFormatIDKey : @(kAudioFormatLinearPCM),
    AVSampleRateKey : @(sampleRate),
    AVNumberOfChannelsKey : @1,
    AVLinearPCMBitDepthKey : @32,
    AVLinearPCMIsFloatKey : @YES,
    AVLinearPCMIsBigEndianKey : @NO,
    AVLinearPCMIsNonInterleaved : @NO,
  };

  AVAudioRecorder *recorder = [[AVAudioRecorder alloc] initWithURL:recordingURL
                                                          settings:settings
                                                             error:error];
  if (!recorder) {
    return NO;
  }

  recorder.delegate = self;
  recorder.meteringEnabled = NO;
  if (![recorder prepareToRecord] || ![recorder record]) {
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:405
                               userInfo:@{
                                 NSLocalizedDescriptionKey :
                                     @"Failed to start STT microphone recording."
                               }];
    }
    return NO;
  }

  self.sttMicrophoneRecorder = recorder;
  self.sttMicrophoneRecordingURL = recordingURL;
  self.sttMicrophoneRecordingStartedAt = [NSDate date];
  self.sttMicrophoneRecordingSampleRate = sampleRate;
  return YES;
}

- (NSDictionary *)payloadForSttRecordingAtURL:(NSURL *)recordingURL
                                   sampleRate:(NSInteger)sampleRate
                                   durationMs:(NSInteger)durationMs
                                        error:(NSError **)error {
  AVAudioFile *audioFile = [[AVAudioFile alloc] initForReading:recordingURL error:error];
  if (!audioFile) {
    return nil;
  }

  AVAudioFrameCount frameCount =
      (AVAudioFrameCount)MAX((AVAudioFramePosition)1, audioFile.length);
  AVAudioPCMBuffer *buffer =
      [[AVAudioPCMBuffer alloc] initWithPCMFormat:audioFile.processingFormat
                                    frameCapacity:frameCount];
  if (!buffer || ![audioFile readIntoBuffer:buffer error:error]) {
    return nil;
  }

  AVAudioPCMBuffer *normalizedBuffer =
      [self normalizedBufferFromBuffer:buffer
                            sampleRate:sampleRate
                          targetFormat:nil
                                 error:error];
  if (!normalizedBuffer || !normalizedBuffer.floatChannelData) {
    return nil;
  }

  float *channelData = normalizedBuffer.floatChannelData[0];
  NSMutableArray<NSNumber *> *samples =
      [NSMutableArray arrayWithCapacity:normalizedBuffer.frameLength];
  for (AVAudioFrameCount index = 0; index < normalizedBuffer.frameLength; index += 1) {
    [samples addObject:@(channelData[index])];
  }

  return @{
    @"samples" : samples,
    @"sampleRate" : @(sampleRate),
    @"durationMs" : @(durationMs),
  };
}

- (BOOL)downloadURLString:(NSString *)urlString
                   toPath:(NSString *)destinationPath
                    error:(NSError **)error {
  NSURL *url = [NSURL URLWithString:urlString];
  if (!url) {
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:301
                               userInfo:@{NSLocalizedDescriptionKey : @"Invalid STT asset URL."}];
    }
    return NO;
  }

  NSData *data = [NSData dataWithContentsOfURL:url options:0 error:error];
  if (!data) {
    return NO;
  }

  NSString *parent = [destinationPath stringByDeletingLastPathComponent];
  if (![self ensureDirectoryExistsAtPath:parent error:error]) {
    return NO;
  }

  return [data writeToFile:destinationPath options:NSDataWritingAtomic error:error];
}

- (BOOL)loadOfflineWhisperWithEncoderPath:(NSString *)encoderPath
                              decoderPath:(NSString *)decoderPath
                               tokensPath:(NSString *)tokensPath
                                 language:(NSString *)language
                                     task:(NSString *)task
                                  modelId:(NSString *)modelId
                                    error:(NSError **)error {
  SherpaOnnxOfflineRecognizerConfig config;
  memset(&config, 0, sizeof(config));
  config.feat_config.sample_rate = 16000;
  config.feat_config.feature_dim = 80;
  config.model_config.whisper.encoder = encoderPath.UTF8String;
  config.model_config.whisper.decoder = decoderPath.UTF8String;
  config.model_config.whisper.language = language.UTF8String;
  config.model_config.whisper.task = task.UTF8String;
  config.model_config.whisper.tail_paddings = 1000;
  config.model_config.tokens = tokensPath.UTF8String;
  config.model_config.num_threads = 1;
  config.model_config.debug = 0;
  config.model_config.provider = "cpu";
  config.model_config.model_type = "whisper";
  config.decoding_method = "greedy_search";
  config.max_active_paths = 4;
  config.hotwords_score = 1.5f;
  config.blank_penalty = 0.0f;

  const SherpaOnnxOfflineRecognizer *recognizer =
      SherpaOnnxCreateOfflineRecognizer(&config);
  if (!recognizer) {
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:302
                               userInfo:@{
                                 NSLocalizedDescriptionKey : @"Failed to initialize offline STT model.",
                               }];
    }
    return NO;
  }

  if (self.offlineRecognizer) {
    SherpaOnnxDestroyOfflineRecognizer(self.offlineRecognizer);
  }
  if (self.onlineRecognizer) {
    SherpaOnnxDestroyOnlineRecognizer(self.onlineRecognizer);
    self.onlineRecognizer = nil;
  }

  [self closeAllSttSessions];
  self.offlineRecognizer = recognizer;
  self.loadedSttModelId = modelId;
  self.loadedSttFamily = @"whisper";
  return YES;
}

- (BOOL)loadStreamingZipformerWithEncoderPath:(NSString *)encoderPath
                                  decoderPath:(NSString *)decoderPath
                                   joinerPath:(NSString *)joinerPath
                                   tokensPath:(NSString *)tokensPath
                                      modelId:(NSString *)modelId
                                        error:(NSError **)error {
  SherpaOnnxOnlineRecognizerConfig config;
  memset(&config, 0, sizeof(config));
  config.feat_config.sample_rate = 16000;
  config.feat_config.feature_dim = 80;
  config.model_config.transducer.encoder = encoderPath.UTF8String;
  config.model_config.transducer.decoder = decoderPath.UTF8String;
  config.model_config.transducer.joiner = joinerPath.UTF8String;
  config.model_config.tokens = tokensPath.UTF8String;
  config.model_config.num_threads = 1;
  config.model_config.provider = "cpu";
  config.model_config.debug = 0;
  config.model_config.model_type = "zipformer";
  config.decoding_method = "greedy_search";
  config.max_active_paths = 4;
  config.enable_endpoint = 1;
  config.rule1_min_trailing_silence = 2.4f;
  config.rule2_min_trailing_silence = 1.4f;
  config.rule3_min_utterance_length = 20.0f;
  config.hotwords_score = 1.5f;
  config.blank_penalty = 0.0f;

  const SherpaOnnxOnlineRecognizer *recognizer =
      SherpaOnnxCreateOnlineRecognizer(&config);
  if (!recognizer) {
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:303
                               userInfo:@{
                                 NSLocalizedDescriptionKey : @"Failed to initialize streaming STT model.",
                               }];
    }
    return NO;
  }

  if (self.offlineRecognizer) {
    SherpaOnnxDestroyOfflineRecognizer(self.offlineRecognizer);
    self.offlineRecognizer = nil;
  }
  if (self.onlineRecognizer) {
    SherpaOnnxDestroyOnlineRecognizer(self.onlineRecognizer);
  }

  [self closeAllSttSessions];
  self.onlineRecognizer = recognizer;
  self.loadedSttModelId = modelId;
  self.loadedSttFamily = @"zipformer-transducer";
  return YES;
}

- (BOOL)loadVadWithModelPath:(NSString *)modelPath
                      family:(NSString *)family
                    modelId:(NSString *)modelId
                   threshold:(float)threshold
       minSilenceDurationSec:(float)minSilenceDurationSec
        minSpeechDurationSec:(float)minSpeechDurationSec
        maxSpeechDurationSec:(float)maxSpeechDurationSec
                       error:(NSError **)error {
  NSString *normalizedFamily = [[family lowercaseString] stringByReplacingOccurrencesOfString:@"_"
                                                                                   withString:@"-"];
  BOOL isSilero = [normalizedFamily isEqualToString:@"silero"] ||
      [normalizedFamily isEqualToString:@"silero-vad"];
  BOOL isTen = [normalizedFamily isEqualToString:@"ten-vad"] ||
      [normalizedFamily isEqualToString:@"tenvad"];
  if (!isSilero && !isTen) {
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:304
                               userInfo:@{
                                 NSLocalizedDescriptionKey :
                                     [NSString stringWithFormat:@"Unsupported VAD family: %@", family],
                               }];
    }
    return NO;
  }

  SherpaOnnxVadModelConfig config;
  memset(&config, 0, sizeof(config));
  if (isSilero) {
    config.silero_vad.model = modelPath.UTF8String;
    config.silero_vad.threshold = threshold;
    config.silero_vad.min_silence_duration = minSilenceDurationSec;
    config.silero_vad.min_speech_duration = minSpeechDurationSec;
    config.silero_vad.window_size = 512;
    config.silero_vad.max_speech_duration = maxSpeechDurationSec;
  } else {
    config.ten_vad.model = modelPath.UTF8String;
    config.ten_vad.threshold = threshold;
    config.ten_vad.min_silence_duration = minSilenceDurationSec;
    config.ten_vad.min_speech_duration = minSpeechDurationSec;
    config.ten_vad.window_size = 256;
    config.ten_vad.max_speech_duration = maxSpeechDurationSec;
  }
  config.sample_rate = 16000;
  config.num_threads = 1;
  config.provider = "cpu";
  config.debug = 0;

  const SherpaOnnxVoiceActivityDetector *detector =
      SherpaOnnxCreateVoiceActivityDetector(&config, 30.0f);
  if (!detector) {
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:305
                               userInfo:@{
                                 NSLocalizedDescriptionKey : @"Failed to initialize VAD model.",
                               }];
    }
    return NO;
  }

  if (self.vad) {
    SherpaOnnxDestroyVoiceActivityDetector(self.vad);
  }

  self.vad = detector;
  self.loadedVadModelId = modelId;
  self.loadedVadFamily = family;
  return YES;
}

- (NSDictionary *)offlineTranscriptionResultDictionary:
                    (const SherpaOnnxOfflineRecognizerResult *)result
                                              modelId:(NSString *)modelId {
  NSString* (^toString)(const char *) = ^NSString *(const char *value) {
    return value ? [NSString stringWithUTF8String:value] : @"";
  };

  NSMutableArray<NSDictionary *> *tokens = [NSMutableArray array];
  for (int32_t index = 0; index < result->count; index += 1) {
    const char *text = result->tokens_arr ? result->tokens_arr[index] : "";
    float startSec = result->timestamps ? result->timestamps[index] : 0;
    float durationSec = result->durations ? result->durations[index] : 0;
    float confidence = result->ys_log_probs ? result->ys_log_probs[index] : 0;
    [tokens addObject:@{
      @"text" : toString(text),
      @"startSec" : @(startSec),
      @"durationSec" : @(durationSec),
      @"confidence" : @(confidence),
    }];
  }

  NSMutableArray<NSDictionary *> *segments = [NSMutableArray array];
  for (int32_t index = 0; index < result->segment_count; index += 1) {
    const char *text = result->segment_texts_arr ? result->segment_texts_arr[index] : "";
    float startSec = result->segment_timestamps ? result->segment_timestamps[index] : 0;
    float durationSec = result->segment_durations ? result->segment_durations[index] : 0;
    [segments addObject:@{
      @"text" : toString(text),
      @"startSec" : @(startSec),
      @"durationSec" : @(durationSec),
    }];
  }

  return @{
    @"text" : toString(result->text),
    @"modelId" : modelId ?: @"",
    @"language" : toString(result->lang),
    @"emotion" : toString(result->emotion),
    @"event" : toString(result->event),
    @"json" : toString(result->json),
    @"tokens" : tokens,
    @"segments" : segments,
  };
}

- (NSDictionary *)streamingTranscriptionResultDictionary:
                    (const SherpaOnnxOnlineRecognizerResult *)result
                                             isEndpoint:(BOOL)isEndpoint
                                                modelId:(NSString *)modelId {
  NSString *text = result->text ? [NSString stringWithUTF8String:result->text] : @"";
  NSString *json = result->json ? [NSString stringWithUTF8String:result->json] : @"";
  return @{
    @"text" : text,
    @"modelId" : modelId ?: @"",
    @"isEndpoint" : @(isEndpoint),
    @"json" : json,
  };
}

- (NSArray<NSString *> *)stringArrayFromValue:(id)value {
  if (![value isKindOfClass:[NSArray class]]) {
    return @[];
  }

  NSMutableArray<NSString *> *result = [NSMutableArray array];
  for (id item in (NSArray *)value) {
    if ([item isKindOfClass:[NSString class]]) {
      [result addObject:item];
    }
  }

  return result;
}

- (NSDictionary *)preparedTextPayloadForText:(NSString *)text
                                     emotion:(NSString *)emotion
                                   intensity:(float)intensity
                                       error:(NSError **)error {
  const char *preparedTextCString =
      SherpaOnnxOfflineTtsWfloatPrepareText(self.tts,
                                            text.UTF8String,
                                            emotion.UTF8String,
                                            intensity);
  if (!preparedTextCString) {
    if (error) {
      *error = [NSError errorWithDomain:WfloatErrorDomain
                                   code:111
                               userInfo:@{
                                 NSLocalizedDescriptionKey :
                                     @"Failed to prepare the input text for speech synthesis.",
                               }];
    }
    return nil;
  }

  NSData *jsonData = [NSData dataWithBytes:preparedTextCString
                                    length:strlen(preparedTextCString)];
  SherpaOnnxOfflineTtsWfloatFreePreparedText(preparedTextCString);

  NSDictionary *payload = nil;
  id json = [NSJSONSerialization JSONObjectWithData:jsonData options:0 error:error];
  if ([json isKindOfClass:[NSDictionary class]]) {
    payload = json;
  }

  if (!payload && error && *error == nil) {
    *error = [NSError errorWithDomain:WfloatErrorDomain
                                 code:112
                             userInfo:@{
                               NSLocalizedDescriptionKey :
                                   @"Prepared speech text had an unexpected format.",
                             }];
  }

  return payload;
}

- (WfloatGenerateResult)generateSpeechForSession:(WfloatSpeechSession *)session
                                            text:(NSString *)text
                                             sid:(int32_t)sid
                                         emotion:(NSString *)emotion
                                       intensity:(float)intensity
                                           speed:(float)speed
                               silencePaddingSec:(float)silencePaddingSec
                                          result:(NSDictionary * _Nullable __autoreleasing *)result
                                           error:(NSError **)error {
  NSDictionary *preparedPayload = [self preparedTextPayloadForText:text
                                                           emotion:emotion
                                                         intensity:intensity
                                                             error:error];
  if (!preparedPayload) {
    return WfloatGenerateResultFailed;
  }

  NSArray<NSString *> *rawTextChunks = [self stringArrayFromValue:preparedPayload[@"text"]];
  NSArray<NSString *> *textCleanChunks =
      [self stringArrayFromValue:preparedPayload[@"text_clean"]];
  NSUInteger totalChunkCount = textCleanChunks.count;
  NSInteger rawTextCursor = 0;
  AVAudioFramePosition scheduledFrameCursor = 0;
  NSMutableArray<NSDictionary<NSString *, id> *> *timelineChunks = [NSMutableArray array];

  if (totalChunkCount == 0) {
    [session markGenerationComplete];
    if (result && !session.isCancelled) {
      *result = @{
        @"sampleRate" : @(session.sampleRate),
        @"durationSec" : @0,
        @"text" : text,
        @"timelineChunks" : @[],
      };
    }
    return session.isCancelled ? WfloatGenerateResultCancelled : WfloatGenerateResultCompleted;
  }

  for (NSUInteger index = 0; index < totalChunkCount; index += 1) {
    if (session.isCancelled || ![self isCurrentSpeechSession:session]) {
      return WfloatGenerateResultCancelled;
    }

    NSString *textClean = textCleanChunks[index];
    const SherpaOnnxGeneratedAudio *generatedAudio =
        SherpaOnnxOfflineTtsGenerate(self.tts, textClean.UTF8String, sid, speed);
    if (!generatedAudio) {
      if (error) {
        *error = [NSError errorWithDomain:WfloatErrorDomain
                                     code:113
                                 userInfo:@{
                                   NSLocalizedDescriptionKey :
                                       @"Failed to generate speech audio from the prepared text.",
                                 }];
      }
      return WfloatGenerateResultFailed;
    }

    NSString *rawChunkText = index < rawTextChunks.count ? rawTextChunks[index] : @"";
    NSInteger highlightStart = rawTextCursor;
    NSInteger highlightEnd = rawTextCursor + rawChunkText.length;
    rawTextCursor = highlightEnd;

    float chunkSilencePaddingSec = 0;
    if (index + 1 < totalChunkCount && silencePaddingSec > 0) {
      chunkSilencePaddingSec = silencePaddingSec;
    }

    AVAudioFramePosition chunkStartFrame = scheduledFrameCursor;
    AVAudioFramePosition chunkEndFrame = chunkStartFrame + generatedAudio->n;
    double chunkStartSec = WfloatFramesToSeconds(chunkStartFrame, session.sampleRate);
    double chunkEndSec = WfloatFramesToSeconds(chunkEndFrame, session.sampleRate);
    [timelineChunks addObject:@{
      @"index" : @(timelineChunks.count),
      @"text" : rawChunkText,
      @"textHighlightStart" : @(highlightStart),
      @"textHighlightEnd" : @(highlightEnd),
      @"startSec" : @(chunkStartSec),
      @"endSec" : @(chunkEndSec),
      @"durationSec" : @(chunkEndSec - chunkStartSec),
      @"progress" : @((double)(index + 1) / (double)totalChunkCount),
    }];
    scheduledFrameCursor = chunkEndFrame;

    NSError *scheduleError = nil;
    BOOL didSchedule = [session scheduleAudioSamples:generatedAudio->samples
                                          frameCount:generatedAudio->n
                                            progress:(double)(index + 1) / (double)totalChunkCount
                                                text:rawChunkText
                                      highlightStart:highlightStart
                                        highlightEnd:highlightEnd
                                    highlightSegment:-1
                                   silencePaddingSec:chunkSilencePaddingSec
                                               error:&scheduleError];
    SherpaOnnxDestroyOfflineTtsGeneratedAudio(generatedAudio);

    if (!didSchedule) {
      if (error) {
        *error = scheduleError;
      }
      return session.isCancelled ? WfloatGenerateResultCancelled : WfloatGenerateResultFailed;
    }

    if (chunkSilencePaddingSec > 0) {
      scheduledFrameCursor += (AVAudioFramePosition)llround(chunkSilencePaddingSec * session.sampleRate);
    }
  }

  [session markGenerationComplete];
  if (result && !session.isCancelled) {
    *result = @{
      @"sampleRate" : @(session.sampleRate),
      @"durationSec" : @(WfloatFramesToSeconds(scheduledFrameCursor, session.sampleRate)),
      @"text" : text,
      @"timelineChunks" : timelineChunks,
    };
  }
  return session.isCancelled ? WfloatGenerateResultCancelled : WfloatGenerateResultCompleted;
}

- (WfloatGenerateResult)generateDialogueForSession:(WfloatSpeechSession *)session
                                          segments:(NSArray<WfloatDialogueSegment *> *)segments
                         silenceBetweenSegmentsSec:(float)silenceBetweenSegmentsSec
                                            result:(NSDictionary * _Nullable __autoreleasing *)result
                                             error:(NSError **)error {
  NSMutableArray<WfloatPreparedDialogueSegment *> *preparedSegments =
      [NSMutableArray arrayWithCapacity:segments.count];
  NSUInteger totalChunkCount = 0;

  for (WfloatDialogueSegment *segment in segments) {
    if (session.isCancelled || ![self isCurrentSpeechSession:session]) {
      return WfloatGenerateResultCancelled;
    }

    NSDictionary *preparedPayload = [self preparedTextPayloadForText:segment.text
                                                             emotion:segment.emotion
                                                           intensity:segment.intensity
                                                               error:error];
    if (!preparedPayload) {
      return WfloatGenerateResultFailed;
    }

    WfloatPreparedDialogueSegment *preparedSegment =
        [[WfloatPreparedDialogueSegment alloc] init];
    preparedSegment.rawText = segment.text;
    preparedSegment.rawTextChunks = [self stringArrayFromValue:preparedPayload[@"text"]];
    preparedSegment.textCleanChunks =
        [self stringArrayFromValue:preparedPayload[@"text_clean"]];
    preparedSegment.sid = segment.sid;
    preparedSegment.speed = segment.speed;
    preparedSegment.sentenceSilencePaddingSec = segment.sentenceSilencePaddingSec;
    [preparedSegments addObject:preparedSegment];
    totalChunkCount += preparedSegment.textCleanChunks.count;
  }

  if (totalChunkCount == 0) {
    [session markGenerationComplete];
    if (result && !session.isCancelled) {
      NSMutableArray<NSString *> *texts = [NSMutableArray arrayWithCapacity:preparedSegments.count];
      for (WfloatPreparedDialogueSegment *segment in preparedSegments) {
        [texts addObject:segment.rawText ?: @""];
      }
      *result = @{
        @"sampleRate" : @(session.sampleRate),
        @"durationSec" : @0,
        @"text" : [texts componentsJoinedByString:@"\n"],
        @"timelineChunks" : @[],
      };
    }
    return session.isCancelled ? WfloatGenerateResultCancelled : WfloatGenerateResultCompleted;
  }

  NSMutableArray<NSNumber *> *segmentOffsets = [NSMutableArray arrayWithCapacity:preparedSegments.count];
  NSInteger segmentOffsetCursor = 0;
  NSMutableArray<NSString *> *dialogueTexts = [NSMutableArray arrayWithCapacity:preparedSegments.count];
  for (NSUInteger index = 0; index < preparedSegments.count; index += 1) {
    WfloatPreparedDialogueSegment *segment = preparedSegments[index];
    [segmentOffsets addObject:@(segmentOffsetCursor)];
    NSString *rawText = segment.rawText ?: @"";
    [dialogueTexts addObject:rawText];
    segmentOffsetCursor += rawText.length;
    if (index + 1 < preparedSegments.count) {
      segmentOffsetCursor += 1;
    }
  }

  NSUInteger progressIndex = 0;
  AVAudioFramePosition scheduledFrameCursor = 0;
  NSMutableArray<NSDictionary<NSString *, id> *> *timelineChunks = [NSMutableArray array];
  for (NSUInteger segmentIndex = 0; segmentIndex < preparedSegments.count; segmentIndex += 1) {
    WfloatPreparedDialogueSegment *segment = preparedSegments[segmentIndex];
    NSInteger rawTextCursor = 0;
    for (NSUInteger index = 0; index < segment.textCleanChunks.count; index += 1) {
      if (session.isCancelled || ![self isCurrentSpeechSession:session]) {
        return WfloatGenerateResultCancelled;
      }

      NSString *textClean = segment.textCleanChunks[index];
      const SherpaOnnxGeneratedAudio *generatedAudio =
          SherpaOnnxOfflineTtsGenerate(self.tts, textClean.UTF8String, segment.sid, segment.speed);
      if (!generatedAudio) {
        if (error) {
          *error = [NSError errorWithDomain:WfloatErrorDomain
                                       code:113
                                   userInfo:@{
                                     NSLocalizedDescriptionKey :
                                         @"Failed to generate speech audio from the prepared text.",
                                   }];
        }
        return WfloatGenerateResultFailed;
      }

      progressIndex += 1;
      NSString *rawChunkText = index < segment.rawTextChunks.count ? segment.rawTextChunks[index] : @"";
      NSInteger highlightStart = segmentOffsets[segmentIndex].integerValue + rawTextCursor;
      NSInteger highlightEnd = highlightStart + rawChunkText.length;
      rawTextCursor += rawChunkText.length;
      float silencePaddingSec = segment.sentenceSilencePaddingSec;
      if (index + 1 == segment.textCleanChunks.count) {
        silencePaddingSec = silenceBetweenSegmentsSec;
      }

      AVAudioFramePosition chunkStartFrame = scheduledFrameCursor;
      AVAudioFramePosition chunkEndFrame = chunkStartFrame + generatedAudio->n;
      double chunkStartSec = WfloatFramesToSeconds(chunkStartFrame, session.sampleRate);
      double chunkEndSec = WfloatFramesToSeconds(chunkEndFrame, session.sampleRate);
      [timelineChunks addObject:@{
        @"index" : @(timelineChunks.count),
        @"text" : rawChunkText,
        @"textHighlightStart" : @(highlightStart),
        @"textHighlightEnd" : @(highlightEnd),
        @"startSec" : @(chunkStartSec),
        @"endSec" : @(chunkEndSec),
        @"durationSec" : @(chunkEndSec - chunkStartSec),
        @"progress" : @((double)progressIndex / (double)totalChunkCount),
        @"textHighlightSegment" : @(segmentIndex),
      }];
      scheduledFrameCursor = chunkEndFrame;

      NSError *scheduleError = nil;
      BOOL didSchedule = [session scheduleAudioSamples:generatedAudio->samples
                                            frameCount:generatedAudio->n
                                              progress:(double)progressIndex / (double)totalChunkCount
                                                  text:rawChunkText
                                        highlightStart:highlightStart
                                          highlightEnd:highlightEnd
                                     highlightSegment:(NSInteger)segmentIndex
                                     silencePaddingSec:silencePaddingSec
                                                 error:&scheduleError];
      SherpaOnnxDestroyOfflineTtsGeneratedAudio(generatedAudio);

      if (!didSchedule) {
        if (error) {
          *error = scheduleError;
        }
        return session.isCancelled ? WfloatGenerateResultCancelled : WfloatGenerateResultFailed;
      }

      if (silencePaddingSec > 0) {
        scheduledFrameCursor += (AVAudioFramePosition)llround(silencePaddingSec * session.sampleRate);
      }
    }
  }

  [session markGenerationComplete];
  if (result && !session.isCancelled) {
    *result = @{
      @"sampleRate" : @(session.sampleRate),
      @"durationSec" : @(WfloatFramesToSeconds(scheduledFrameCursor, session.sampleRate)),
      @"text" : [dialogueTexts componentsJoinedByString:@"\n"],
      @"timelineChunks" : timelineChunks,
    };
  }
  return session.isCancelled ? WfloatGenerateResultCancelled : WfloatGenerateResultCompleted;
}

- (void)cleanupStaleFilesInDirectory:(NSString *)directoryPath
                    activeFileNames:(NSSet<NSString *> *)activeFileNames {
  NSError *contentsError = nil;
  NSArray<NSString *> *fileNames =
      [[NSFileManager defaultManager] contentsOfDirectoryAtPath:directoryPath error:&contentsError];
  if (contentsError || fileNames.count == 0) {
    return;
  }

  for (NSString *fileName in fileNames) {
    if ([activeFileNames containsObject:fileName]) {
      continue;
    }

    if (![fileName hasSuffix:@".onnx"] && ![fileName hasSuffix:@"_tokens.txt"]) {
      continue;
    }

    NSString *path = [directoryPath stringByAppendingPathComponent:fileName];
    [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
  }
}

- (void)cleanupStaleEspeakDirectoriesKeepingCurrent:(NSString *)activeDirectoryPath {
  NSString *directoryPath = WfloatEspeakCacheRootDirectory();
  NSString *activeDirectoryName = activeDirectoryPath.lastPathComponent;
  NSError *contentsError = nil;
  NSArray<NSString *> *fileNames =
      [[NSFileManager defaultManager] contentsOfDirectoryAtPath:directoryPath error:&contentsError];
  if (contentsError || fileNames.count == 0) {
    return;
  }

  for (NSString *fileName in fileNames) {
    if ([fileName isEqualToString:activeDirectoryName]) {
      continue;
    }

    NSString *path = [directoryPath stringByAppendingPathComponent:fileName];
    BOOL isDirectory = NO;
    if ([[NSFileManager defaultManager] fileExistsAtPath:path isDirectory:&isDirectory] &&
        isDirectory) {
      [[NSFileManager defaultManager] removeItemAtPath:path error:nil];
    }
  }
}

- (double)overallProgressForPhaseProgress:(double)phaseProgress {
  double clampedPhaseProgress = MIN(MAX(phaseProgress, 0), 1);
  if (self.totalPlannedDownloadCount > 0) {
    return (self.completedDownloadCount + clampedPhaseProgress) /
        (double)self.totalPlannedDownloadCount;
  }

  return clampedPhaseProgress;
}

- (void)emitDownloadProgress:(double)phaseProgress {
  double overallProgress = [self overallProgressForPhaseProgress:phaseProgress];
  if (fabs(self.lastEmittedDownloadProgress - overallProgress) < 0.01 &&
      overallProgress < 1.0f) {
    return;
  }

  self.lastEmittedDownloadProgress = overallProgress;
  [self emitLoadModelProgressWithStatus:@"downloading" progress:@(overallProgress)];
}

- (void)finishPendingLoadModel {
  NSString *dataDir = self.pendingEspeakDirectoryPath;
  if (![self isInstalledEspeakDirectoryAtPath:dataDir]) {
    [self rejectPendingLoadModelWithCode:@"missing_espeak_data"
                                 message:@"espeak-ng-data is not installed."
                                   error:nil];
    return;
  }

  [self cancelCurrentSpeechSession];
  [self emitLoadModelProgressWithStatus:@"loading" progress:nil];

  dispatch_async(self.workQueue, ^{
    NSError *loadError = nil;
    BOOL didLoad = [self loadTtsWithModelPath:self.pendingModelPath
                                   tokensPath:self.pendingTokensPath
                                      dataDir:dataDir
                                      modelId:self.pendingModelId
                                        error:&loadError];

    dispatch_async(dispatch_get_main_queue(), ^{
      if (!didLoad) {
        [self rejectPendingLoadModelWithCode:@"load_failed"
                                     message:loadError.localizedDescription ?: @"Failed to load model."
                                       error:loadError];
        return;
      }

      NSString *directoryPath = [self.pendingModelPath stringByDeletingLastPathComponent];
      NSSet<NSString *> *activeFileNames = [NSSet setWithObjects:
                                                           self.pendingModelPath.lastPathComponent,
                                                           self.pendingTokensPath.lastPathComponent,
                                                           nil];
      [self cleanupStaleFilesInDirectory:directoryPath activeFileNames:activeFileNames];
      [self cleanupStaleEspeakDirectoriesKeepingCurrent:self.pendingEspeakDirectoryPath];
      [self emitLoadModelProgressWithStatus:@"completed" progress:nil];
      [self resolvePendingLoadModel];
    });
  });
}

- (void)startDownloadFromURLString:(NSString *)urlString
                   destinationPath:(NSString *)destinationPath
                             phase:(WfloatLoadModelDownloadPhase)phase {
  NSURL *url = [NSURL URLWithString:urlString];
  if (!url) {
    [self rejectPendingLoadModelWithCode:@"invalid_url" message:@"Invalid model asset URL." error:nil];
    return;
  }

  if (!self.loadModelSession) {
    NSURLSessionConfiguration *configuration = [NSURLSessionConfiguration defaultSessionConfiguration];
    NSOperationQueue *delegateQueue = [[NSOperationQueue alloc] init];
    delegateQueue.maxConcurrentOperationCount = 1;
    self.loadModelSession = [NSURLSession sessionWithConfiguration:configuration
                                                          delegate:self
                                                     delegateQueue:delegateQueue];
  }

  self.currentDownloadPhase = phase;
  self.currentDownloadDestinationPath = destinationPath;
  self.lastEmittedDownloadProgress = -1;
  [self emitDownloadProgress:0];

  NSURLSessionDownloadTask *task = [self.loadModelSession downloadTaskWithURL:url];
  [task resume];
}

- (void)startNextPendingDownloadStep {
  if (self.pendingNeedsModelDownload) {
    [self startDownloadFromURLString:self.pendingModelURLString
                     destinationPath:self.pendingModelPath
                               phase:WfloatLoadModelDownloadPhaseModel];
    return;
  }

  if (self.pendingNeedsTokensDownload) {
    [self startDownloadFromURLString:self.pendingTokensURLString
                     destinationPath:self.pendingTokensPath
                               phase:WfloatLoadModelDownloadPhaseTokens];
    return;
  }

  if (self.pendingNeedsEspeakDownload) {
    [self startDownloadFromURLString:self.pendingEspeakDataURLString
                     destinationPath:self.pendingEspeakArchivePath
                               phase:WfloatLoadModelDownloadPhaseEspeakData];
    return;
  }

  [self finishPendingLoadModel];
}

- (void)loadSttModel:(JS::NativeWfloat::LoadSttModelNativeOptions &)options
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  NSString *modelId = options.modelId();
  NSString *family = options.family();
  NSString *tokensURL = options.tokensUrl() ?: @"";
  NSString *encoderURL = options.encoderUrl() ?: @"";
  NSString *decoderURL = options.decoderUrl() ?: @"";
  NSString *joinerURL = options.joinerUrl() ?: @"";
  NSString *language = options.language().length > 0 ? options.language() : @"en";
  NSString *task = options.task().length > 0 ? options.task() : @"transcribe";
  if (modelId.length == 0 || family.length == 0) {
    reject(@"invalid_arguments", @"modelId and family are required.", nil);
    return;
  }

  if (self.loadModelResolve != nil || self.loadModelReject != nil || self.sttLoadInProgress) {
    reject(@"load_in_progress", @"A loadModel operation is already in progress.", nil);
    return;
  }

  self.sttLoadInProgress = YES;

  dispatch_async(self.workQueue, ^{
    @autoreleasepool {
      __block NSError *filesystemError = nil;
      NSString *directoryPath = [self cacheDirectoryForModelId:modelId];
        if (![self ensureDirectoryExistsAtPath:directoryPath error:&filesystemError]) {
          dispatch_async(dispatch_get_main_queue(), ^{
            self.sttLoadInProgress = NO;
            reject(@"filesystem_error", filesystemError.localizedDescription, filesystemError);
          });
          return;
        }

      NSMutableArray<NSDictionary *> *downloads = [NSMutableArray array];
      auto addDownload = ^(NSString *label, NSString *urlString) {
        if (urlString.length == 0) {
          return;
        }

        NSError *pathError = nil;
        NSString *fileName = [self fileNameFromURLString:urlString error:&pathError];
        if (pathError) {
          filesystemError = pathError;
          return;
        }

        [downloads addObject:@{
          @"label" : label,
          @"url" : urlString,
          @"path" : [directoryPath stringByAppendingPathComponent:fileName],
        }];
      };

      if ([family isEqualToString:@"whisper"]) {
        addDownload(@"tokens", tokensURL);
        addDownload(@"encoder", encoderURL);
        addDownload(@"decoder", decoderURL);
      } else if ([family isEqualToString:@"zipformer-transducer"]) {
        addDownload(@"tokens", tokensURL);
        addDownload(@"encoder", encoderURL);
        addDownload(@"decoder", decoderURL);
        addDownload(@"joiner", joinerURL);
      } else {
        dispatch_async(dispatch_get_main_queue(), ^{
          self.sttLoadInProgress = NO;
          reject(@"invalid_arguments",
                 [NSString stringWithFormat:@"Unsupported STT family: %@", family],
                 nil);
        });
        return;
      }

      if (filesystemError) {
        dispatch_async(dispatch_get_main_queue(), ^{
          self.sttLoadInProgress = NO;
          reject(@"invalid_url", filesystemError.localizedDescription, filesystemError);
        });
        return;
      }

      NSUInteger totalPlannedDownloadCount = 0;
      for (NSDictionary *entry in downloads) {
        if (![[NSFileManager defaultManager] fileExistsAtPath:entry[@"path"]]) {
          totalPlannedDownloadCount += 1;
        }
      }

      __block NSUInteger completedDownloadCount = 0;
      __block double lastEmittedProgress = -1;
      void (^emitProgress)(double) = ^(double phaseProgress) {
        double clamped = MIN(MAX(phaseProgress, 0), 1);
        double overallProgress = totalPlannedDownloadCount > 0
                                     ? (completedDownloadCount + clamped) / (double)totalPlannedDownloadCount
                                     : clamped;
        if (overallProgress < 1.0 && fabs(lastEmittedProgress - overallProgress) < 0.01) {
          return;
        }
        lastEmittedProgress = overallProgress;
        dispatch_async(dispatch_get_main_queue(), ^{
          [self emitLoadModelProgressWithStatus:@"downloading" progress:@(overallProgress)];
        });
      };

      for (NSDictionary *entry in downloads) {
        NSString *path = entry[@"path"];
        if ([[NSFileManager defaultManager] fileExistsAtPath:path]) {
          continue;
        }

        emitProgress(0.0);
        NSError *downloadError = nil;
        if (![self downloadURLString:entry[@"url"] toPath:path error:&downloadError]) {
          dispatch_async(dispatch_get_main_queue(), ^{
            self.sttLoadInProgress = NO;
            reject(@"download_failed",
                   downloadError.localizedDescription ?: @"Failed to download STT asset.",
                   downloadError);
          });
          return;
        }
        completedDownloadCount += 1;
        emitProgress(1.0);
      }

      dispatch_async(dispatch_get_main_queue(), ^{
        [self emitLoadModelProgressWithStatus:@"loading" progress:nil];
      });

      NSDictionary *resolved = [NSDictionary dictionaryWithObjectsAndKeys:
        @"", @"tokens",
        @"", @"encoder",
        @"", @"decoder",
        @"", @"joiner",
        nil];
      NSMutableDictionary *resolvedMutable = [resolved mutableCopy];
      for (NSDictionary *entry in downloads) {
        resolvedMutable[entry[@"label"]] = entry[@"path"];
      }

      NSError *loadError = nil;
      BOOL didLoad = NO;
      if ([family isEqualToString:@"whisper"]) {
        didLoad = [self loadOfflineWhisperWithEncoderPath:resolvedMutable[@"encoder"]
                                              decoderPath:resolvedMutable[@"decoder"]
                                               tokensPath:resolvedMutable[@"tokens"]
                                                 language:language
                                                     task:task
                                                  modelId:modelId
                                                    error:&loadError];
      } else {
        didLoad = [self loadStreamingZipformerWithEncoderPath:resolvedMutable[@"encoder"]
                                                  decoderPath:resolvedMutable[@"decoder"]
                                                   joinerPath:resolvedMutable[@"joiner"]
                                                   tokensPath:resolvedMutable[@"tokens"]
                                                      modelId:modelId
                                                        error:&loadError];
      }

      dispatch_async(dispatch_get_main_queue(), ^{
        if (!didLoad) {
          self.sttLoadInProgress = NO;
          reject(@"load_failed", loadError.localizedDescription ?: @"Failed to load STT model.", loadError);
          return;
        }

        [self emitLoadModelProgressWithStatus:@"completed" progress:nil];
        self.sttLoadInProgress = NO;
        resolve(@{
          @"family" : family,
          @"supportsStreaming" : @([family isEqualToString:@"zipformer-transducer"]),
        });
      });
    }
  });
}

- (void)transcribe:(JS::NativeWfloat::TranscribeNativeOptions &)options
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject {
  if (!self.offlineRecognizer && self.onlineRecognizer) {
    reject(@"invalid_model_mode",
           @"The loaded STT model supports streaming sessions only. Use createSession() instead of transcribe().",
           nil);
    return;
  }

  if (!self.offlineRecognizer || self.loadedSttModelId.length == 0) {
    reject(@"not_loaded", @"STT model is not loaded. Call loadSttModel(...) first.", nil);
    return;
  }

  double sampleRateValue = options.sampleRate();
  if (!isfinite(sampleRateValue) || sampleRateValue <= 0 ||
      floor(sampleRateValue) != sampleRateValue) {
    reject(@"invalid_arguments", @"sampleRate must be a positive integer.", nil);
    return;
  }

  auto nativeSamples = options.samples();
  if (nativeSamples.size() == 0) {
    reject(@"invalid_arguments", @"samples is required.", nil);
    return;
  }

  std::vector<float> samples;
  samples.reserve(nativeSamples.size());
  for (facebook::react::LazyVector<double>::size_type index = 0; index < nativeSamples.size();
       index += 1) {
    double value = nativeSamples[index];
    if (!isfinite(value)) {
      reject(@"invalid_arguments", @"samples must contain only finite numbers.", nil);
      return;
    }
    samples.push_back((float)value);
  }

  dispatch_async(self.workQueue, ^{
    const SherpaOnnxOfflineStream *stream = SherpaOnnxCreateOfflineStream(self.offlineRecognizer);
    if (!stream) {
      dispatch_async(dispatch_get_main_queue(), ^{
        reject(@"transcribe_failed", @"Failed to create offline STT stream.", nil);
      });
      return;
    }

    SherpaOnnxAcceptWaveformOffline(stream, (int32_t)sampleRateValue, samples.data(), (int32_t)samples.size());
    SherpaOnnxDecodeOfflineStream(self.offlineRecognizer, stream);
    const SherpaOnnxOfflineRecognizerResult *result = SherpaOnnxGetOfflineStreamResult(stream);

    NSDictionary *payload = result
        ? [self offlineTranscriptionResultDictionary:result modelId:self.loadedSttModelId]
        : nil;

    if (result) {
      SherpaOnnxDestroyOfflineRecognizerResult(result);
    }
    SherpaOnnxDestroyOfflineStream(stream);

    dispatch_async(dispatch_get_main_queue(), ^{
      if (!payload) {
        reject(@"transcribe_failed", @"Failed to transcribe audio.", nil);
        return;
      }
      resolve(payload);
    });
  });
}

- (void)loadVadModel:(JS::NativeWfloat::LoadVadModelNativeOptions &)options
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  NSString *modelId = options.modelId();
  NSString *family = options.family();
  NSString *modelURL = options.modelUrl();
  double thresholdValue = options.threshold();
  double minSilenceDurationValue = options.minSilenceDurationSec();
  double minSpeechDurationValue = options.minSpeechDurationSec();
  double maxSpeechDurationValue = options.maxSpeechDurationSec();
  if (modelId.length == 0 || family.length == 0 || modelURL.length == 0) {
    reject(@"invalid_arguments", @"modelId, family, and modelUrl are required.", nil);
    return;
  }

  if (!isfinite(thresholdValue) || !isfinite(minSilenceDurationValue) ||
      !isfinite(minSpeechDurationValue) || !isfinite(maxSpeechDurationValue)) {
    reject(@"invalid_arguments", @"VAD timing options must be finite numbers.", nil);
    return;
  }

  if (self.loadModelResolve != nil || self.loadModelReject != nil || self.sttLoadInProgress) {
    reject(@"load_in_progress", @"A loadModel operation is already in progress.", nil);
    return;
  }

  self.sttLoadInProgress = YES;

  dispatch_async(self.workQueue, ^{
    @autoreleasepool {
      NSError *filesystemError = nil;
      NSString *directoryPath = [self cacheDirectoryForModelId:modelId];
      if (![self ensureDirectoryExistsAtPath:directoryPath error:&filesystemError]) {
        dispatch_async(dispatch_get_main_queue(), ^{
          self.sttLoadInProgress = NO;
          reject(@"filesystem_error", filesystemError.localizedDescription, filesystemError);
        });
        return;
      }

      NSString *fileName = [self fileNameFromURLString:modelURL error:&filesystemError];
      if (filesystemError || fileName.length == 0) {
        dispatch_async(dispatch_get_main_queue(), ^{
          self.sttLoadInProgress = NO;
          reject(@"invalid_url", filesystemError.localizedDescription, filesystemError);
        });
        return;
      }

      NSString *modelPath = [directoryPath stringByAppendingPathComponent:fileName];
      if (![[NSFileManager defaultManager] fileExistsAtPath:modelPath]) {
        dispatch_async(dispatch_get_main_queue(), ^{
          [self emitLoadModelProgressWithStatus:@"downloading" progress:@0];
        });
        NSError *downloadError = nil;
        if (![self downloadURLString:modelURL toPath:modelPath error:&downloadError]) {
          dispatch_async(dispatch_get_main_queue(), ^{
            self.sttLoadInProgress = NO;
            reject(@"download_failed",
                   downloadError.localizedDescription ?: @"Failed to download VAD asset.",
                   downloadError);
          });
          return;
        }
        dispatch_async(dispatch_get_main_queue(), ^{
          [self emitLoadModelProgressWithStatus:@"downloading" progress:@1];
        });
      }

      dispatch_async(dispatch_get_main_queue(), ^{
        [self emitLoadModelProgressWithStatus:@"loading" progress:nil];
      });

      NSError *loadError = nil;
      BOOL didLoad = [self loadVadWithModelPath:modelPath
                                         family:family
                                        modelId:modelId
                                      threshold:(float)thresholdValue
                          minSilenceDurationSec:(float)minSilenceDurationValue
                           minSpeechDurationSec:(float)minSpeechDurationValue
                           maxSpeechDurationSec:(float)maxSpeechDurationValue
                                          error:&loadError];

      dispatch_async(dispatch_get_main_queue(), ^{
        if (!didLoad) {
          self.sttLoadInProgress = NO;
          reject(@"load_failed", loadError.localizedDescription ?: @"Failed to load VAD model.", loadError);
          return;
        }

        [self emitLoadModelProgressWithStatus:@"completed" progress:nil];
        self.sttLoadInProgress = NO;
        resolve(@{@"family" : family});
      });
    }
  });
}

- (void)detectVad:(JS::NativeWfloat::VadDetectNativeOptions &)options
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  if (!self.vad || self.loadedVadModelId.length == 0) {
    reject(@"not_loaded", @"VAD model is not loaded. Call loadVadModel(...) first.", nil);
    return;
  }

  double sampleRateValue = options.sampleRate();
  if (!isfinite(sampleRateValue) || sampleRateValue <= 0 ||
      floor(sampleRateValue) != sampleRateValue) {
    reject(@"invalid_arguments", @"sampleRate must be a positive integer.", nil);
    return;
  }

  auto nativeSamples = options.samples();
  std::vector<float> samples;
  samples.reserve(nativeSamples.size());
  for (facebook::react::LazyVector<double>::size_type index = 0; index < nativeSamples.size();
       index += 1) {
    double value = nativeSamples[index];
    if (!isfinite(value)) {
      reject(@"invalid_arguments", @"samples must contain only finite numbers.", nil);
      return;
    }
    samples.push_back((float)value);
  }

  dispatch_async(self.workQueue, ^{
    SherpaOnnxVoiceActivityDetectorReset(self.vad);
    int32_t windowSize = [self.loadedVadFamily.lowercaseString containsString:@"ten"] ? 256 : 512;
    for (size_t offset = 0; offset < samples.size(); offset += windowSize) {
      size_t count = MIN((size_t)windowSize, samples.size() - offset);
      SherpaOnnxVoiceActivityDetectorAcceptWaveform(
          self.vad, samples.data() + offset, (int32_t)count);
    }
    SherpaOnnxVoiceActivityDetectorFlush(self.vad);

    NSMutableArray<NSDictionary *> *segments = [NSMutableArray array];
    int32_t speechSampleCount = 0;
    while (SherpaOnnxVoiceActivityDetectorEmpty(self.vad) == 0) {
      const SherpaOnnxSpeechSegment *segment = SherpaOnnxVoiceActivityDetectorFront(self.vad);
      if (segment) {
        NSMutableArray<NSNumber *> *audio = [NSMutableArray arrayWithCapacity:segment->n];
        for (int32_t index = 0; index < segment->n; index += 1) {
          [audio addObject:@(segment->samples[index])];
        }
        speechSampleCount += segment->n;
        [segments addObject:@{
          @"startSec" : @((double)segment->start / sampleRateValue),
          @"durationSec" : @((double)segment->n / sampleRateValue),
          @"endSec" : @((double)(segment->start + segment->n) / sampleRateValue),
          @"startSample" : @(segment->start),
          @"sampleCount" : @(segment->n),
          @"sampleRate" : @(sampleRateValue),
          @"audio" : audio,
        }];
        SherpaOnnxDestroySpeechSegment(segment);
      }
      SherpaOnnxVoiceActivityDetectorPop(self.vad);
    }

    NSDictionary *payload = @{
      @"modelId" : self.loadedVadModelId ?: @"",
      @"segments" : segments,
      @"speechRatio" : samples.size() > 0
          ? @(MIN((double)speechSampleCount / (double)samples.size(), 1.0))
          : @0,
    };

    dispatch_async(dispatch_get_main_queue(), ^{
      resolve(payload);
    });
  });
}

- (void)startSttMicrophoneRecording:(JS::NativeWfloat::SttMicrophoneRecordingNativeOptions &)options
                             resolve:(RCTPromiseResolveBlock)resolve
                              reject:(RCTPromiseRejectBlock)reject {
  double sampleRateValue = options.sampleRate();
  if (!isfinite(sampleRateValue) || sampleRateValue <= 0 ||
      floor(sampleRateValue) != sampleRateValue) {
    reject(@"invalid_arguments", @"sampleRate must be a positive integer.", nil);
    return;
  }

  if (self.sttMicrophoneRecorder || self.sttMicrophoneAudioEngine) {
    reject(@"microphone_in_use", @"A STT microphone capture is already in progress.", nil);
    return;
  }

  NSInteger sampleRate = (NSInteger)sampleRateValue;
  [self ensureRecordPermission:^(BOOL granted) {
    if (!granted) {
      reject(@"microphone_permission_denied",
             @"Microphone access is required to record STT audio.",
             nil);
      return;
    }

    NSError *startError = nil;
    if (![self beginSttMicrophoneRecordingWithSampleRate:sampleRate error:&startError]) {
      [self resetSttMicrophoneRecordingState];
      reject(@"microphone_start_failed",
             startError.localizedDescription ?: @"Failed to start STT microphone recording.",
             startError);
      return;
    }

    resolve(nil);
  }];
}

- (void)stopSttMicrophoneRecording:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject {
  if (!self.sttMicrophoneRecorder || !self.sttMicrophoneRecorder.isRecording) {
    reject(@"not_recording", @"No STT microphone recording is currently in progress.", nil);
    return;
  }

  if (self.sttMicrophoneStopResolve || self.sttMicrophoneStopReject) {
    reject(@"capture_in_progress", @"A microphone recording stop request is already pending.", nil);
    return;
  }

  self.sttMicrophoneStopResolve = resolve;
  self.sttMicrophoneStopReject = reject;
  [self.sttMicrophoneRecorder stop];
}

- (void)audioRecorderDidFinishRecording:(AVAudioRecorder *)recorder
                           successfully:(BOOL)flag {
  if (recorder != self.sttMicrophoneRecorder) {
    return;
  }

  NSURL *recordingURL = self.sttMicrophoneRecordingURL;
  NSInteger sampleRate = self.sttMicrophoneRecordingSampleRate;
  NSInteger durationMs =
      self.sttMicrophoneRecordingStartedAt
          ? MAX(1, (NSInteger)llround(-self.sttMicrophoneRecordingStartedAt.timeIntervalSinceNow *
                                      1000.0))
          : 0;
  RCTPromiseResolveBlock resolve = self.sttMicrophoneStopResolve;
  RCTPromiseRejectBlock reject = self.sttMicrophoneStopReject;

  [self resetSttMicrophoneRecordingState];

  if (!recordingURL) {
    if (reject) {
      reject(@"microphone_finish_failed",
             @"STT microphone recording did not finish successfully.",
             nil);
    }
    return;
  }

  if (!flag) {
    if (reject) {
      reject(@"microphone_finish_failed",
             @"STT microphone recording did not finish successfully.",
             nil);
    }
    [self removeRecordingAtURL:recordingURL];
    return;
  }

  NSError *readError = nil;
  NSDictionary *payload = [self payloadForSttRecordingAtURL:recordingURL
                                                 sampleRate:sampleRate
                                                 durationMs:durationMs
                                                      error:&readError];
  [self removeRecordingAtURL:recordingURL];
  if (!payload) {
    if (reject) {
      reject(@"microphone_read_failed",
             readError.localizedDescription ?: @"Failed to read STT microphone recording.",
             readError);
    }
    return;
  }

  if (resolve) {
    resolve(payload);
  }
}

- (void)audioRecorderEncodeErrorDidOccur:(AVAudioRecorder *)recorder
                                   error:(NSError *)error {
  if (recorder != self.sttMicrophoneRecorder) {
    return;
  }

  NSURL *recordingURL = self.sttMicrophoneRecordingURL;
  RCTPromiseRejectBlock reject = self.sttMicrophoneStopReject;
  [self resetSttMicrophoneRecordingState];
  [self removeRecordingAtURL:recordingURL];

  if (reject) {
    reject(@"microphone_record_failed",
           error.localizedDescription ?: @"STT microphone recording failed.",
           error);
  }
}

- (void)createSttSession:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  if (!self.onlineRecognizer || self.loadedSttModelId.length == 0) {
    reject(@"not_loaded",
           @"Streaming STT model is not loaded. Call loadSttModel(...) with a streaming-capable model first.",
           nil);
    return;
  }

  dispatch_async(self.workQueue, ^{
    const SherpaOnnxOnlineStream *stream = SherpaOnnxCreateOnlineStream(self.onlineRecognizer);
    if (!stream) {
      dispatch_async(dispatch_get_main_queue(), ^{
        reject(@"session_create_failed", @"Failed to create STT session.", nil);
      });
      return;
    }

    if (self.nextSttSessionId <= 0) {
      self.nextSttSessionId = 1;
    }
    NSInteger sessionId = self.nextSttSessionId;
    self.nextSttSessionId += 1;
    self.sttSessions[@(sessionId)] = [NSValue valueWithPointer:stream];
    dispatch_async(dispatch_get_main_queue(), ^{
      resolve(@(sessionId));
    });
  });
}

- (void)pushSttSessionAudio:(JS::NativeWfloat::PushSttSessionAudioNativeOptions &)options
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject {
  if (!self.onlineRecognizer) {
    reject(@"not_loaded", @"Streaming STT model is not loaded.", nil);
    return;
  }

  double sessionIdValue = options.sessionId();
  double sampleRateValue = options.sampleRate();
  if (!isfinite(sessionIdValue) || sessionIdValue < 0 || floor(sessionIdValue) != sessionIdValue ||
      !isfinite(sampleRateValue) || sampleRateValue <= 0 || floor(sampleRateValue) != sampleRateValue) {
    reject(@"invalid_arguments", @"sessionId and sampleRate must be positive integers.", nil);
    return;
  }

  auto nativeSamples = options.samples();
  std::vector<float> samples;
  samples.reserve(nativeSamples.size());
  for (facebook::react::LazyVector<double>::size_type index = 0; index < nativeSamples.size();
       index += 1) {
    double value = nativeSamples[index];
    if (!isfinite(value)) {
      reject(@"invalid_arguments", @"samples must contain only finite numbers.", nil);
      return;
    }
    samples.push_back((float)value);
  }

  dispatch_async(self.workQueue, ^{
    const SherpaOnnxOnlineStream *stream = [self streamForSessionId:(NSInteger)sessionIdValue];
    if (!stream) {
      dispatch_async(dispatch_get_main_queue(), ^{
        reject(@"invalid_arguments", @"Unknown STT session.", nil);
      });
      return;
    }

    SherpaOnnxOnlineStreamAcceptWaveform(stream, (int32_t)sampleRateValue, samples.data(),
                                         (int32_t)samples.size());
    while (SherpaOnnxIsOnlineStreamReady(self.onlineRecognizer, stream)) {
      SherpaOnnxDecodeOnlineStream(self.onlineRecognizer, stream);
    }

    dispatch_async(dispatch_get_main_queue(), ^{
      resolve(nil);
    });
  });
}

- (void)startSttSessionMicrophone:(JS::NativeWfloat::SttSessionMicrophoneNativeOptions &)options
                           resolve:(RCTPromiseResolveBlock)resolve
                            reject:(RCTPromiseRejectBlock)reject {
  if (!self.onlineRecognizer || self.loadedSttModelId.length == 0) {
    reject(@"not_loaded", @"Streaming STT model is not loaded.", nil);
    return;
  }

  double sessionIdValue = options.sessionId();
  double sampleRateValue = options.sampleRate();
  double chunkMsValue = options.chunkMs();
  if (!isfinite(sessionIdValue) || sessionIdValue < 0 || floor(sessionIdValue) != sessionIdValue ||
      !isfinite(sampleRateValue) || sampleRateValue <= 0 || floor(sampleRateValue) != sampleRateValue ||
      !isfinite(chunkMsValue) || chunkMsValue <= 0 || floor(chunkMsValue) != chunkMsValue) {
    reject(@"invalid_arguments", @"sessionId, sampleRate, and chunkMs must be positive integers.", nil);
    return;
  }

  if (self.sttMicrophoneAudioEngine || self.sttMicrophoneRecorder) {
    reject(@"microphone_in_use", @"A streaming STT microphone capture is already in progress.", nil);
    return;
  }

  NSInteger sessionId = (NSInteger)sessionIdValue;
  NSInteger sampleRate = (NSInteger)sampleRateValue;
  NSInteger chunkMs = (NSInteger)chunkMsValue;

  dispatch_async(self.workQueue, ^{
    const SherpaOnnxOnlineStream *stream = [self streamForSessionId:sessionId];
    dispatch_async(dispatch_get_main_queue(), ^{
      if (!stream) {
        reject(@"invalid_arguments", @"Unknown STT session.", nil);
        return;
      }

      [self ensureRecordPermission:^(BOOL granted) {
        if (!granted) {
          reject(@"microphone_permission_denied",
                 @"Microphone access is required to stream STT audio.",
                 nil);
          return;
        }

        NSError *sessionError = nil;
        if (![self configureSharedSessionForRecordingWithSampleRate:sampleRate
                                                              error:&sessionError]) {
          reject(@"microphone_start_failed",
                 sessionError.localizedDescription ?: @"Failed to configure microphone audio session.",
                 sessionError);
          return;
        }

        AVAudioEngine *audioEngine = [[AVAudioEngine alloc] init];
        AVAudioInputNode *inputNode = audioEngine.inputNode;
        if (!inputNode) {
          reject(@"microphone_start_failed", @"Failed to access the microphone input node.", nil);
          return;
        }

        AVAudioFormat *inputFormat = [inputNode outputFormatForBus:0];
        AVAudioFormat *targetFormat =
            [[AVAudioFormat alloc] initWithCommonFormat:AVAudioPCMFormatFloat32
                                             sampleRate:(double)sampleRate
                                               channels:1
                                            interleaved:NO];
        if (!targetFormat) {
          reject(@"microphone_start_failed", @"Failed to create microphone target format.", nil);
          return;
        }

        self.sttMicrophoneAudioEngine = audioEngine;
        self.sttMicrophoneTargetFormat = targetFormat;
        self.sttMicrophoneStartedAt = [NSDate date];
        self.sttMicrophoneSessionId = sessionId;
        self.sttMicrophoneSampleRate = sampleRate;
        self.sttMicrophoneCallbackCount = 0;
        self.sttMicrophoneEmittedChunkCount = 0;
        self.sttMicrophoneInputChannels = (NSInteger)inputFormat.channelCount;
        self.sttMicrophoneLastInputFrameLength = 0;
        self.sttMicrophoneInputSampleRate = inputFormat.sampleRate;
        self.sttMicrophoneLastRawRms = 0;
        self.sttMicrophoneLastNormalizedRms = 0;
        self.sttMicrophoneMaxRawRms = 0;
        self.sttMicrophoneMaxNormalizedRms = 0;

        Wfloat *module = self;
        [inputNode installTapOnBus:0
                        bufferSize:(AVAudioFrameCount)MAX(
                                       1024,
                                       llround((inputFormat.sampleRate * (double)chunkMs) /
                                               1000.0))
                            format:inputFormat
                             block:^(AVAudioPCMBuffer *buffer, AVAudioTime *when) {
                               [module acceptMicrophoneBuffer:buffer];
                             }];

        [audioEngine prepare];
        NSError *startError = nil;
        if (![audioEngine startAndReturnError:&startError]) {
          [inputNode removeTapOnBus:0];
          [self resetSttMicrophoneState];
          reject(@"microphone_start_failed",
                 startError.localizedDescription ?: @"Failed to start microphone capture.",
                 startError);
          return;
        }

        resolve(nil);
      }];
    });
  });
}

- (void)stopSttSessionMicrophone:(JS::NativeWfloat::SttSessionNativeOptions &)options
                          resolve:(RCTPromiseResolveBlock)resolve
                           reject:(RCTPromiseRejectBlock)reject {
  double sessionIdValue = options.sessionId();
  if (!isfinite(sessionIdValue) || sessionIdValue < 0 || floor(sessionIdValue) != sessionIdValue) {
    reject(@"invalid_arguments", @"sessionId must be a non-negative integer.", nil);
    return;
  }

  if (!self.sttMicrophoneAudioEngine) {
    reject(@"not_recording", @"No streaming STT microphone capture is currently in progress.", nil);
    return;
  }

  NSInteger sessionId = (NSInteger)sessionIdValue;
  if (self.sttMicrophoneSessionId != sessionId) {
    reject(@"invalid_arguments", @"Microphone capture belongs to a different STT session.", nil);
    return;
  }

  AVAudioEngine *audioEngine = self.sttMicrophoneAudioEngine;
  [audioEngine.inputNode removeTapOnBus:0];
  [audioEngine stop];

  NSInteger durationMs =
      self.sttMicrophoneStartedAt
          ? MAX(1, (NSInteger)llround(-self.sttMicrophoneStartedAt.timeIntervalSinceNow *
                                      1000.0))
          : 0;
  NSDictionary *payload = @{
    @"durationMs" : @(durationMs),
    @"sampleRate" : @(self.sttMicrophoneSampleRate),
    @"callbackCount" : @(self.sttMicrophoneCallbackCount),
    @"emittedChunkCount" : @(self.sttMicrophoneEmittedChunkCount),
    @"inputChannels" : @(self.sttMicrophoneInputChannels),
    @"inputSampleRate" : @(self.sttMicrophoneInputSampleRate),
    @"lastInputFrameLength" : @(self.sttMicrophoneLastInputFrameLength),
    @"lastRawRms" : @(self.sttMicrophoneLastRawRms),
    @"lastNormalizedRms" : @(self.sttMicrophoneLastNormalizedRms),
    @"maxRawRms" : @(self.sttMicrophoneMaxRawRms),
    @"maxNormalizedRms" : @(self.sttMicrophoneMaxNormalizedRms),
  };

  [self resetSttMicrophoneState];
  resolve(payload);
}

- (void)getSttSessionResult:(JS::NativeWfloat::SttSessionNativeOptions &)options
                    resolve:(RCTPromiseResolveBlock)resolve
                     reject:(RCTPromiseRejectBlock)reject {
  if (!self.onlineRecognizer || self.loadedSttModelId.length == 0) {
    reject(@"not_loaded", @"Streaming STT model is not loaded.", nil);
    return;
  }

  double sessionIdValue = options.sessionId();
  if (!isfinite(sessionIdValue) || sessionIdValue < 0 || floor(sessionIdValue) != sessionIdValue) {
    reject(@"invalid_arguments", @"sessionId must be a non-negative integer.", nil);
    return;
  }

  dispatch_async(self.workQueue, ^{
    const SherpaOnnxOnlineStream *stream = [self streamForSessionId:(NSInteger)sessionIdValue];
    if (!stream) {
      dispatch_async(dispatch_get_main_queue(), ^{
        reject(@"invalid_arguments", @"Unknown STT session.", nil);
      });
      return;
    }

    while (SherpaOnnxIsOnlineStreamReady(self.onlineRecognizer, stream)) {
      SherpaOnnxDecodeOnlineStream(self.onlineRecognizer, stream);
    }

    const SherpaOnnxOnlineRecognizerResult *result =
        SherpaOnnxGetOnlineStreamResult(self.onlineRecognizer, stream);
    NSDictionary *payload = result
        ? [self streamingTranscriptionResultDictionary:result
                                            isEndpoint:SherpaOnnxOnlineStreamIsEndpoint(
                                                           self.onlineRecognizer, stream)
                                               modelId:self.loadedSttModelId]
        : nil;
    if (result) {
      SherpaOnnxDestroyOnlineRecognizerResult(result);
    }

    dispatch_async(dispatch_get_main_queue(), ^{
      if (!payload) {
        reject(@"session_result_failed", @"Failed to get STT session result.", nil);
        return;
      }
      resolve(payload);
    });
  });
}

- (void)finishSttSession:(JS::NativeWfloat::SttSessionNativeOptions &)options
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  if (!self.onlineRecognizer || self.loadedSttModelId.length == 0) {
    reject(@"not_loaded", @"Streaming STT model is not loaded.", nil);
    return;
  }

  double sessionIdValue = options.sessionId();
  if (!isfinite(sessionIdValue) || sessionIdValue < 0 || floor(sessionIdValue) != sessionIdValue) {
    reject(@"invalid_arguments", @"sessionId must be a non-negative integer.", nil);
    return;
  }

  dispatch_async(self.workQueue, ^{
    const SherpaOnnxOnlineStream *stream = [self streamForSessionId:(NSInteger)sessionIdValue];
    if (!stream) {
      dispatch_async(dispatch_get_main_queue(), ^{
        reject(@"invalid_arguments", @"Unknown STT session.", nil);
      });
      return;
    }

    SherpaOnnxOnlineStreamInputFinished(stream);
    while (SherpaOnnxIsOnlineStreamReady(self.onlineRecognizer, stream)) {
      SherpaOnnxDecodeOnlineStream(self.onlineRecognizer, stream);
    }

    const SherpaOnnxOnlineRecognizerResult *result =
        SherpaOnnxGetOnlineStreamResult(self.onlineRecognizer, stream);
    NSDictionary *payload = result
        ? [self streamingTranscriptionResultDictionary:result
                                            isEndpoint:SherpaOnnxOnlineStreamIsEndpoint(
                                                           self.onlineRecognizer, stream)
                                               modelId:self.loadedSttModelId]
        : nil;
    if (result) {
      SherpaOnnxDestroyOnlineRecognizerResult(result);
    }

    dispatch_async(dispatch_get_main_queue(), ^{
      if (!payload) {
        reject(@"session_finish_failed", @"Failed to finish STT session.", nil);
        return;
      }
      resolve(payload);
    });
  });
}

- (void)resetSttSession:(JS::NativeWfloat::SttSessionNativeOptions &)options
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  if (!self.onlineRecognizer) {
    reject(@"not_loaded", @"Streaming STT model is not loaded.", nil);
    return;
  }

  double sessionIdValue = options.sessionId();
  if (!isfinite(sessionIdValue) || sessionIdValue < 0 || floor(sessionIdValue) != sessionIdValue) {
    reject(@"invalid_arguments", @"sessionId must be a non-negative integer.", nil);
    return;
  }

  dispatch_async(self.workQueue, ^{
    const SherpaOnnxOnlineStream *stream = [self streamForSessionId:(NSInteger)sessionIdValue];
    if (!stream) {
      dispatch_async(dispatch_get_main_queue(), ^{
        reject(@"invalid_arguments", @"Unknown STT session.", nil);
      });
      return;
    }

    SherpaOnnxOnlineStreamReset(self.onlineRecognizer, stream);
    dispatch_async(dispatch_get_main_queue(), ^{
      resolve(nil);
    });
  });
}

- (void)closeSttSession:(JS::NativeWfloat::SttSessionNativeOptions &)options
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  double sessionIdValue = options.sessionId();
  if (!isfinite(sessionIdValue) || sessionIdValue < 0 || floor(sessionIdValue) != sessionIdValue) {
    reject(@"invalid_arguments", @"sessionId must be a non-negative integer.", nil);
    return;
  }

  dispatch_async(self.workQueue, ^{
    NSNumber *key = @((NSInteger)sessionIdValue);
    NSValue *value = self.sttSessions[key];
    if (value) {
      if (self.sttMicrophoneSessionId == (NSInteger)sessionIdValue) {
        dispatch_async(dispatch_get_main_queue(), ^{
          [self stopSttMicrophoneCapture];
        });
      }
      const SherpaOnnxOnlineStream *stream =
          (const SherpaOnnxOnlineStream *)value.pointerValue;
      SherpaOnnxDestroyOnlineStream(stream);
      [self.sttSessions removeObjectForKey:key];
    }

    dispatch_async(dispatch_get_main_queue(), ^{
      resolve(nil);
    });
  });
}

- (void)generate:(JS::NativeWfloat::GenerateNativeOptions &)options
         resolve:(RCTPromiseResolveBlock)resolve
          reject:(RCTPromiseRejectBlock)reject {
  if (!self.tts) {
    reject(@"not_loaded",
           @"TTS model is not loaded. Call loadTtsModel(...) first.",
           nil);
    return;
  }

  double requestIdValue = options.requestId();
  NSString *text = options.text();
  NSString *emotion = options.emotion();
  double sidValue = options.sid();
  double intensityValue = options.intensity();
  double speedValue = options.speed();
  double silencePaddingSecValue = options.silencePaddingSec();
  bool autoPlayValue = options.autoPlay();

  if (!isfinite(requestIdValue) || requestIdValue < 0 || floor(requestIdValue) != requestIdValue) {
    reject(@"invalid_arguments", @"requestId must be a non-negative integer.", nil);
    return;
  }

  if (text.length == 0) {
    reject(@"invalid_arguments", @"text is required.", nil);
    return;
  }

  if (!isfinite(sidValue) || sidValue < 0 || floor(sidValue) != sidValue) {
    reject(@"invalid_arguments", @"sid must be a non-negative integer.", nil);
    return;
  }

  if (!isfinite(intensityValue)) {
    intensityValue = 0.5;
  }

  if (!isfinite(speedValue) || speedValue <= 0) {
    speedValue = 1.0;
  }

  if (!isfinite(silencePaddingSecValue) || silencePaddingSecValue < 0) {
    silencePaddingSecValue = 0;
  }

  NSInteger requestId = (NSInteger)requestIdValue;
  int32_t sid = (int32_t)sidValue;
  float intensity = (float)MAX(0.0, MIN(intensityValue, 1.0));
  float speed = (float)speedValue;
  float silencePaddingSec = (float)silencePaddingSecValue;
  int32_t sampleRate = SherpaOnnxOfflineTtsSampleRate(self.tts);

  __weak Wfloat *weakSelf = self;
  WfloatSpeechSession *session = [[WfloatSpeechSession alloc]
      initWithRequestId:requestId
             sampleRate:sampleRate
            startPaused:!autoPlayValue
        progressHandler:^(NSInteger progressRequestId,
                          double progress,
                          BOOL isPlaying,
                          NSInteger textHighlightStart,
                          NSInteger textHighlightEnd,
                          NSString *chunkText,
                          NSInteger textHighlightSegment) {
          [weakSelf emitSpeechProgressWithRequestId:progressRequestId
                                           progress:progress
                                          isPlaying:isPlaying
                                 textHighlightStart:textHighlightStart
                                   textHighlightEnd:textHighlightEnd
                                               text:chunkText
                               textHighlightSegment:textHighlightSegment];
        }
    playbackFinishedHandler:^(NSInteger finishedRequestId) {
      if (!weakSelf) {
        return;
      }

      if (weakSelf.speechSession.requestId == finishedRequestId) {
        weakSelf.speechSession = nil;
      }

      [weakSelf emitSpeechPlaybackFinishedWithRequestId:finishedRequestId];
    }];

  WfloatSpeechSession *previousSession = self.speechSession;
  self.speechSession = session;
  [previousSession cancel];

  dispatch_async(self.workQueue, ^{
    NSError *generationError = nil;
    NSDictionary *generationResult = nil;
    WfloatGenerateResult result = [self generateSpeechForSession:session
                                                            text:text
                                                             sid:sid
                                                         emotion:emotion
                                                       intensity:intensity
                                                           speed:speed
                                               silencePaddingSec:silencePaddingSec
                                                          result:&generationResult
                                                           error:&generationError];

    dispatch_async(dispatch_get_main_queue(), ^{
      if (result == WfloatGenerateResultFailed) {
        if ([self isCurrentSpeechSession:session]) {
          [self cancelCurrentSpeechSession];
        } else {
          [session cancel];
        }

        reject(@"generate_failed",
               generationError.localizedDescription ?: @"Failed to generate speech audio.",
               generationError);
        return;
      }

      resolve(generationResult ?: @{});
    });
  });
}

- (void)generateDialogue:(JS::NativeWfloat::GenerateDialogueNativeOptions &)options
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  if (!self.tts) {
    reject(@"not_loaded",
           @"TTS model is not loaded. Call loadTtsModel(...) first.",
           nil);
    return;
  }

  double requestIdValue = options.requestId();
  auto nativeSegments = options.segments();
  double silenceBetweenSegmentsSecValue = options.silenceBetweenSegmentsSec();
  bool autoPlayValue = options.autoPlay();

  if (!isfinite(requestIdValue) || requestIdValue < 0 || floor(requestIdValue) != requestIdValue) {
    reject(@"invalid_arguments", @"requestId must be a non-negative integer.", nil);
    return;
  }

  if (nativeSegments.empty()) {
    reject(@"invalid_arguments", @"segments is required.", nil);
    return;
  }

  if (!isfinite(silenceBetweenSegmentsSecValue) || silenceBetweenSegmentsSecValue < 0) {
    silenceBetweenSegmentsSecValue = 0.2;
  }

  NSMutableArray<WfloatDialogueSegment *> *segments =
      [NSMutableArray arrayWithCapacity:(NSUInteger)nativeSegments.size()];
  for (facebook::react::LazyVector<JS::NativeWfloat::GenerateDialogueNativeSegment>::size_type
           index = 0;
       index < nativeSegments.size();
       index += 1) {
    JS::NativeWfloat::GenerateDialogueNativeSegment nativeSegment = nativeSegments[index];
    NSString *text = nativeSegment.text();
    double sidValue = nativeSegment.sid();
    NSString *emotion = nativeSegment.emotion();
    double intensityValue = nativeSegment.intensity();
    double speedValue = nativeSegment.speed();
    double sentenceSilencePaddingSecValue = nativeSegment.sentenceSilencePaddingSec();

    if (text.length == 0) {
      reject(@"invalid_arguments",
             [NSString stringWithFormat:@"segments[%d].text is required.", index],
             nil);
      return;
    }

    if (!isfinite(sidValue) || sidValue < 0 || floor(sidValue) != sidValue) {
      reject(@"invalid_arguments", @"sid must be a non-negative integer.", nil);
      return;
    }

    if (!isfinite(intensityValue)) {
      intensityValue = 0.5;
    }

    if (!isfinite(speedValue) || speedValue <= 0) {
      speedValue = 1.0;
    }

    if (!isfinite(sentenceSilencePaddingSecValue) ||
        sentenceSilencePaddingSecValue < 0) {
      sentenceSilencePaddingSecValue = 0.1;
    }

    WfloatDialogueSegment *segment = [[WfloatDialogueSegment alloc] init];
    segment.text = text;
    segment.sid = (int32_t)sidValue;
    segment.emotion = emotion.length > 0 ? emotion : @"neutral";
    segment.intensity = (float)MAX(0.0, MIN(intensityValue, 1.0));
    segment.speed = (float)speedValue;
    segment.sentenceSilencePaddingSec = (float)sentenceSilencePaddingSecValue;
    [segments addObject:segment];
  }

  NSInteger requestId = (NSInteger)requestIdValue;
  float silenceBetweenSegmentsSec = (float)silenceBetweenSegmentsSecValue;
  int32_t sampleRate = SherpaOnnxOfflineTtsSampleRate(self.tts);

  __weak Wfloat *weakSelf = self;
  WfloatSpeechSession *session = [[WfloatSpeechSession alloc]
      initWithRequestId:requestId
             sampleRate:sampleRate
            startPaused:!autoPlayValue
        progressHandler:^(NSInteger progressRequestId,
                          double progress,
                          BOOL isPlaying,
                          NSInteger textHighlightStart,
                          NSInteger textHighlightEnd,
                          NSString *chunkText,
                          NSInteger textHighlightSegment) {
          [weakSelf emitSpeechProgressWithRequestId:progressRequestId
                                           progress:progress
                                          isPlaying:isPlaying
                                 textHighlightStart:textHighlightStart
                                   textHighlightEnd:textHighlightEnd
                                               text:chunkText
                               textHighlightSegment:textHighlightSegment];
        }
    playbackFinishedHandler:^(NSInteger finishedRequestId) {
      if (!weakSelf) {
        return;
      }

      if (weakSelf.speechSession.requestId == finishedRequestId) {
        weakSelf.speechSession = nil;
      }

      [weakSelf emitSpeechPlaybackFinishedWithRequestId:finishedRequestId];
    }];

  WfloatSpeechSession *previousSession = self.speechSession;
  self.speechSession = session;
  [previousSession cancel];

  dispatch_async(self.workQueue, ^{
    NSError *generationError = nil;
    NSDictionary *generationResult = nil;
    WfloatGenerateResult result =
        [self generateDialogueForSession:session
                                segments:segments
               silenceBetweenSegmentsSec:silenceBetweenSegmentsSec
                                  result:&generationResult
                                   error:&generationError];

    dispatch_async(dispatch_get_main_queue(), ^{
      if (result == WfloatGenerateResultFailed) {
        if ([self isCurrentSpeechSession:session]) {
          [self cancelCurrentSpeechSession];
        } else {
          [session cancel];
        }

        reject(@"generate_failed",
               generationError.localizedDescription ?: @"Failed to generate speech audio.",
               generationError);
        return;
      }

      resolve(generationResult ?: @{});
    });
  });
}

- (void)play:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  (void)reject;
  [self.speechSession play];
  resolve(nil);
}

- (void)pause:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  (void)reject;
  [self.speechSession pause];
  resolve(nil);
}

- (void)loadModel:(JS::NativeWfloat::LoadModelNativeOptions &)options
          resolve:(RCTPromiseResolveBlock)resolve
           reject:(RCTPromiseRejectBlock)reject {
  if (self.loadModelResolve != nil || self.loadModelReject != nil) {
    reject(@"load_in_progress", @"A loadModel operation is already in progress.", nil);
    return;
  }

  NSString *modelId = options.modelId();
  NSString *modelURLString = options.modelUrl();
  NSString *tokensURLString = options.tokensUrl();
  NSString *espeakDataURLString = options.espeakDataUrl();
  NSString *normalizedEspeakChecksum = [self normalizedChecksum:options.espeakChecksum()];
  if (modelId.length == 0 || modelURLString.length == 0 || tokensURLString.length == 0 ||
      espeakDataURLString.length == 0 || normalizedEspeakChecksum.length == 0) {
    reject(@"invalid_arguments",
           @"modelId, modelUrl, tokensUrl, espeakDataUrl, and espeakChecksum are required.",
           nil);
    return;
  }

  NSError *pathError = nil;
  NSString *modelFileName = [self fileNameFromURLString:modelURLString error:&pathError];
  NSString *tokensFileName = [self fileNameFromURLString:tokensURLString error:&pathError];
  (void)[self fileNameFromURLString:espeakDataURLString error:&pathError];
  if (pathError) {
    reject(@"invalid_url", pathError.localizedDescription, pathError);
    return;
  }

  NSString *directoryPath = [self cacheDirectoryForModelId:modelId];
  if (![self ensureDirectoryExistsAtPath:directoryPath error:&pathError]) {
    reject(@"filesystem_error", pathError.localizedDescription, pathError);
    return;
  }

  NSString *espeakDirectoryPath = [self espeakDirectoryForChecksum:normalizedEspeakChecksum];
  if (![self ensureDirectoryExistsAtPath:WfloatEspeakCacheRootDirectory() error:&pathError] ||
      ![self ensureDirectoryExistsAtPath:WfloatEspeakWorkRootDirectory() error:&pathError]) {
    reject(@"filesystem_error", pathError.localizedDescription, pathError);
    return;
  }

  NSString *modelPath = [directoryPath stringByAppendingPathComponent:modelFileName];
  NSString *tokensPath = [directoryPath stringByAppendingPathComponent:tokensFileName];
  NSString *espeakArchivePath = [self espeakArchivePathForChecksum:normalizedEspeakChecksum];

  self.loadModelResolve = resolve;
  self.loadModelReject = reject;
  self.pendingModelId = modelId;
  self.pendingModelURLString = modelURLString;
  self.pendingTokensURLString = tokensURLString;
  self.pendingEspeakDataURLString = espeakDataURLString;
  self.pendingEspeakChecksum = normalizedEspeakChecksum;
  self.pendingModelPath = modelPath;
  self.pendingTokensPath = tokensPath;
  self.pendingEspeakDirectoryPath = espeakDirectoryPath;
  self.pendingEspeakArchivePath = espeakArchivePath;
  self.pendingNeedsModelDownload = ![[NSFileManager defaultManager] fileExistsAtPath:modelPath];
  self.pendingNeedsTokensDownload = ![[NSFileManager defaultManager] fileExistsAtPath:tokensPath];
  self.pendingNeedsEspeakDownload = ![self isInstalledEspeakDirectoryAtPath:espeakDirectoryPath];
  self.currentDownloadPhase = WfloatLoadModelDownloadPhaseNone;
  self.completedDownloadCount = 0;
  self.totalPlannedDownloadCount =
      (self.pendingNeedsModelDownload ? 1 : 0) + (self.pendingNeedsTokensDownload ? 1 : 0) +
      (self.pendingNeedsEspeakDownload ? 1 : 0);
  self.lastEmittedDownloadProgress = -1;

  [self startNextPendingDownloadStep];
}

- (void)URLSession:(NSURLSession *)session
      downloadTask:(NSURLSessionDownloadTask *)downloadTask
 didWriteData:(int64_t)bytesWritten
totalBytesWritten:(int64_t)totalBytesWritten
totalBytesExpectedToWrite:(int64_t)totalBytesExpectedToWrite {
  (void)session;
  (void)downloadTask;
  if (totalBytesExpectedToWrite <= 0) {
    return;
  }

  double phaseProgress = (double)totalBytesWritten / (double)totalBytesExpectedToWrite;
  [self emitDownloadProgress:phaseProgress];
}

- (void)URLSession:(NSURLSession *)session
      downloadTask:(NSURLSessionDownloadTask *)downloadTask
didFinishDownloadingToURL:(NSURL *)location {
  (void)session;
  (void)downloadTask;

  NSError *fileError = nil;
  NSString *destinationPath = self.currentDownloadDestinationPath;
  if (destinationPath.length == 0) {
    [self rejectPendingLoadModelWithCode:@"filesystem_error"
                                 message:@"Missing download destination path."
                                   error:nil];
    return;
  }

  [[NSFileManager defaultManager] removeItemAtPath:destinationPath error:nil];
  if (![[NSFileManager defaultManager] moveItemAtURL:location
                                               toURL:[NSURL fileURLWithPath:destinationPath]
                                               error:&fileError]) {
    [self rejectPendingLoadModelWithCode:@"filesystem_error"
                                 message:fileError.localizedDescription ?: @"Failed to save download."
                                   error:fileError];
    return;
  }

  if (self.currentDownloadPhase == WfloatLoadModelDownloadPhaseModel) {
    self.pendingNeedsModelDownload = NO;
  } else if (self.currentDownloadPhase == WfloatLoadModelDownloadPhaseTokens) {
    self.pendingNeedsTokensDownload = NO;
  } else if (self.currentDownloadPhase == WfloatLoadModelDownloadPhaseEspeakData) {
    BOOL didInstallEspeak = [self installEspeakArchiveAtPath:destinationPath
                                                    checksum:self.pendingEspeakChecksum
                                             destinationPath:self.pendingEspeakDirectoryPath
                                                       error:&fileError];
    [[NSFileManager defaultManager] removeItemAtPath:destinationPath error:nil];
  if (!didInstallEspeak) {
      [self rejectPendingLoadModelWithCode:@"espeak_install_failed"
                                   message:fileError.localizedDescription ?:
                                               @"Failed to install espeak-ng-data."
                                     error:fileError];
      return;
    }

    self.pendingNeedsEspeakDownload = NO;
  }

  self.completedDownloadCount += 1;
  self.currentDownloadDestinationPath = nil;
  [self startNextPendingDownloadStep];
}

- (void)URLSession:(NSURLSession *)session
              task:(NSURLSessionTask *)task
didCompleteWithError:(NSError *)error {
  (void)session;
  (void)task;
  if (!error) {
    return;
  }

  [self rejectPendingLoadModelWithCode:@"download_failed"
                               message:error.localizedDescription ?: @"Failed to download model assets."
                                 error:error];
}

@end
