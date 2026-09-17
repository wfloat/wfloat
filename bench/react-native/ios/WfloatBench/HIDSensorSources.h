#pragma once
#include <dlfcn.h>
// Private iOS ABI; simple-client discovery never schedules event delivery or
// changes properties. Only Apple thermal/electrical usage pairs are queried.
static NSDictionary *hidSensorSources(bool simple) {
  const double began=NSProcessInfo.processInfo.systemUptime;
  static void *library=dlopen("/System/Library/Frameworks/IOKit.framework/IOKit",RTLD_LAZY|RTLD_LOCAL);
  using Create=CFTypeRef(*)(CFAllocatorRef);
  using Services=CFArrayRef(*)(CFTypeRef);
  using Matching=void(*)(CFTypeRef,CFArrayRef);
  using Property=CFTypeRef(*)(CFTypeRef,CFStringRef);
  using Event=CFTypeRef(*)(CFTypeRef,int64_t,int32_t,int64_t);
  using Value=double(*)(CFTypeRef,int32_t);
  using Timestamp=uint64_t(*)(CFTypeRef);
  using RegistryId=CFTypeRef(*)(CFTypeRef);
  using Integer=CFIndex(*)(CFTypeRef,int32_t);
  using Flags=uint32_t(*)(CFTypeRef);
  using Data=CFDataRef(*)(CFAllocatorRef,CFTypeRef);
  auto create=library?(Create)dlsym(library,simple?"IOHIDEventSystemClientCreateSimpleClient":"IOHIDEventSystemClientCreate"):nullptr;
  auto matching=library?(Matching)dlsym(library,"IOHIDEventSystemClientSetMatchingMultiple"):nullptr;
  auto services=library?(Services)dlsym(library,"IOHIDEventSystemClientCopyServices"):nullptr;
  auto property=library?(Property)dlsym(library,"IOHIDServiceClientCopyProperty"):nullptr;
  auto event=library?(Event)dlsym(library,"IOHIDServiceClientCopyEvent"):nullptr;
  auto value=library?(Value)dlsym(library,"IOHIDEventGetFloatValue"):nullptr;
  auto registryId=library?(RegistryId)dlsym(library,"IOHIDServiceClientGetRegistryID"):nullptr;
  auto integer=library?(Integer)dlsym(library,"IOHIDEventGetIntegerValue"):nullptr;
  auto eventType=library?(Flags)dlsym(library,"IOHIDEventGetType"):nullptr;
  auto flags=library?(Flags)dlsym(library,"IOHIDEventGetEventFlags"):nullptr;
  auto sender=library?(Timestamp)dlsym(library,"IOHIDEventGetSenderID"):nullptr;
  auto data=library?(Data)dlsym(library,"IOHIDEventCreateData"):nullptr;
  auto timestamp=library?(Timestamp)dlsym(library,"IOHIDEventGetTimeStamp"):nullptr;
  if(!create||!matching||!services||!property||!event||!value)return @{@"error":@"required IOHID library/symbol unavailable"};
  CFTypeRef client=create(kCFAllocatorDefault);
  if(!client)return @{@"error":simple?@"IOHID simple client returned null":@"IOHID default client returned null"};
  // Match only the sensor usages before discovery, as native HID readers do.
  // This sets a client filter, not device properties or sampling controls.
  NSArray *filters=@[@{@"PrimaryUsagePage":@0xff00,@"PrimaryUsage":@5},@{@"PrimaryUsagePage":@0xff05},@{@"PrimaryUsagePage":@0xff08}];
  matching(client,(__bridge CFArrayRef)filters);
  CFArrayRef found=services(client);
  if(!found){CFRelease(client);return @{@"error":@"IOHID service enumeration returned null"};}
  NSUInteger serializedBytes=0;NSMutableArray *rows=[NSMutableArray new];CFIndex scanned=0,total=CFArrayGetCount(found);
  auto copyProperty=[&](CFTypeRef service,CFStringRef key)->id {CFTypeRef x=property(service,key);return x?CFBridgingRelease(x):(id)NSNull.null;};
  for(;scanned<total&&scanned<128&&rows.count<64;++scanned){
    if(NSProcessInfo.processInfo.systemUptime-began>0.1)break;
    CFTypeRef service=(CFTypeRef)CFArrayGetValueAtIndex(found,scanned);
    id page=copyProperty(service,CFSTR("PrimaryUsagePage")),usage=copyProperty(service,CFSTR("PrimaryUsage"));
    if(![page isKindOfClass:NSNumber.class]||![usage isKindOfClass:NSNumber.class])continue;
    const bool thermal=([page intValue]==0xff00&&[usage intValue]==5)||[page intValue]==0xff05;
    const bool electrical=[page intValue]==0xff08;
    if(!thermal&&!electrical)continue;
    const int32_t kind=thermal?15:25;CFTypeRef sample=event(service,kind,0,0);
    id name=copyProperty(service,CFSTR("Product"));if(![name isKindOfClass:NSString.class])name=NSNull.null;
    NSMutableDictionary *row=[@{@"usagePage":page,@"usage":usage,@"product":name,@"eventType":@(kind),@"rawValue":sample?[NSString stringWithFormat:@"%.17g",value(sample,kind<<16)]:(id)NSNull.null,@"eventTimestampNative":sample&&timestamp?[NSString stringWithFormat:@"%llu",(unsigned long long)timestamp(sample)]:(id)NSNull.null,@"receiptUptimeSeconds":@(NSProcessInfo.processInfo.systemUptime),@"error":sample?(id)NSNull.null:@"CopyEvent returned null"} mutableCopy];
    CFTypeRef identifier=registryId?registryId(service):nullptr;
    row[@"registryEntryId"]=identifier&&CFGetTypeID(identifier)==CFNumberGetTypeID()?[(__bridge NSNumber *)identifier stringValue]:(id)NSNull.null;
    if(sample){
      row[@"returnedEventType"]=eventType?@(eventType(sample)):(id)NSNull.null;
      row[@"eventOptionsNative"]=flags?@(flags(sample)):(id)NSNull.null;
      row[@"senderIdNative"]=sender?exact(sender(sample)):(id)NSNull.null;
      row[@"powerTypeNative"]=kind==25&&integer?@(integer(sample,(25<<16)+1)):(id)NSNull.null;
      row[@"powerSubTypeNative"]=kind==25&&integer?@(integer(sample,(25<<16)+2)):(id)NSNull.null;
      CFDataRef serialized=data?data(kCFAllocatorDefault,sample):nullptr;
      if(serialized){NSData *raw=CFBridgingRelease(serialized);const NSUInteger cap=MIN((NSUInteger)4096,(NSUInteger)65536-serializedBytes);row[@"eventDataBytes"]=@(raw.length);row[@"eventDataTruncated"]=@(raw.length>cap);row[@"eventDataBase64"]=raw.length<=cap?[raw base64EncodedStringWithOptions:0]:(id)NSNull.null;if(raw.length<=cap)serializedBytes+=raw.length;}
      else row[@"serializationError"]=@"event serialization unavailable";
    }
    [rows addObject:row];if(sample)CFRelease(sample);
  }
  CFRelease(found);CFRelease(client);
  return @{@"serializedBytesRetained":@(serializedBytes),@"client":simple?@"simple":@"default",@"servicesReported":@(total),@"servicesScanned":@(scanned),@"partial":@(scanned<total),@"sensors":rows,@"queryStartedUptimeSeconds":@(began),@"queryFinishedUptimeSeconds":@(NSProcessInfo.processInfo.systemUptime),@"error":NSNull.null,@"scope":@"private IOHID thermal/power/current/voltage sensor pages/usages only; no event subscription or property writes; raw native values and event clock require driver validation; zero matches does not prove absent sensors"};
}
