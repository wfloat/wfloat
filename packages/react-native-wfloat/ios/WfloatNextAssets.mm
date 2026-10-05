#import "WfloatNextAssets.h"
#import <CommonCrypto/CommonDigest.h>
#import <AppleArchive/AppleArchive.h>
#import <fcntl.h>

void WFNextFail(NSString *message) {
  @throw [NSException exceptionWithName:@"WfloatNext" reason:message userInfo:nil];
}
NSString *WFNextJSON(id value) {
  NSError *error = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:value ?: NSNull.null options:NSJSONWritingFragmentsAllowed error:&error];
  if (!data) WFNextFail(error.localizedDescription);
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}
static void Check(BOOL ok, NSError *error) { if (!ok) WFNextFail(error.localizedDescription ?: @"Asset filesystem operation failed"); }

@interface WFNextTransfer : NSObject <NSURLSessionDataDelegate>
@property NSFileHandle *file;
@property uint64_t offset;
@property uint64_t expected;
@property uint64_t responseBytes;
@property uint64_t responseExpected;
@property NSString *failure;
@property(copy) WFNextEmit emit;
@property dispatch_semaphore_t done;
@end
@implementation WFNextTransfer
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveResponse:(NSURLResponse *)response completionHandler:(void (^)(NSURLSessionResponseDisposition))completion {
  NSHTTPURLResponse *http = (NSHTTPURLResponse *)response;
  if (![http isKindOfClass:NSHTTPURLResponse.class]) {
    self.failure = @"Asset URL did not return HTTP";
  } else if (http.statusCode == 206) {
    NSString *range = [http valueForHTTPHeaderField:@"Content-Range"];
    unsigned long long start = 0, end = 0, total = 0; char trailing = 0;
    if (!range || sscanf(range.UTF8String, "bytes %llu-%llu/%llu%c", &start, &end, &total, &trailing) != 3 ||
        start != self.offset || end < start || total != self.expected || end >= total) {
      self.failure = @"Invalid Content-Range for resumed asset";
    } else self.responseExpected = end - start + 1;
  } else if (http.statusCode == 200) {
    @try { [self.file truncateFileAtOffset:0]; [self.file seekToFileOffset:0]; self.offset = 0; }
    @catch (NSException *e) { self.failure = e.reason; }
    self.responseExpected = self.expected;
    if (response.expectedContentLength >= 0 && (uint64_t)response.expectedContentLength != self.expected)
      self.failure = @"Asset Content-Length differs from manifest";
  } else self.failure = [NSString stringWithFormat:@"Asset HTTP status %ld", (long)http.statusCode];
  completion(self.failure ? NSURLSessionResponseCancel : NSURLSessionResponseAllow);
}
- (void)URLSession:(NSURLSession *)session dataTask:(NSURLSessionDataTask *)task didReceiveData:(NSData *)data {
  if (self.failure) return;
  if (self.offset + data.length > self.expected || self.responseBytes + data.length > self.responseExpected) {
    self.failure = @"Asset exceeds declared size"; [task cancel]; return;
  }
  @try {
    [self.file writeData:data]; self.offset += data.length; self.responseBytes += data.length;
    self.emit(@{@"type": @"download", @"downloadedBytes": @(self.offset), @"totalBytes": @(self.expected)});
  } @catch (NSException *e) { self.failure = e.reason; [task cancel]; }
}
- (void)URLSession:(NSURLSession *)session task:(NSURLSessionTask *)task didCompleteWithError:(NSError *)error {
  if (error && !self.failure) self.failure = error.localizedDescription;
  if (!self.failure && self.responseBytes != self.responseExpected) self.failure = @"Truncated asset response";
  dispatch_semaphore_signal(self.done);
}
@end

