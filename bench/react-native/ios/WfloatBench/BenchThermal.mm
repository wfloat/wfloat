#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <TargetConditionals.h>

@interface BenchThermal : NSObject <RCTBridgeModule>
@end

@implementation BenchThermal
RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup { return NO; }

RCT_EXPORT_METHOD(read:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject)
{
  NSProcessInfo *process = NSProcessInfo.processInfo;
  NSProcessInfoThermalState value = process.thermalState;
  NSString *state;
  switch (value) {
    case NSProcessInfoThermalStateNominal: state = @"nominal"; break;
    case NSProcessInfoThermalStateFair: state = @"fair"; break;
    case NSProcessInfoThermalStateSerious: state = @"serious"; break;
    case NSProcessInfoThermalStateCritical: state = @"critical"; break;
    default: state = @"unknown"; break;
  }
  resolve(@{
    @"availability": @"available",
    @"state": state,
    @"rawValue": @(value),
    @"sampledAtMs": @(NSDate.date.timeIntervalSince1970 * 1000.0),
    @"uptimeMs": @(process.systemUptime * 1000.0),
    @"source": @"ProcessInfo.thermalState",
    @"platform": @"ios",
    @"osVersion": process.operatingSystemVersionString,
    @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
    @"note": @"OS thermal state, not a temperature or an app-specific reading."
  });
}
@end
