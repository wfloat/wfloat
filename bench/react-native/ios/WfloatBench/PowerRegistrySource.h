#pragma once
#import <IOKit/IOKitLib.h>
#include <dlfcn.h>
// Read registry properties only: no user-client connection, entitlement, write,
// privileged service, host tool or undocumented temperature conversion.
static NSDictionary *registryPropertySource(NSString *className, NSArray<NSString *> *selectedKeys=nil) {
  static void *library=dlopen("/System/Library/Frameworks/IOKit.framework/IOKit",RTLD_LAZY|RTLD_LOCAL);
  if(!library)return @{@"error":@"IOKit library unavailable"};
  auto matching=(decltype(&IOServiceMatching))dlsym(library,"IOServiceMatching");
  auto services=(decltype(&IOServiceGetMatchingServices))dlsym(library,"IOServiceGetMatchingServices");
  auto next=(decltype(&IOIteratorNext))dlsym(library,"IOIteratorNext");
  auto release=(decltype(&IOObjectRelease))dlsym(library,"IOObjectRelease");
  auto properties=(decltype(&IORegistryEntryCreateCFProperties))dlsym(library,"IORegistryEntryCreateCFProperties");
  auto getId=(decltype(&IORegistryEntryGetRegistryEntryID))dlsym(library,"IORegistryEntryGetRegistryEntryID");
  if(!matching||!services||!next||!release||!properties)return @{@"error":@"required registry symbols unavailable"};
  CFMutableDictionaryRef match=matching(className.UTF8String);
  if(!match)return @{@"error":@"matching dictionary unavailable"};
  io_iterator_t iterator=0;const auto code=services(MACH_PORT_NULL,match,&iterator); // consumes match
  NSMutableArray *rows=[NSMutableArray new];bool limited=false;
  if(code==KERN_SUCCESS && iterator) {
    for(unsigned i=0;i<8;++i){io_object_t entry=next(iterator);if(!entry)break;
      uint64_t entryId=0;const auto idCode=getId?getId(entry,&entryId):KERN_NOT_SUPPORTED;
      CFMutableDictionaryRef props=nullptr;const auto result=properties(entry,&props,kCFAllocatorDefault,0);release(entry);
      NSMutableDictionary *row=[@{@"returnCode":@(result),@"registryIdReturnCode":@(idCode),@"registryEntryId":idCode==KERN_SUCCESS?exact(entryId):(id)NSNull.null} mutableCopy];
      if(props){NSDictionary *dictionary=CFBridgingRelease(props);
        if(selectedKeys){NSMutableDictionary *selected=[NSMutableDictionary new];for(NSString *key in selectedKeys)if(dictionary[key])selected[key]=dictionary[key];dictionary=selected;}
        NSError *error=nil;
        NSData *data=[NSPropertyListSerialization dataWithPropertyList:dictionary format:NSPropertyListBinaryFormat_v1_0 options:0 error:&error];
        row[@"propertyNames"]=[[dictionary allKeys] sortedArrayUsingSelector:@selector(compare:)];
        row[@"binaryPlistBytes"]=@(data.length);row[@"truncated"]=@(data.length>262144);
        row[@"binaryPlistBase64"]=(data && data.length<=262144)?[data base64EncodedStringWithOptions:0]:(id)NSNull.null;
        row[@"serializationError"]=error.localizedDescription?: (id)NSNull.null;
      }
      [rows addObject:row];
      if(i==7)limited=true;
    }
  }
  if(iterator)release(iterator);
  return @{@"matchingClass":className,@"matchingReturnCode":@(code),@"services":rows,@"serviceLimitReached":@(limited),@"scope":@"IOKit matching-class registry properties as binary plist; OS may hide services or filter properties; zero matches does not establish absent hardware; no numeric unit conversion asserted",@"error":NSNull.null};
}

