#import "Wfloat.h"
#import "WfloatSpeechSession.h"
#import <AppleArchive/AppleArchive.h>
#import <CommonCrypto/CommonDigest.h>
#import <math.h>
#import <sherpa-onnx/c-api/c-api.h>
#import <string.h>

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

@interface Wfloat () <NSURLSessionDownloadDelegate>
@property (nonatomic, assign) const SherpaOnnxOfflineTts *tts;
@property (nonatomic, copy) NSString *loadedModelPath;
@property (nonatomic, copy) NSString *loadedTokensPath;
@property (nonatomic, copy) NSString *loadedDataDir;
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

  if (self.tts) {
    SherpaOnnxDestroyOfflineTts(self.tts);
    self.tts = nil;
  }

  [self.loadModelSession invalidateAndCancel];
}

- (dispatch_queue_t)workQueue {
  if (_workQueue == nil) {
    _workQueue = dispatch_queue_create("com.wfloat.react-native-wfloat.work", DISPATCH_QUEUE_SERIAL);
  }

  return _workQueue;
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
  if (fabsf(self.lastEmittedDownloadProgress - overallProgress) < 0.01f &&
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