static int ArchiveMessage(void *arg, AAEntryMessage message, const char *path, void *data) {
  WFNextCancelled cancelled = (__bridge WFNextCancelled)arg;
  if (cancelled()) return -1;
  if (message == AA_ENTRY_MESSAGE_EXTRACT_FAIL) return -1;
  if (message == AA_ENTRY_MESSAGE_EXTRACT_BEGIN) {
    NSString *name = @(path);
    if (name.isAbsolutePath || [name.pathComponents containsObject:@".."]) return -1;
    // Only ordinary files and directories belong in the trusted eSpeak data asset.
    uint64_t type = 0;
    int field = AAHeaderGetKeyIndex((AAHeader)data, AA_FIELD_C("TYP"));
    if (field < 0 || AAHeaderGetFieldUInt((AAHeader)data, field, &type) != 0 || (type != 'F' && type != 'D')) return -1;
  }
  return 0;
}
static NSMutableSet<NSString *> *ProcessEspeakPins(void) {
  static NSMutableSet<NSString *> *pins;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ pins = [NSMutableSet new]; });
  return pins;
}
@implementation WfloatNextAssets {
  NSString *_root;
  NSMutableDictionary<NSString *, NSNumber *> *_pins;
  NSMutableSet<NSString *> *_pendingDeletes;
  NSMutableSet<NSString *> *_processPins;
}
 + (NSRecursiveLock *)sharedLock {
  static NSRecursiveLock *lock;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ lock = [NSRecursiveLock new]; });
  return lock;
}
- (instancetype)init {
  NSError *error = nil;
  NSURL *base = [NSFileManager.defaultManager URLForDirectory:NSApplicationSupportDirectory inDomain:NSUserDomainMask appropriateForURL:nil create:YES error:&error];
  if (!base) WFNextFail(error.localizedDescription);
  return [self initWithRootURL:[base URLByAppendingPathComponent:@"WfloatNext/models" isDirectory:YES]];
}
- (instancetype)initWithRootURL:(NSURL *)root {
  if ((self = [super init])) {
    NSError *error = nil;
    Check([NSFileManager.defaultManager createDirectoryAtURL:root withIntermediateDirectories:YES attributes:@{NSFileProtectionKey:NSFileProtectionCompleteUntilFirstUserAuthentication} error:&error], error);
    Check([root setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&error], error);
    static NSMutableDictionary *pins;
    static NSMutableSet *pending;
    static dispatch_once_t once;
    dispatch_once(&once, ^{ pins = [NSMutableDictionary new]; pending = [NSMutableSet new]; });
    _root = root.path; _pins = pins; _pendingDeletes = pending; _processPins = ProcessEspeakPins();
  }
  return self;
}
- (NSString *)path:(id)key {
  if (![key isKindOfClass:NSString.class] || ![key length] || [key length] > 160 ||
      [key rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-"] invertedSet]].location != NSNotFound)
    WFNextFail(@"Invalid asset key (use a SHA256 hex key)");
  return [_root stringByAppendingPathComponent:key];
}
- (BOOL)isPinned:(NSString *)path {
  @synchronized (_processPins) { return [_pins[path] unsignedIntegerValue] > 0 || [_processPins containsObject:path]; }
}
- (NSString *)espeakPath:(NSString *)key {
  [self path:key]; // Apply the same key validation as ordinary assets.
  NSData *bytes = [key dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(bytes.bytes, (CC_LONG)bytes.length, digest);
  NSString *name = [[NSData dataWithBytes:digest length:sizeof(digest)] base64EncodedStringWithOptions:0];
  name = [[[name stringByReplacingOccurrencesOfString:@"/" withString:@"_"] stringByReplacingOccurrencesOfString:@"+" withString:@"-"] stringByReplacingOccurrencesOfString:@"=" withString:@""];
  // eSpeak's POSIX path_home buffer is 255 bytes. Simulator container paths
  // consume most of that budget; preserve the full digest in a compact form.
  return [[[_root stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"e"] stringByAppendingPathComponent:name];
}
- (void)pinPaths:(NSArray<NSString *> *)paths {
  for (NSString *path in paths) {
    NSString *p = path.stringByStandardizingPath;
    // Sherpa/eSpeak caches the data directory globally even after TTS handles unload.
    if ([NSFileManager.defaultManager fileExistsAtPath:[p stringByAppendingPathComponent:@".wfloat-ready"]]) {
      @synchronized (_processPins) { [_processPins addObject:p]; }
    }
    _pins[p] = @([_pins[p] unsignedIntegerValue] + 1);
  }
}
- (void)unpinPaths:(NSArray<NSString *> *)paths {
  for (NSString *path in paths) {
    NSString *p = path.stringByStandardizingPath;
    NSUInteger count = [_pins[p] unsignedIntegerValue];
    if (count > 1) _pins[p] = @(count - 1);
    else { [_pins removeObjectForKey:p]; if ([_pendingDeletes containsObject:p] && ![self isPinned:p]) {
      NSError *error = nil;
      if ([NSFileManager.defaultManager removeItemAtPath:p error:&error] || error.code == NSFileNoSuchFileError) [_pendingDeletes removeObject:p];
    } }
  }
}
- (BOOL)verify:(NSString *)path size:(uint64_t)size hash:(NSString *)hash cancelled:(WFNextCancelled)cancelled {
  if ([NSFileManager.defaultManager attributesOfItemAtPath:path error:nil].fileSize != size) return NO;
  NSInputStream *stream = [NSInputStream inputStreamWithFileAtPath:path]; [stream open];
  CC_SHA256_CTX ctx; CC_SHA256_Init(&ctx);
  uint8_t buffer[65536]; NSInteger n;
  while ((n = [stream read:buffer maxLength:sizeof(buffer)]) > 0) {
    if (cancelled()) { [stream close]; WFNextFail(@"Cancelled"); }
    CC_SHA256_Update(&ctx, buffer, (CC_LONG)n);
  }
  [stream close]; if (n < 0) WFNextFail(@"Cannot read downloaded asset for SHA256 verification");
  unsigned char digest[CC_SHA256_DIGEST_LENGTH]; CC_SHA256_Final(digest, &ctx);
  NSMutableString *actual = [NSMutableString new]; for (unsigned char c : digest) [actual appendFormat:@"%02x", c];
  return [actual isEqualToString:hash.lowercaseString];
}
- (id)prepareEspeak:(NSDictionary *)c cancelled:(WFNextCancelled)cancelled {
  if (![c[@"format"] isEqual:@"aar"]) WFNextFail(@"prepareEspeak supports the iOS aar asset only");
  NSString *archive = c[@"path"];
  if (![archive isKindOfClass:NSString.class] || !archive.isAbsolutePath) WFNextFail(@"prepareEspeak requires an absolute archive path");
  NSString *marker = [archive stringByAppendingString:@".verified.json"];
  NSData *data = [NSData dataWithContentsOfFile:marker];
  NSDictionary *identity = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
  if (!identity || ![self verify:archive size:[identity[@"sizeBytes"] unsignedLongLongValue] hash:identity[@"sha256"] cancelled:cancelled])
    WFNextFail(@"prepareEspeak requires an assetDownload-verified archive");
  NSString *destination = [self espeakPath:c[@"key"]];
  if (strlen(destination.fileSystemRepresentation) >= 255) WFNextFail(@"eSpeak data path exceeds its native 254-byte limit");
  NSString *ready = [destination stringByAppendingPathComponent:@".wfloat-ready"];
  if ([[NSString stringWithContentsOfFile:ready encoding:NSUTF8StringEncoding error:nil] isEqual:identity[@"sha256"]]) return @{@"path":destination};
  if ([self isPinned:destination]) WFNextFail(@"Cannot replace eSpeak data used by a loaded model");
  NSFileManager *fm = NSFileManager.defaultManager; NSError *error = nil;
  NSString *parent = destination.stringByDeletingLastPathComponent;
  Check([fm createDirectoryAtPath:parent withIntermediateDirectories:YES attributes:@{NSFileProtectionKey:NSFileProtectionCompleteUntilFirstUserAuthentication} error:&error], error);
  Check([[NSURL fileURLWithPath:parent] setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&error], error);
  NSString *temp = [_root stringByAppendingPathComponent:[@"extract-" stringByAppendingString:NSUUID.UUID.UUIDString]];
  Check([fm createDirectoryAtPath:temp withIntermediateDirectories:YES attributes:@{NSFileProtectionKey:NSFileProtectionCompleteUntilFirstUserAuthentication} error:&error], error);
  @try {
    AAByteStream file = AAFileStreamOpenWithPath(archive.fileSystemRepresentation, O_RDONLY, 0);
    AAByteStream decompress = file ? AADecompressionInputStreamOpen(file, 0, 0) : NULL;
    AAArchiveStream decode = decompress ? AADecodeArchiveInputStreamOpen(decompress, NULL, NULL, 0, 0) : NULL;
    AAArchiveStream extract = decode ? AAExtractArchiveOutputStreamOpen(temp.fileSystemRepresentation, (__bridge void *)cancelled, ArchiveMessage, 0, 1) : NULL;
    BOOL ok = extract && AAArchiveStreamProcess(decode, extract, NULL, NULL, 0, 1) >= 0;
    if (extract) ok = (AAArchiveStreamClose(extract) == 0) && ok;
    if (decode) ok = (AAArchiveStreamClose(decode) == 0) && ok;
    if (decompress) ok = (AAByteStreamClose(decompress) == 0) && ok;
    if (file) ok = (AAByteStreamClose(file) == 0) && ok;
    if (cancelled()) WFNextFail(@"Cancelled");
    if (!ok) WFNextFail(@"Cannot extract eSpeak AppleArchive");
    NSString *resolved = nil;
    NSArray *entries = [@[@""] arrayByAddingObjectsFromArray:[fm subpathsAtPath:temp] ?: @[]];
    for (NSString *entry in entries) {
      NSString *candidate = [temp stringByAppendingPathComponent:entry];
      if ([fm fileExistsAtPath:[candidate stringByAppendingPathComponent:@"phondata"]] && [fm fileExistsAtPath:[candidate stringByAppendingPathComponent:@"phontab"]]) { resolved = candidate; break; }
    }
    if (!resolved) WFNextFail(@"Archive contains no eSpeak data directory");
    Check([identity[@"sha256"] writeToFile:[resolved stringByAppendingPathComponent:@".wfloat-ready"] atomically:YES encoding:NSUTF8StringEncoding error:&error], error);
    if ([fm fileExistsAtPath:destination]) Check([fm removeItemAtPath:destination error:&error], error);
    Check([fm moveItemAtPath:resolved toPath:destination error:&error], error);
    Check([[NSURL fileURLWithPath:destination] setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:&error], error);
    return @{@"path":destination};
  } @finally { [fm removeItemAtPath:temp error:nil]; }
}
- (id)perform:(NSDictionary *)c emit:(WFNextEmit)emit cancelled:(WFNextCancelled)cancelled {
  if ([c[@"op"] isEqual:@"prepareEspeak"]) return [self prepareEspeak:c cancelled:cancelled];
  NSString *path = [self path:c[@"key"]], *op = c[@"op"];
  NSString *verified = [path stringByAppendingString:@".verified.json"];
  NSFileManager *fm = NSFileManager.defaultManager;
  if ([op isEqualToString:@"assetStat"]) {
    NSDictionary *attrs = [fm attributesOfItemAtPath:path error:nil];
    if (!attrs || [_pendingDeletes containsObject:path]) return NSNull.null;
    NSData *marker = [NSData dataWithContentsOfFile:verified];
    NSDictionary *identity = marker ? [NSJSONSerialization JSONObjectWithData:marker options:0 error:nil] : nil;
    NSString *hash = c[@"sha256"] ?: identity[@"sha256"];
    NSNumber *size = c[@"sizeBytes"] ?: identity[@"sizeBytes"];
    if (![hash isKindOfClass:NSString.class] || hash.length != 64 || !size || ![self verify:path size:size.unsignedLongLongValue hash:hash cancelled:cancelled]) return NSNull.null;
    return @{@"path":path, @"sizeBytes":@(attrs.fileSize)};
  }
  NSString *partial = [path stringByAppendingString:@".partial"], *meta = [partial stringByAppendingString:@".json"];
  if ([op isEqualToString:@"assetDelete"]) {
    NSError *error = nil;
    if ([self isPinned:path]) [_pendingDeletes addObject:path];
    else if ([fm fileExistsAtPath:path]) Check([fm removeItemAtPath:path error:&error], error);
    for (NSString *extracted in @[[self espeakPath:c[@"key"]], [path stringByAppendingString:@"-espeak"]]) {
      if ([self isPinned:extracted]) [_pendingDeletes addObject:extracted];
      else if ([fm fileExistsAtPath:extracted]) Check([fm removeItemAtPath:extracted error:&error], error);
    }
    for (NSString *p in @[partial, meta, verified]) if ([fm fileExistsAtPath:p]) Check([fm removeItemAtPath:p error:&error], error);
    return NSNull.null;
  }
  if ([op isEqualToString:@"assetAssemble"]) {
    NSString *hash = c[@"sha256"];
    if (![hash isKindOfClass:NSString.class] || hash.length != 64 ||
        [hash rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdefABCDEF"] invertedSet]].location != NSNotFound ||
        ![c[@"sizeBytes"] isKindOfClass:NSNumber.class] || [c[@"sizeBytes"] doubleValue] < 0 ||
        ![c[@"parts"] isKindOfClass:NSArray.class] || ![c[@"parts"] count]) WFNextFail(@"Invalid assembly manifest");
    uint64_t size = [c[@"sizeBytes"] unsignedLongLongValue];
    NSError *error = nil;
    NSDictionary *identity = @{@"sha256":hash.lowercaseString, @"sizeBytes":@(size)};
    if (cancelled()) WFNextFail(@"Cancelled");
    if ([self verify:path size:size hash:hash cancelled:cancelled]) {
      Check([[WFNextJSON(identity) dataUsingEncoding:NSUTF8StringEncoding] writeToFile:verified options:NSDataWritingAtomic error:&error], error);
      [_pendingDeletes removeObject:path]; return @{@"path":path};
    }
    if ([self isPinned:path]) WFNextFail(@"Cannot replace a loaded asset");
    NSFileHandle *output = nil;
    @try {
      Check([fm createFileAtPath:partial contents:nil attributes:nil], nil);
      output = [NSFileHandle fileHandleForWritingAtPath:partial];
      if (!output) WFNextFail(@"Cannot open assembly staging file");
      CC_SHA256_CTX digest; CC_SHA256_Init(&digest);
      uint64_t total = 0;
      for (NSDictionary *part in c[@"parts"]) {
        NSString *source = [self path:part[@"key"]];
        if ([source isEqual:path] || [_pendingDeletes containsObject:source] ||
            ![part[@"sizeBytes"] isKindOfClass:NSNumber.class] || [part[@"sizeBytes"] doubleValue] < 0 ||
            [part[@"sizeBytes"] unsignedLongLongValue] > size - total) WFNextFail(@"Invalid/deleted assembly part");
        uint64_t expected = [part[@"sizeBytes"] unsignedLongLongValue], count = 0;
        CC_SHA256_CTX partDigest; CC_SHA256_Init(&partDigest);
        NSFileHandle *input = [NSFileHandle fileHandleForReadingAtPath:source];
        if (!input) WFNextFail(@"Missing assembly part");
        @try {
          while (true) {
            @autoreleasepool {
              if (cancelled()) WFNextFail(@"Cancelled");
              NSData *chunk = [input readDataOfLength:65536];
              if (!chunk.length) break;
              if (chunk.length > expected - count) WFNextFail(@"Part exceeds declared size");
              [output writeData:chunk];
              CC_SHA256_Update(&digest, chunk.bytes, (CC_LONG)chunk.length);
              CC_SHA256_Update(&partDigest, chunk.bytes, (CC_LONG)chunk.length);
              count += chunk.length; total += chunk.length;
            }
          }
        } @finally { [input closeFile]; }
        unsigned char result[CC_SHA256_DIGEST_LENGTH]; CC_SHA256_Final(result, &partDigest);
        NSMutableString *actual = [NSMutableString new];
        for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; ++i) [actual appendFormat:@"%02x", result[i]];
        if (count != expected || ![actual isEqual:[part[@"sha256"] lowercaseString]]) WFNextFail(@"Assembly part integrity failed");
      }
      unsigned char result[CC_SHA256_DIGEST_LENGTH]; CC_SHA256_Final(result, &digest);
      NSMutableString *actual = [NSMutableString new];
      for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; ++i) [actual appendFormat:@"%02x", result[i]];
      if (total != size || ![actual isEqual:hash.lowercaseString]) WFNextFail(@"Assembly integrity failed");
      [output synchronizeFile]; [output closeFile]; output = nil;
      if (cancelled()) WFNextFail(@"Cancelled");
      if (rename(partial.fileSystemRepresentation, path.fileSystemRepresentation)) WFNextFail(@"Cannot publish assembled asset");
      Check([[WFNextJSON(identity) dataUsingEncoding:NSUTF8StringEncoding] writeToFile:verified options:NSDataWritingAtomic error:&error], error);
      [_pendingDeletes removeObject:path];
      return @{@"path":path};
    } @finally { [output closeFile]; [fm removeItemAtPath:partial error:nil]; }
  }
  NSURL *url = [NSURL URLWithString:c[@"url"] ?: @""];
  NSString *hash = c[@"sha256"];
  if (![@[@"http", @"https"] containsObject:url.scheme.lowercaseString] || !url.host.length ||
      ![hash isKindOfClass:NSString.class] || hash.length != 64 ||
      [hash rangeOfCharacterFromSet:[[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdefABCDEF"] invertedSet]].location != NSNotFound ||
      ![c[@"sizeBytes"] isKindOfClass:NSNumber.class] || [c[@"sizeBytes"] doubleValue] < 0)
    WFNextFail(@"assetDownload requires HTTP URL, nonnegative sizeBytes and SHA256");
  uint64_t size = [c[@"sizeBytes"] unsignedLongLongValue];
  if ([fm fileExistsAtPath:path] && [self verify:path size:size hash:hash cancelled:cancelled]) {
    NSDictionary *identity = @{@"sha256":hash.lowercaseString, @"sizeBytes":@(size)};
    NSError *error = nil;
    Check([[WFNextJSON(identity) dataUsingEncoding:NSUTF8StringEncoding] writeToFile:verified options:NSDataWritingAtomic error:&error], error);
    [_pendingDeletes removeObject:path]; return @{@"path":path};
  }
  if ([self isPinned:path]) WFNextFail(@"Cannot replace an asset used by a loaded model");
  NSDictionary *identity = @{@"url":url.absoluteString, @"sha256":hash.lowercaseString, @"sizeBytes":@(size)};
  NSData *oldMeta = [NSData dataWithContentsOfFile:meta];
  id previous = oldMeta ? [NSJSONSerialization JSONObjectWithData:oldMeta options:0 error:nil] : nil;
  NSError *error = nil;
  if (![identity isEqual:previous] || [fm attributesOfItemAtPath:partial error:nil].fileSize > size) {
    if ([fm fileExistsAtPath:partial]) Check([fm removeItemAtPath:partial error:&error], error);
  }
  Check([[WFNextJSON(identity) dataUsingEncoding:NSUTF8StringEncoding] writeToFile:meta options:NSDataWritingAtomic error:&error], error);
  if (![fm fileExistsAtPath:partial]) Check([fm createFileAtPath:partial contents:nil attributes:@{NSFileProtectionKey:NSFileProtectionCompleteUntilFirstUserAuthentication}], nil);
  uint64_t offset = [fm attributesOfItemAtPath:partial error:nil].fileSize;
  if (cancelled()) WFNextFail(@"Cancelled");
  if (offset < size) {
    WFNextTransfer *transfer = [WFNextTransfer new]; transfer.offset = offset; transfer.expected = size;
    transfer.emit = emit; transfer.done = dispatch_semaphore_create(0);
    transfer.file = [NSFileHandle fileHandleForWritingAtPath:partial];
    if (!transfer.file) WFNextFail(@"Cannot open partial asset");
    [transfer.file seekToEndOfFile];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url cachePolicy:NSURLRequestReloadIgnoringLocalCacheData timeoutInterval:60];
    [request setValue:@"identity" forHTTPHeaderField:@"Accept-Encoding"];
    if (offset) [request setValue:[NSString stringWithFormat:@"bytes=%llu-", (unsigned long long)offset] forHTTPHeaderField:@"Range"];
    NSURLSessionConfiguration *config = NSURLSessionConfiguration.ephemeralSessionConfiguration;
    config.timeoutIntervalForResource = 3600;
    NSOperationQueue *queue = [NSOperationQueue new]; queue.maxConcurrentOperationCount = 1;
    NSURLSession *session = [NSURLSession sessionWithConfiguration:config delegate:transfer delegateQueue:queue];
    NSURLSessionDataTask *task = [session dataTaskWithRequest:request]; [task resume];
    while (dispatch_semaphore_wait(transfer.done, dispatch_time(DISPATCH_TIME_NOW, 100 * NSEC_PER_MSEC))) if (cancelled()) [task cancel];
    [session finishTasksAndInvalidate];
    [transfer.file synchronizeFile]; [transfer.file closeFile];
    if (cancelled()) WFNextFail(@"Cancelled");
    if (transfer.failure) WFNextFail(transfer.failure);
    if (transfer.offset < size) WFNextFail(@"Asset response ended before the full object; partial retained for resume");
  }
  if (![self verify:partial size:size hash:hash cancelled:cancelled]) {
    [fm removeItemAtPath:partial error:nil]; [fm removeItemAtPath:meta error:nil];
    WFNextFail(@"Downloaded asset size or SHA256 mismatch");
  }
  if (cancelled()) WFNextFail(@"Cancelled");
  // POSIX rename is atomic and replaces an unpinned prior publication.
  if (rename(partial.fileSystemRepresentation, path.fileSystemRepresentation)) WFNextFail(@"Cannot atomically publish downloaded asset");
  Check([[WFNextJSON(identity) dataUsingEncoding:NSUTF8StringEncoding] writeToFile:verified options:NSDataWritingAtomic error:&error], error);
  [fm removeItemAtPath:meta error:nil]; [_pendingDeletes removeObject:path];
  emit(@{@"type":@"download", @"downloadedBytes":@(size), @"totalBytes":@(size)});
  return @{@"path":path};
}
@end