// Root driver-allocation diagnostics only; do not dump unrelated root properties.
static NSDictionary *registryAllocationDiagnostics() {
  static void *library=dlopen("/System/Library/Frameworks/IOKit.framework/IOKit",RTLD_LAZY|RTLD_LOCAL);
  auto root=library?(decltype(&IORegistryGetRootEntry))dlsym(library,"IORegistryGetRootEntry"):nullptr;
  auto property=library?(decltype(&IORegistryEntryCreateCFProperty))dlsym(library,"IORegistryEntryCreateCFProperty"):nullptr;
  auto release=library?(decltype(&IOObjectRelease))dlsym(library,"IOObjectRelease"):nullptr;
  if(!root||!property||!release)return @{@"error":@"registry diagnostics symbols unavailable"};
  io_registry_entry_t entry=root(MACH_PORT_NULL);
  if(!entry)return @{@"error":@"registry root unavailable"};
  CFTypeRef result=property(entry,CFSTR("IOKitDiagnostics"),kCFAllocatorDefault,0);release(entry);
  if(!result)return @{@"error":@"IOKitDiagnostics absent or filtered"};
  id object=CFBridgingRelease(result);NSError *error=nil;
  NSData *data=[NSPropertyListSerialization dataWithPropertyList:object format:NSPropertyListBinaryFormat_v1_0 options:0 error:&error];
  return @{@"binaryPlistBytes":@(data.length),@"truncated":@(data.length>262144),@"binaryPlistBase64":data&&data.length<=262144?[data base64EncodedStringWithOptions:0]:(id)NSNull.null,@"error":error.localizedDescription?:(id)NSNull.null,@"scope":@"IOKitDiagnostics root property only; driver class-instance and allocation accounting when exported, not app-owned memory; lossless native dictionary, no registry controls or user-client connection"};
}

