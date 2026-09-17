#pragma once
#include <dlfcn.h>
// Exported private IOReport ABI. Discovery only; no subscription, enabling,
// sampling or energy/unit conversion is implied by an advertised channel.
static NSDictionary *ioReportCatalog() {
  static NSDictionary *cached=nil;
  if(cached)return cached;
  const double began=NSProcessInfo.processInfo.systemUptime;
  static void *library=dlopen("/usr/lib/libIOReport.dylib",RTLD_LAZY|RTLD_LOCAL);
  using Copy=CFDictionaryRef(*)(uint64_t,uint64_t);using Name=CFStringRef(*)(CFDictionaryRef);
  auto copy=library?(Copy)dlsym(library,"IOReportCopyAllChannels"):nullptr;
  if(!copy){cached=@{@"error":@"IOReport catalog library/symbol unavailable",@"queryStartedUptimeSeconds":@(began)};return cached;}
  CFDictionaryRef result=copy(0,0);
  if(!result){cached=@{@"error":@"IOReportCopyAllChannels returned null",@"queryStartedUptimeSeconds":@(began),@"queryFinishedUptimeSeconds":@(NSProcessInfo.processInfo.systemUptime)};return cached;}
  if(CFGetTypeID(result)!=CFDictionaryGetTypeID()){CFRelease(result);cached=@{@"error":@"unexpected IOReport catalog object type"};return cached;}
  NSDictionary *dictionary=CFBridgingRelease(result);NSArray *channels=dictionary[@"IOReportChannels"];
  NSMutableArray *rows=[NSMutableArray new];
  NSArray *names=@[@"IOReportChannelGetGroup",@"IOReportChannelGetSubGroup",@"IOReportChannelGetChannelName",@"IOReportChannelGetUnitLabel"];
  NSArray *keys=@[@"group",@"subgroup",@"name",@"unitLabel"];
  if([channels isKindOfClass:NSArray.class])for(id item in channels){if(rows.count>=2048)break;if(![item isKindOfClass:NSDictionary.class])continue;NSMutableDictionary *row=[NSMutableDictionary new];
    for(NSUInteger i=0;i<names.count;++i){Name get=(Name)dlsym(library,[names[i] UTF8String]);CFStringRef value=get?get((__bridge CFDictionaryRef)item):nullptr;row[keys[i]]=value?(__bridge NSString *)value:(id)NSNull.null;}
    [rows addObject:row];
  }
  NSError *error=nil;NSData *raw=[NSPropertyListSerialization dataWithPropertyList:dictionary format:NSPropertyListBinaryFormat_v1_0 options:0 error:&error];
  const bool array=[channels isKindOfClass:NSArray.class];
  cached=@{@"queryStartedUptimeSeconds":@(began),@"queryFinishedUptimeSeconds":@(NSProcessInfo.processInfo.systemUptime),@"reportedChannelCount":array?@(channels.count):(id)NSNull.null,@"channels":rows,@"channelLimitReached":@(array&&channels.count>2048),@"binaryPlistBytes":@(raw.length),@"truncated":@(raw.length>262144),@"binaryPlistBase64":raw&&raw.length<=262144?[raw base64EncodedStringWithOptions:0]:(id)NSNull.null,@"serializationError":error.localizedDescription?: (id)NSNull.null,@"scope":@"one-time per-process private IOReport catalog, not sampled counter values; symbol/channel visibility does not establish subscription permission or sensor fidelity",@"error":NSNull.null};
  return cached;
}
