// Host contract test: real NSURLSession, CommonCrypto and AppleArchive; no fake success backend.
#import "../WfloatNextAssets.h"
#import <CommonCrypto/CommonDigest.h>
#include <atomic>
static void require(BOOL value, NSString *message) { if (!value) WFNextFail(message); }
static NSString *hash(NSData *data) {
  unsigned char digest[32]; CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *value = [NSMutableString new]; for (unsigned char byte : digest) [value appendFormat:@"%02x", byte]; return value;
}
int main(int argc, const char **argv) { @autoreleasepool {
  @try {
    NSString *base = @(argv[1]), *fixtures = @(argv[2]), *root = @(argv[3]);
    WfloatNextAssets *assets = [[WfloatNextAssets alloc] initWithRootURL:[NSURL fileURLWithPath:root]];
    NSData *data = [NSData dataWithContentsOfFile:[fixtures stringByAppendingPathComponent:@"model.bin"]];
    NSDictionary *(^command)(NSString *) = ^NSDictionary *(NSString *key) { return @{@"op":@"assetDownload", @"key":key, @"url":[base stringByAppendingString:@"/model.bin"], @"sizeBytes":@(data.length), @"sha256":hash(data)}; };
    WFNextEmit ignore = ^(NSDictionary *e) {};
    WFNextCancelled never = ^BOOL { return NO; };
    __block BOOL stop = NO;
    @try { [assets perform:command(@"resume") emit:^(NSDictionary *event) { if ([event[@"downloadedBytes"] unsignedLongLongValue] > 65536) stop = YES; } cancelled:^BOOL { return stop; }]; WFNextFail(@"Cancellation did not reject"); }
    @catch (NSException *e) { require([e.reason isEqual:@"Cancelled"], e.reason); }
    NSString *partial = [root stringByAppendingPathComponent:@"resume.partial"];
    uint64_t partialSize = [NSFileManager.defaultManager attributesOfItemAtPath:partial error:nil].fileSize;
    require(partialSize > 0 && partialSize < data.length, @"Cancellation did not retain bounded partial");
    NSDictionary *download = [assets perform:command(@"resume") emit:ignore cancelled:never];
    NSString *path = download[@"path"];
    require([[NSData dataWithContentsOfFile:path] isEqual:data], @"Resumed content differs");
    NSDictionary *stat = [assets perform:@{@"op":@"assetStat", @"key":@"resume"} emit:ignore cancelled:never];
    require([stat[@"sizeBytes"] unsignedLongLongValue] == data.length, @"Verified stat failed");
    [assets pinPaths:@[path]];
    [assets perform:@{@"op":@"assetDelete", @"key":@"resume"} emit:ignore cancelled:never];
    require([NSFileManager.defaultManager fileExistsAtPath:path], @"Delete removed pinned model");
    require([assets perform:@{@"op":@"assetStat", @"key":@"resume"} emit:ignore cancelled:never] == NSNull.null, @"Deleted pinned asset remained discoverable");
    [assets unpinPaths:@[path]];
    require(![NSFileManager.defaultManager fileExistsAtPath:path], @"Unpin did not complete pending deletion");
    download = [assets perform:command(@"corrupt") emit:ignore cancelled:never];
    NSMutableData *corrupt = [data mutableCopy]; ((uint8_t *)corrupt.mutableBytes)[0] ^= 1;
    [corrupt writeToFile:download[@"path"] atomically:YES];
    require([assets perform:@{@"op":@"assetStat", @"key":@"corrupt"} emit:ignore cancelled:never] == NSNull.null, @"Same-size corruption passed assetStat");
    NSMutableDictionary *bad = [command(@"bad") mutableCopy]; bad[@"sha256"] = [@"0" stringByPaddingToLength:64 withString:@"0" startingAtIndex:0];
    @try { [assets perform:bad emit:ignore cancelled:never]; WFNextFail(@"Bad hash accepted"); }
    @catch (NSException *e) { require([e.reason containsString:@"mismatch"], e.reason); }
    NSData *archive = [NSData dataWithContentsOfFile:[fixtures stringByAppendingPathComponent:@"espeak.aar"]];
    download = [assets perform:@{@"op":@"assetDownload", @"key":@"espeak", @"url":[base stringByAppendingString:@"/espeak.aar"], @"sizeBytes":@(archive.length), @"sha256":hash(archive)} emit:ignore cancelled:never];
    NSDictionary *extracted = [assets perform:@{@"op":@"prepareEspeak", @"key":@"espeak", @"path":download[@"path"], @"format":@"aar"} emit:ignore cancelled:never];
    require([NSFileManager.defaultManager fileExistsAtPath:[extracted[@"path"] stringByAppendingPathComponent:@"phondata"]], @"AppleArchive extraction failed");
    require([extracted[@"path"] lastPathComponent].length == 43, @"Extraction identity must retain the full SHA256 in compact form");
    require(strlen([extracted[@"path"] fileSystemRepresentation]) < 255, @"Extraction path exceeds eSpeak native limit");
    [assets pinPaths:@[extracted[@"path"]]];
    [assets perform:@{@"op":@"assetDelete", @"key":@"espeak"} emit:ignore cancelled:never];
    [assets unpinPaths:@[extracted[@"path"]]];
    require([NSFileManager.defaultManager fileExistsAtPath:[extracted[@"path"] stringByAppendingPathComponent:@"phontab"]], @"Delete removed process-pinned eSpeak data");
    NSNumber *excluded = nil; [[NSURL fileURLWithPath:root] getResourceValue:&excluded forKey:NSURLIsExcludedFromBackupKey error:nil];
    require(excluded.boolValue, @"Model directory is not excluded from backup");
    puts("PASS: cancelled transfer retains partial; Range resume; SHA256/stat corruption; loaded pin/delete; AppleArchive; no-backup");
    return 0;
  } @catch (NSException *e) { fprintf(stderr, "FAIL: %s\n", e.reason.UTF8String); return 1; }
} }