// Discovery metadata complements known-class collectors: inventory exposed
// driver classes and property names without exporting unrelated property values.
static NSDictionary *registryServiceCatalog() {
  static NSDictionary *cached=nil;
  static io_iterator_t iterator=0;static bool started=false,finished=false;
  static kern_return_t code=KERN_SUCCESS;
  static NSMutableDictionary *classes=[NSMutableDictionary new];
  static unsigned count=0;static double totalDuration=0,capturedAt=0;
  if(finished)return cached;
  static void *library=dlopen("/System/Library/Frameworks/IOKit.framework/IOKit",RTLD_LAZY|RTLD_LOCAL);
  auto matching=library?(decltype(&IOServiceMatching))dlsym(library,"IOServiceMatching"):nullptr;
  auto services=library?(decltype(&IOServiceGetMatchingServices))dlsym(library,"IOServiceGetMatchingServices"):nullptr;
  auto next=library?(decltype(&IOIteratorNext))dlsym(library,"IOIteratorNext"):nullptr;
  auto release=library?(decltype(&IOObjectRelease))dlsym(library,"IOObjectRelease"):nullptr;
  auto properties=library?(decltype(&IORegistryEntryCreateCFProperties))dlsym(library,"IORegistryEntryCreateCFProperties"):nullptr;
  auto className=library?(decltype(&IOObjectGetClass))dlsym(library,"IOObjectGetClass"):nullptr;
  if(!matching||!services||!next||!release||!properties||!className)return @{@"error":@"registry discovery symbols unavailable"};
  const double start=NSProcessInfo.processInfo.systemUptime;
  if(!started){auto match=matching("IOService");if(!match)return @{@"error":@"matching dictionary unavailable"};
    code=services(MACH_PORT_NULL,match,&iterator);started=true;capturedAt=start;
    if(code!=KERN_SUCCESS||!iterator)finished=true;
  }
  bool limited=false;
  if(code==KERN_SUCCESS&&iterator)while(true){
    if(NSProcessInfo.processInfo.systemUptime-start>2){limited=true;break;}
    io_object_t entry=next(iterator);if(!entry){finished=true;break;}++count;io_name_t name{};const auto nameCode=className(entry,name);
    CFMutableDictionaryRef raw=nullptr;const auto result=properties(entry,&raw,kCFAllocatorDefault,0);release(entry);
    NSString *key=nameCode==KERN_SUCCESS?[[NSString alloc] initWithBytes:name length:strnlen(name,sizeof(name)) encoding:NSUTF8StringEncoding]:@"class_unavailable";
    if(!key)key=@"class_invalid_encoding";
    NSMutableDictionary *row=classes[key];if(!row){row=[@{@"instances":@0,@"propertyNames":[NSMutableSet new],@"propertyReadReturnCodes":[NSMutableSet new]} mutableCopy];classes[key]=row;}
    row[@"instances"]=@([row[@"instances"] unsignedIntValue]+1);[row[@"propertyReadReturnCodes"] addObject:@(result)];
    if(raw){NSDictionary *props=CFBridgingRelease(raw);for(id property in props){if([property isKindOfClass:NSString.class])[row[@"propertyNames"] addObject:property];}}
  }
  if(finished&&iterator){release(iterator);iterator=0;}
  totalDuration+=NSProcessInfo.processInfo.systemUptime-start;NSMutableArray *rows=[NSMutableArray new];
  for(NSString *key in [[classes allKeys] sortedArrayUsingSelector:@selector(compare:)]){NSDictionary *v=classes[key];[rows addObject:@{@"class":key,@"instances":v[@"instances"],@"propertyNames":[[v[@"propertyNames"] allObjects] sortedArrayUsingSelector:@selector(compare:)],@"propertyReadReturnCodes":[[v[@"propertyReadReturnCodes"] allObjects] sortedArrayUsingSelector:@selector(compare:)]}];}
  cached=@{@"matchingReturnCode":@(code),@"enumeratedServices":@(count),@"classes":rows,@"scanLimitReached":@(limited),@"complete":@(finished),@"capturedUptimeMs":@(capturedAt*1000),@"durationMs":@(totalDuration*1000),@"scope":@"incremental once-per-process exposed IOService class/property-name inventory, resumed across samples until iterator exhaustion for discovering additional telemetry; counts describe this inventory, not hardware activity; property values omitted"};return cached;
}

// Read-only getters reviewed in Apple's IOPMPowerNotifications.c: these read
// SCDynamicStore power records, without creating assertions or changing policy.
static NSDictionary *powerManagementRecords() {
  static void *library=dlopen("/System/Library/Frameworks/IOKit.framework/IOKit",RTLD_LAZY|RTLD_LOCAL);
  NSMutableArray *rows=[NSMutableArray new];
  const char *names[]={"IOPMGetThermalWarningLevel","IOPMGetPerformanceWarningLevel"};
  for(const char *name:names){auto getter=library?(int32_t(*)(uint32_t*))dlsym(library,name):nullptr;
    uint32_t value=0;int32_t code=getter?getter(&value):0;
    [rows addObject:@{@"api":@(name),@"symbolAvailable":@(getter!=nullptr),@"returnCode":getter?@(code):(id)NSNull.null,@"nativeValue":getter&&code==0?@(value):(id)NSNull.null}];
  }
  auto cpu=library?(int32_t(*)(CFDictionaryRef*))dlsym(library,"IOPMCopyCPUPowerStatus"):nullptr;
  CFDictionaryRef raw=nullptr;int32_t code=cpu?cpu(&raw):0;NSData *data=nil;NSError *error=nil;
  if(raw){data=[NSPropertyListSerialization dataWithPropertyList:(__bridge id)raw format:NSPropertyListBinaryFormat_v1_0 options:0 error:&error];CFRelease(raw);}
  [rows addObject:@{@"api":@"IOPMCopyCPUPowerStatus",@"symbolAvailable":@(cpu!=nullptr),@"returnCode":cpu?@(code):(id)NSNull.null,@"binaryPlistBytes":@(data.length),@"binaryPlistBase64":data&&data.length<=262144?[data base64EncodedStringWithOptions:0]:(id)NSNull.null,@"truncated":@(data.length>262144),@"serializationError":error.localizedDescription?:(id)NSNull.null}];
  auto advisory=library?(CFDictionaryRef(*)(void))dlsym(library,"IOCopySystemLoadAdvisoryDetailed"):nullptr;
  CFDictionaryRef detailed=advisory?advisory():nullptr;NSData *advisoryData=nil;NSError *advisoryError=nil;
  if(detailed){advisoryData=[NSPropertyListSerialization dataWithPropertyList:(__bridge id)detailed format:NSPropertyListBinaryFormat_v1_0 options:0 error:&advisoryError];CFRelease(detailed);}
  [rows addObject:@{@"api":@"IOCopySystemLoadAdvisoryDetailed",@"symbolAvailable":@(advisory!=nullptr),@"recordAvailable":@(advisoryData!=nil),@"binaryPlistBytes":@(advisoryData.length),@"binaryPlistBase64":advisoryData&&advisoryData.length<=262144?[advisoryData base64EncodedStringWithOptions:0]:(id)NSNull.null,@"truncated":@(advisoryData.length>262144),@"serializationError":advisoryError.localizedDescription?:(id)NSNull.null}];
  return @{@"records":rows,@"scope":@"Native system power-management CPU limit, warning and detailed load-advisory records; symbols/published records may be unavailable on iOS. Warning levels are not Celsius, CPU policy limits are not measured utilization, and advisory categories are not load averages or battery percentages. No assertions or policy writes."};
}

#include <notify.h>
// Names and readiness behavior from Libc/sys/OSThermalNotification.c. Register
// once per process; never post notifications or write their shared state.
static NSDictionary *nativeThermalNotificationRecords() {
  static const char *names[]={"com.apple.system.thermalpressurelevel","com.apple.system.thermalstatus","com.apple.system.thermalmitigation.70percenttorch","com.apple.system.thermalmitigation.70percentbacklight","com.apple.system.thermalmitigation.50percenttorch","com.apple.system.thermalmitigation.50percentbacklight","com.apple.system.thermalmitigation.disabletorch","com.apple.system.thermalmitigation.25percentbacklight","com.apple.system.thermalmitigation.disablemapshalo","com.apple.system.thermalmitigation.appterminate","com.apple.system.thermalmitigation.devicerestart","com.apple.system.thermalmitigation.thermaltableready"};
  static int tokens[12];static uint32_t registration[12];static dispatch_once_t once;
  dispatch_once(&once,^{for(unsigned i=0;i<12;++i)registration[i]=notify_register_check(names[i],&tokens[i]);});
  NSMutableArray *rows=[NSMutableArray new];
  for(unsigned i=0;i<12;++i){uint64_t state=0;uint32_t code=registration[i]==NOTIFY_STATUS_OK?notify_get_state(tokens[i],&state):registration[i];
    [rows addObject:@{@"notification":@(names[i]),@"registrationCode":@(registration[i]),@"readCode":@(code),@"nativeState":code==NOTIFY_STATUS_OK?[NSString stringWithFormat:@"%llu",(unsigned long long)state]:(id)NSNull.null}];}
  static auto current=(int(*)(void))dlsym(RTLD_DEFAULT,"OSThermalNotificationCurrentLevel");
  return @{@"records":rows,@"currentLevelSymbolAvailable":@(current!=nullptr),@"nativeCurrentLevel":current?@(current()):(id)NSNull.null,@"scope":@"Raw published thermal pressure/status and mitigation-threshold notification states. Successful notify reads do not establish a publisher or sensor freshness; zero can be uninitialized. Libc current-level getter returns -1 until its mitigation table is ready. iPhone pressure enum differs from macOS; no category, Celsius, or active-mitigation inference. No notify_set_state or notify_post."};
}
