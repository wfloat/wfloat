#include "../../cpp/AppleNativeHeap.h"
#include "../../cpp/AppleMallocCheck.h"
#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#include <atomic>
#include <os/proc.h>
#include <TargetConditionals.h>
#include "../../cpp/ResidentMemory.h"
#include "../../cpp/ApplePurgeableProbe.h"
#include "../../cpp/AppleGraphicsProbe.h"
#include "../../cpp/AppleMetalProbe.h"

@interface BenchMemory : NSObject <RCTBridgeModule, RCTInvalidating> {
  bench::MemoryProbe _probe;
  std::atomic<bool> _foreground;
  std::atomic<bool> _closed;
  dispatch_queue_t _queue;
  uint64_t _generation;
  uint64_t _sequence;
  bench::ApplePurgeableProbe _purgeable;
  NSString *_purgeableStage;
  NSString *_purgeableError;
  uint64_t _purgeableGeneration;
  uint64_t _purgeableRun;
  int _purgeableTicks;
  bool _purgeableRunning;
  bench::AppleGraphicsProbe _graphics;
  NSString *_graphicsStage;
  NSString *_graphicsError;
  uint64_t _graphicsRun;
  uint64_t _graphicsGeneration;
  bool _graphicsRunning;
  bool _graphicsMetal;
  bench::AppleMetalProbe _metal;
  bool _metalInitializationAttempted;
  NSString *_metalInitializationError;
  double _metalInitializationDurationMs;
  NSDictionary *_mallocCheck;
  uint64_t _mallocRun;
  bool _startupTraceEnabled;
  uint64_t _startupReadCount;
}
@end

@implementation BenchMemory
RCT_EXPORT_MODULE();
+ (BOOL)requiresMainQueueSetup { return YES; }
- (instancetype)init {
  if ((self = [super init])) {
    _queue = dispatch_queue_create("com.wfloat.bench.memory", DISPATCH_QUEUE_SERIAL);
    _foreground.store(UIApplication.sharedApplication.applicationState == UIApplicationStateActive);
    _closed.store(false);
    _generation = 0;
    _sequence = 0;
    _startupTraceEnabled = [NSProcessInfo.processInfo.environment[@"WFLOAT_MEMORY_STARTUP_TRACE"] isEqualToString:@"1"];
    _purgeableStage = @"idle";
    _graphicsStage = @"idle";
    _mallocCheck = @{ @"run": @0, @"stage": @"idle", @"phases": @[], @"error": NSNull.null };
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(resumed:)
      name:UIApplicationDidBecomeActiveNotification object:nil];
    [NSNotificationCenter.defaultCenter addObserver:self selector:@selector(paused:)
      name:UIApplicationWillResignActiveNotification object:nil];
  }
  return self;
}
- (dispatch_queue_t)methodQueue { return _queue; }
- (NSDictionary *)constantsToExport { return @{ @"startupTraceEnabled": @(_startupTraceEnabled) }; }
- (void)traceStartup:(NSString *)stage read:(uint64_t)index {
  NSLog(@"WfloatMemoryStartup read=%llu stage=%@ uptimeMs=%.3f epochMs=%.3f sequence=%llu",
    (unsigned long long)index, stage, NSProcessInfo.processInfo.systemUptime * 1000.0,
    NSDate.date.timeIntervalSince1970 * 1000.0, (unsigned long long)_sequence);
}
- (void)resumed:(NSNotification *)notification { _foreground.store(true); }
- (void)paused:(NSNotification *)notification {
  _foreground.store(false);
  dispatch_async(_queue, ^{ [self releaseProbe]; });
}
- (void)releaseProbe {
  ++_generation; _probe.release(); ++_purgeableGeneration;
  _purgeable.release();
  if (_purgeableRunning) _purgeableStage = @"cancelled";
  _purgeableRunning = false;
  ++_graphicsGeneration; _graphics.release(); _metal.release();
  if (_graphicsRunning) _graphicsStage = @"cancelled";
  _graphicsRunning = false;
}
- (NSDictionary *)snapshot {
  if (_closed.load() || !_foreground.load()) throw std::runtime_error("Memory sampling requires the foreground app");
  const double before = NSProcessInfo.processInfo.systemUptime * 1000.0;
  const auto memory = bench::readResidentMemory();
  const auto heapSnapshot = bench::readAppleNativeHeap();
  const auto &nativeHeap = heapSnapshot.allocated;
  const auto &nativeHeapReserved = heapSnapshot.reserved;
  const bool exactNativeHeapReserved = nativeHeapReserved.bytes && *nativeHeapReserved.bytes <= 9007199254740991ULL;
  const bool exactNativeHeap = nativeHeap.bytes && *nativeHeap.bytes <= 9007199254740991ULL;
  const bool exactPeakFootprint = memory.peakPhysicalFootprint.bytes && *memory.peakPhysicalFootprint.bytes <= 9007199254740991ULL;
  const bool exactVirtual = memory.virtualSize.bytes && *memory.virtualSize.bytes <= 9007199254740991ULL;
  const bool exactCompressed = memory.compressed.bytes && *memory.compressed.bytes <= 9007199254740991ULL;
  const bool exactPeakCompressed = memory.peakCompressed.bytes && *memory.peakCompressed.bytes <= 9007199254740991ULL;
  const bool exactCumulativeCompressed = memory.cumulativeCompressed.bytes && *memory.cumulativeCompressed.bytes <= 9007199254740991ULL;
  const bool exactPeakReusable = memory.peakReusable.bytes && *memory.peakReusable.bytes <= 9007199254740991ULL;
  const bool exactPeakInternal = memory.peakInternal.bytes && *memory.peakInternal.bytes <= 9007199254740991ULL;
  const bool exactPeakExternal = memory.peakExternal.bytes && *memory.peakExternal.bytes <= 9007199254740991ULL;
  const bool exactPurgeableNonvolatile = memory.purgeableNonvolatile.bytes && *memory.purgeableNonvolatile.bytes <= 9007199254740991ULL;
  const bool exactGraphicsFootprint = memory.graphicsFootprint.bytes && *memory.graphicsFootprint.bytes <= 9007199254740991ULL;
  const bool exactPurgeableNonvolatileCompressed = memory.purgeableNonvolatileCompressed.bytes && *memory.purgeableNonvolatileCompressed.bytes <= 9007199254740991ULL;
  const bool exactPurgeableVolatileCompressed = memory.purgeableVolatileCompressed.bytes && *memory.purgeableVolatileCompressed.bytes <= 9007199254740991ULL;
  const bool exactPurgeableVolatile = memory.purgeableVolatile.bytes && *memory.purgeableVolatile.bytes <= 9007199254740991ULL;
  const bool exactReusable = memory.reusable.bytes && *memory.reusable.bytes <= 9007199254740991ULL;
  const bool exactInternal = memory.internal.bytes && *memory.internal.bytes <= 9007199254740991ULL;
  const bool exactExternal = memory.external.bytes && *memory.external.bytes <= 9007199254740991ULL;
  const size_t headroom = os_proc_available_memory();
  const bool exactHeadroom = headroom <= 9007199254740991ULL;
  const double after = NSProcessInfo.processInfo.systemUptime * 1000.0;
  if (_closed.load() || !_foreground.load()) throw std::runtime_error("Memory sampling was interrupted");
  // Metal has its own query interval: do not attribute device initialization to
  // the preceding Mach memory queries. Keep the device alive across samples.
  const double metalBefore = NSProcessInfo.processInfo.systemUptime * 1000.0;
  const bool metalInitializing = !_metalInitializationAttempted;
  if (metalInitializing) {
    _metalInitializationAttempted = true;
    try { _metal.prepare(); }
    catch (const std::exception &error) { _metalInitializationError = [NSString stringWithUTF8String:error.what()]; }
    _metalInitializationDurationMs = NSProcessInfo.processInfo.systemUptime * 1000.0 - metalBefore;
  }
  const bool metalAvailable = _metalInitializationError == nil;
  const uint64_t metalBytes = metalAvailable ? _metal.allocatedBytes() : 0;
  const bool metalExact = metalAvailable && metalBytes <= 9007199254740991ULL;
  const double metalAfter = NSProcessInfo.processInfo.systemUptime * 1000.0;
  NSDictionary *metalAllocation = @{
    @"bytes": metalExact ? (id)@(metalBytes) : NSNull.null,
    @"rawBytes": metalAvailable ? (id)[NSString stringWithFormat:@"%llu", (unsigned long long)metalBytes] : NSNull.null,
    @"source": @"MTLDevice.currentAllocatedSize", @"unit": @"bytes",
    @"scope": @"calling_process_default_mtl_device", @"accounting": @"metal_resource_allocation_bytes",
    @"deviceName": metalAvailable ? (id)_metal.deviceName() : NSNull.null,
    @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
    @"queryStartedUptimeMs": @(metalBefore), @"queryFinishedUptimeMs": @(metalAfter),
    @"initializationAttemptedThisSample": @(metalInitializing),
    @"initializationDurationMs": @(_metalInitializationDurationMs),
    @"error": _metalInitializationError ?: (metalExact ? (id)NSNull.null : @"Metal allocation exceeds exact JavaScript integer range")
  };
  // A separate, advisory API query on the existing device; no new device setup.
  const double workingSetBefore = NSProcessInfo.processInfo.systemUptime * 1000.0;
  uint64_t workingSetBytes = 0;
  bool workingSetAvailable = false;
  NSString *workingSetError = _metalInitializationError;
  if (@available(iOS 16.0, *)) {
    if (metalAvailable) { workingSetBytes = _metal.recommendedWorkingSetBytes(); workingSetAvailable = true; }
  } else { workingSetError = @"Metal recommended working-set size requires iOS 16 or later"; }
  const double workingSetAfter = NSProcessInfo.processInfo.systemUptime * 1000.0;
  const bool workingSetExact = workingSetAvailable && workingSetBytes <= 9007199254740991ULL;
  NSDictionary *metalWorkingSet = @{
    @"bytes": workingSetExact ? (id)@(workingSetBytes) : NSNull.null,
    @"rawBytes": workingSetAvailable ? (id)[NSString stringWithFormat:@"%llu", (unsigned long long)workingSetBytes] : NSNull.null,
    @"source": @"MTLDevice.recommendedMaxWorkingSetSize", @"unit": @"bytes",
    @"scope": @"calling_process_default_mtl_device", @"accounting": @"metal_recommended_working_set_bytes",
    @"deviceName": metalAvailable ? (id)_metal.deviceName() : NSNull.null,
    @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
    @"queryStartedUptimeMs": @(workingSetBefore), @"queryFinishedUptimeMs": @(workingSetAfter),
    @"error": workingSetError ?: (workingSetExact ? (id)NSNull.null : @"Metal recommended working-set size exceeds exact JavaScript integer range")
  };
  if (_closed.load() || !_foreground.load()) throw std::runtime_error("Memory sampling was interrupted");
  id direct = NSNull.null;
  if (_purgeableRunning) {
    task_vm_info_data_t vm{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    const auto status = task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&vm), &count);
    direct = @{ @"status": @(status), @"count": @(count),
      @"nonvolatile": status == KERN_SUCCESS && count >= TASK_VM_INFO_REV3_COUNT ? (id)@(vm.ledger_purgeable_nonvolatile) : NSNull.null,
      @"volatile": status == KERN_SUCCESS && count >= TASK_VM_INFO_REV3_COUNT ? (id)@(vm.ledger_purgeable_volatile) : NSNull.null,
      @"nonvolatileCompressed": status == KERN_SUCCESS && count >= TASK_VM_INFO_REV3_COUNT ? (id)@(vm.ledger_purgeable_novolatile_compressed) : NSNull.null,
      @"volatileCompressed": status == KERN_SUCCESS && count >= TASK_VM_INFO_REV3_COUNT ? (id)@(vm.ledger_purgeable_volatile_compressed) : NSNull.null,
      @"queryFinishedUptimeMs": @(NSProcessInfo.processInfo.systemUptime * 1000.0) };
  }
  id graphicsDirect = NSNull.null;
  if (_graphicsRunning) {
    const double started = NSProcessInfo.processInfo.systemUptime * 1000.0;
    task_vm_info_data_t vm{}; mach_msg_type_number_t count = TASK_VM_INFO_COUNT;
    const auto status = task_info(mach_task_self(), TASK_VM_INFO, reinterpret_cast<task_info_t>(&vm), &count);
    const bool valid = status == KERN_SUCCESS && count >= TASK_VM_INFO_REV3_COUNT;
    graphicsDirect = @{ @"status": @(status), @"count": @(count),
      @"footprintRawBytes": valid ? (id)[NSString stringWithFormat:@"%lld", (long long)vm.ledger_tag_graphics_footprint] : NSNull.null,
      @"compressedRawBytes": valid ? (id)[NSString stringWithFormat:@"%lld", (long long)vm.ledger_tag_graphics_footprint_compressed] : NSNull.null,
      @"nofootprintRawBytes": valid ? (id)[NSString stringWithFormat:@"%lld", (long long)vm.ledger_tag_graphics_nofootprint] : NSNull.null,
      @"nofootprintCompressedRawBytes": valid ? (id)[NSString stringWithFormat:@"%lld", (long long)vm.ledger_tag_graphics_nofootprint_compressed] : NSNull.null,
      @"queryStartedUptimeMs": @(started), @"queryFinishedUptimeMs": @(NSProcessInfo.processInfo.systemUptime * 1000.0) };
  }
  id metalDiagnostic = NSNull.null;
  if (_graphicsRunning && _graphicsMetal) {
    const double started = NSProcessInfo.processInfo.systemUptime * 1000.0;
    const uint64_t allocated = _metal.allocatedBytes();
    metalDiagnostic = @{ @"deviceName": _metal.deviceName(), @"storageMode": @"shared",
      @"source": @"MTLDevice.currentAllocatedSize", @"unit": @"bytes",
      @"rawAllocatedBytes": [NSString stringWithFormat:@"%llu", (unsigned long long)allocated],
      @"queryStartedUptimeMs": @(started), @"queryFinishedUptimeMs": @(NSProcessInfo.processInfo.systemUptime * 1000.0) };
  }
  NSDictionary *row = @{
    @"mallocCheck": _mallocCheck,
    @"metalAllocation": metalAllocation,
    @"metalWorkingSet": metalWorkingSet,
    @"graphicsCheck": @{ @"run": @(_graphicsRun), @"running": @(_graphicsRunning),
      @"stage": _graphicsStage ?: @"idle", @"heldBytes": @(_graphicsMetal ? _metal.heldBytes() : _graphics.heldBytes()),
      @"allocationKind": _graphicsMetal ? @"metal_shared_buffer" : @"iosurface",
      @"metalDiagnostic": metalDiagnostic,
      @"error": _graphicsError ?: (id)NSNull.null, @"directDiagnostic": graphicsDirect },
    @"purgeableCheck": @{ @"run": @(_purgeableRun), @"running": @(_purgeableRunning),
      @"stage": _purgeableStage ?: @"idle", @"heldBytes": @(_purgeable.heldBytes()),
      @"error": _purgeableError ?: (id)NSNull.null, @"directDiagnostic": direct },
    @"rssBytes": @(memory.bytes),
    @"source": [NSString stringWithUTF8String:memory.source.c_str()],
    @"physicalFootprint": @{
      @"bytes": memory.physicalFootprint.bytes ? (id)@(*memory.physicalFootprint.bytes) : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.physicalFootprint.source.c_str()],
      @"error": memory.physicalFootprint.error.empty() ? (id)NSNull.null :
        [NSString stringWithUTF8String:memory.physicalFootprint.error.c_str()]
    },
    @"peakPhysicalFootprint": @{
      @"bytes": exactPeakFootprint ? (id)@(*memory.peakPhysicalFootprint.bytes) : NSNull.null,
      @"rawBytes": memory.peakPhysicalFootprint.rawBytes ?
        (id)[NSString stringWithFormat:@"%lld", (long long)*memory.peakPhysicalFootprint.rawBytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.peakPhysicalFootprint.source.c_str()],
      @"scope": @"process_lifetime", @"unit": @"bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.peakPhysicalFootprint.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.peakPhysicalFootprint.error.c_str()] : exactPeakFootprint ?
        (id)NSNull.null : @"Peak physical footprint exceeds exact JavaScript integer range"
    },
    @"graphicsFootprint": @{
      @"bytes": exactGraphicsFootprint ? (id)@(*memory.graphicsFootprint.bytes) : NSNull.null,
      @"rawBytes": memory.graphicsFootprint.rawBytes ?
        (id)[NSString stringWithFormat:@"%lld", (long long)*memory.graphicsFootprint.rawBytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.graphicsFootprint.source.c_str()],
      @"scope": @"calling_process", @"unit": @"bytes", @"accounting": @"graphics_footprint_uncompressed_ledger_bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.graphicsFootprint.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.graphicsFootprint.error.c_str()] : exactGraphicsFootprint ?
        (id)NSNull.null : @"Graphics footprint memory exceeds exact JavaScript integer range"
    },
    @"purgeableNonvolatile": @{
      @"bytes": exactPurgeableNonvolatile ? (id)@(*memory.purgeableNonvolatile.bytes) : NSNull.null,
      @"rawBytes": memory.purgeableNonvolatile.rawBytes ?
        (id)[NSString stringWithFormat:@"%lld", (long long)*memory.purgeableNonvolatile.rawBytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.purgeableNonvolatile.source.c_str()],
      @"scope": @"calling_process", @"unit": @"bytes", @"accounting": @"purgeable_nonvolatile_resident_ledger_bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.purgeableNonvolatile.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.purgeableNonvolatile.error.c_str()] : exactPurgeableNonvolatile ?
        (id)NSNull.null : @"Nonvolatile purgeable memory exceeds exact JavaScript integer range"
    },
    @"purgeableNonvolatileCompressed": @{
      @"bytes": exactPurgeableNonvolatileCompressed ? (id)@(*memory.purgeableNonvolatileCompressed.bytes) : NSNull.null,
      @"rawBytes": memory.purgeableNonvolatileCompressed.rawBytes ?
        (id)[NSString stringWithFormat:@"%lld", (long long)*memory.purgeableNonvolatileCompressed.rawBytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.purgeableNonvolatileCompressed.source.c_str()],
      @"scope": @"calling_process", @"unit": @"bytes", @"accounting": @"purgeable_nonvolatile_compressed_original_page_bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.purgeableNonvolatileCompressed.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.purgeableNonvolatileCompressed.error.c_str()] : exactPurgeableNonvolatileCompressed ?
        (id)NSNull.null : @"Compressed nonvolatile purgeable memory exceeds exact JavaScript integer range"
    },
    @"purgeableVolatileCompressed": @{
      @"bytes": exactPurgeableVolatileCompressed ? (id)@(*memory.purgeableVolatileCompressed.bytes) : NSNull.null,
      @"rawBytes": memory.purgeableVolatileCompressed.rawBytes ?
        (id)[NSString stringWithFormat:@"%lld", (long long)*memory.purgeableVolatileCompressed.rawBytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.purgeableVolatileCompressed.source.c_str()],
      @"scope": @"calling_process", @"unit": @"bytes", @"accounting": @"purgeable_volatile_compressed_original_page_bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.purgeableVolatileCompressed.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.purgeableVolatileCompressed.error.c_str()] : exactPurgeableVolatileCompressed ?
        (id)NSNull.null : @"Compressed volatile purgeable memory exceeds exact JavaScript integer range"
    },
    @"purgeableVolatile": @{
      @"bytes": exactPurgeableVolatile ? (id)@(*memory.purgeableVolatile.bytes) : NSNull.null,
      @"rawBytes": memory.purgeableVolatile.rawBytes ?
        (id)[NSString stringWithFormat:@"%lld", (long long)*memory.purgeableVolatile.rawBytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.purgeableVolatile.source.c_str()],
      @"scope": @"calling_process", @"unit": @"bytes", @"accounting": @"purgeable_volatile_resident_ledger_bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.purgeableVolatile.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.purgeableVolatile.error.c_str()] : exactPurgeableVolatile ?
        (id)NSNull.null : @"Volatile purgeable memory exceeds exact JavaScript integer range"
    },
    @"regions": @{
      @"count": memory.regions.count ? (id)@(*memory.regions.count) : NSNull.null,
      @"rawCount": memory.regions.rawCount ?
        (id)[NSString stringWithFormat:@"%d", *memory.regions.rawCount] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.regions.source.c_str()],
      @"scope": @"calling_process", @"unit": @"regions", @"aggregation": @"gauge",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": memory.regions.error.empty() ? (id)NSNull.null :
        [NSString stringWithUTF8String:memory.regions.error.c_str()]
    },
    @"virtualSize": @{
      @"bytes": exactVirtual ? (id)@(*memory.virtualSize.bytes) : NSNull.null,
      @"rawBytes": memory.virtualSize.bytes ?
        (id)[NSString stringWithFormat:@"%llu", (unsigned long long)*memory.virtualSize.bytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.virtualSize.source.c_str()],
      @"scope": @"calling_process", @"unit": @"bytes",
      @"error": !memory.virtualSize.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.virtualSize.error.c_str()] : exactVirtual ?
        (id)NSNull.null : @"Virtual memory exceeds exact JavaScript integer range"
    },
    @"compressed": @{
      @"bytes": exactCompressed ? (id)@(*memory.compressed.bytes) : NSNull.null,
      @"rawBytes": memory.compressed.bytes ?
        (id)[NSString stringWithFormat:@"%llu", (unsigned long long)*memory.compressed.bytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.compressed.source.c_str()],
      @"scope": @"calling_process", @"unit": @"bytes", @"accounting": @"original_page_bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.compressed.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.compressed.error.c_str()] : exactCompressed ?
        (id)NSNull.null : @"Compressed memory exceeds exact JavaScript integer range"
    },
    @"peakCompressed": @{
      @"bytes": exactPeakCompressed ? (id)@(*memory.peakCompressed.bytes) : NSNull.null,
      @"rawBytes": memory.peakCompressed.bytes ?
        (id)[NSString stringWithFormat:@"%llu", (unsigned long long)*memory.peakCompressed.bytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.peakCompressed.source.c_str()],
      @"scope": @"process_lifetime", @"unit": @"bytes", @"accounting": @"original_page_bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.peakCompressed.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.peakCompressed.error.c_str()] : exactPeakCompressed ?
        (id)NSNull.null : @"Peak compressed memory exceeds exact JavaScript integer range"
    },
    @"cumulativeCompressed": @{
      @"bytes": exactCumulativeCompressed ? (id)@(*memory.cumulativeCompressed.bytes) : NSNull.null,
      @"rawBytes": memory.cumulativeCompressed.bytes ?
        (id)[NSString stringWithFormat:@"%llu", (unsigned long long)*memory.cumulativeCompressed.bytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.cumulativeCompressed.source.c_str()],
      @"scope": @"process_lifetime", @"unit": @"bytes", @"accounting": @"internal_compressed_ledger_credit_bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.cumulativeCompressed.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.cumulativeCompressed.error.c_str()] : exactCumulativeCompressed ?
        (id)NSNull.null : @"Cumulative compressed memory exceeds exact JavaScript integer range"
    },
    @"peakReusable": @{
      @"bytes": exactPeakReusable ? (id)@(*memory.peakReusable.bytes) : NSNull.null,
      @"rawBytes": memory.peakReusable.bytes ?
        (id)[NSString stringWithFormat:@"%llu", (unsigned long long)*memory.peakReusable.bytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.peakReusable.source.c_str()],
      @"scope": @"process_lifetime", @"unit": @"bytes", @"accounting": @"reusable_page_bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.peakReusable.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.peakReusable.error.c_str()] : exactPeakReusable ?
        (id)NSNull.null : @"Peak reusable memory exceeds exact JavaScript integer range"
    },
    @"peakInternal": @{
      @"bytes": exactPeakInternal ? (id)@(*memory.peakInternal.bytes) : NSNull.null,
      @"rawBytes": memory.peakInternal.bytes ?
        (id)[NSString stringWithFormat:@"%llu", (unsigned long long)*memory.peakInternal.bytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.peakInternal.source.c_str()],
      @"scope": @"process_lifetime", @"unit": @"bytes", @"accounting": @"internal_ledger_bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.peakInternal.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.peakInternal.error.c_str()] : exactPeakInternal ?
        (id)NSNull.null : @"Peak internal memory exceeds exact JavaScript integer range"
    },
    @"peakExternal": @{
      @"bytes": exactPeakExternal ? (id)@(*memory.peakExternal.bytes) : NSNull.null,
      @"rawBytes": memory.peakExternal.bytes ?
        (id)[NSString stringWithFormat:@"%llu", (unsigned long long)*memory.peakExternal.bytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.peakExternal.source.c_str()],
      @"scope": @"process_lifetime", @"unit": @"bytes", @"accounting": @"external_ledger_bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.peakExternal.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.peakExternal.error.c_str()] : exactPeakExternal ?
        (id)NSNull.null : @"Peak external memory exceeds exact JavaScript integer range"
    },
    @"reusable": @{
      @"bytes": exactReusable ? (id)@(*memory.reusable.bytes) : NSNull.null,
      @"rawBytes": memory.reusable.bytes ?
        (id)[NSString stringWithFormat:@"%llu", (unsigned long long)*memory.reusable.bytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.reusable.source.c_str()],
      @"scope": @"calling_process", @"unit": @"bytes", @"accounting": @"reusable_page_bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.reusable.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.reusable.error.c_str()] : exactReusable ?
        (id)NSNull.null : @"Reusable memory exceeds exact JavaScript integer range"
    },
    @"internal": @{
      @"bytes": exactInternal ? (id)@(*memory.internal.bytes) : NSNull.null,
      @"rawBytes": memory.internal.bytes ?
        (id)[NSString stringWithFormat:@"%llu", (unsigned long long)*memory.internal.bytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.internal.source.c_str()],
      @"scope": @"calling_process", @"unit": @"bytes", @"accounting": @"internal_ledger_bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.internal.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.internal.error.c_str()] : exactInternal ?
        (id)NSNull.null : @"Internal memory exceeds exact JavaScript integer range"
    },
    @"external": @{
      @"bytes": exactExternal ? (id)@(*memory.external.bytes) : NSNull.null,
      @"rawBytes": memory.external.bytes ?
        (id)[NSString stringWithFormat:@"%llu", (unsigned long long)*memory.external.bytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.external.source.c_str()],
      @"scope": @"calling_process", @"unit": @"bytes", @"accounting": @"external_ledger_bytes",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !memory.external.error.empty() ?
        (id)[NSString stringWithUTF8String:memory.external.error.c_str()] : exactExternal ?
        (id)NSNull.null : @"External memory exceeds exact JavaScript integer range"
    },
    @"nativeHeapAllocated": @{
      @"bytes": exactNativeHeap ? (id)@(*nativeHeap.bytes) : NSNull.null,
      @"rawBytes": nativeHeap.bytes ?
        (id)[NSString stringWithFormat:@"%llu", (unsigned long long)*nativeHeap.bytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:nativeHeap.source.c_str()],
      @"scope": @"calling_process", @"unit": @"bytes", @"accounting": @"malloc_zone_size_in_use_bytes",
      @"zones": @"registered_malloc_zones",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !nativeHeap.error.empty() ?
        (id)[NSString stringWithUTF8String:nativeHeap.error.c_str()] : exactNativeHeap ?
        (id)NSNull.null : @"Native heap allocated memory exceeds exact JavaScript integer range"
    },
    @"nativeHeapBlocks": @{
      @"count": @(heapSnapshot.blocksInUse),
      @"rawCount": [NSString stringWithFormat:@"%u", heapSnapshot.blocksInUse],
      @"source": @"malloc_zone_statistics(NULL).blocks_in_use",
      @"scope": @"calling_process", @"unit": @"blocks", @"aggregation": @"gauge",
      @"accounting": @"malloc_zone_blocks_in_use", @"zones": @"registered_malloc_zones",
      @"nativeWidthBits": @32,
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device", @"error": NSNull.null
    },
    @"nativeHeapReserved": @{
      @"bytes": exactNativeHeapReserved ? (id)@(*nativeHeapReserved.bytes) : NSNull.null,
      @"rawBytes": nativeHeapReserved.bytes ?
        (id)[NSString stringWithFormat:@"%llu", (unsigned long long)*nativeHeapReserved.bytes] : NSNull.null,
      @"source": [NSString stringWithUTF8String:nativeHeapReserved.source.c_str()],
      @"scope": @"calling_process", @"unit": @"bytes", @"accounting": @"malloc_zone_reserved_bytes",
      @"zones": @"registered_malloc_zones",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": !nativeHeapReserved.error.empty() ?
        (id)[NSString stringWithUTF8String:nativeHeapReserved.error.c_str()] : exactNativeHeapReserved ?
        (id)NSNull.null : @"Native heap reserved memory exceeds exact JavaScript integer range"
    },
    @"decompressions": @{
      @"count": memory.decompressions.count ? (id)@(*memory.decompressions.count) : NSNull.null,
      @"rawCount": memory.decompressions.rawCount ?
        (id)[NSString stringWithFormat:@"%d", *memory.decompressions.rawCount] : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.decompressions.source.c_str()],
      @"scope": @"calling_process", @"unit": @"events", @"aggregation": @"cumulative",
      @"saturated": @(memory.decompressions.saturated),
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": memory.decompressions.error.empty() ? (id)NSNull.null :
        [NSString stringWithUTF8String:memory.decompressions.error.c_str()]
    },
    @"peakRss": @{
      @"bytes": memory.peakRss.bytes ? (id)@(*memory.peakRss.bytes) : NSNull.null,
      @"source": [NSString stringWithUTF8String:memory.peakRss.source.c_str()],
      @"scope": @"process_lifetime",
      @"error": memory.peakRss.error.empty() ? (id)NSNull.null : [NSString stringWithUTF8String:memory.peakRss.error.c_str()]
    },
    @"headroom": @{
      @"bytes": exactHeadroom ? (id)@(headroom) : NSNull.null,
      @"rawBytes": [NSString stringWithFormat:@"%llu", (unsigned long long)headroom],
      @"source": @"os_proc_available_memory()", @"scope": @"current_app_limit",
      @"environment": TARGET_OS_SIMULATOR ? @"simulator" : @"device",
      @"error": exactHeadroom ? (id)NSNull.null : @"Memory headroom exceeds exact JavaScript integer range"
    },
    @"platform": @"ios", @"osVersion": UIDevice.currentDevice.systemVersion,
    @"clockSource": @"NSProcessInfo.systemUptime", @"sequence": @(++_sequence),
    @"queryStartedUptimeMs": @(before), @"queryFinishedUptimeMs": @(after),
    @"sampledAtMs": @(NSDate.date.timeIntervalSince1970 * 1000.0),
    @"monotonicMs": @(before + (after - before) / 2.0),
    @"readDurationMs": @(after - before),
    @"processId": @(getpid()),
    @"heldBytes": @(_probe.heldBytes())
  };
  NSData *data = [NSJSONSerialization dataWithJSONObject:row options:0 error:nil];
  if (data) {
    NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
    // Unified logging can truncate long messages. Preserve the complete sample.
    const NSUInteger parts = (json.length + 599) / 600;
    for (NSUInteger part = 0; part < parts; ++part)
      NSLog(@"WfloatMemoryChunk pid=%d seq=%llu part=%lu/%lu %@", getpid(), (unsigned long long)_sequence,
        (unsigned long)(part + 1), (unsigned long)parts,
        [json substringWithRange:NSMakeRange(part * 600, MIN(600, json.length - part * 600))]);
  }
  return row;
}
- (void)purgeableTick:(uint64_t)generation {
  if (generation != _purgeableGeneration || !_purgeableRunning) return;
  if (_closed.load() || !_foreground.load()) { [self releaseProbe]; return; }
  try {
    if (_purgeableTicks == 0) {
      _purgeable.setState(VM_PURGABLE_VOLATILE); _purgeableStage = @"resident_volatile"; [self snapshot];
      _purgeable.setState(VM_PURGABLE_NONVOLATILE); _purgeable.rewrite();
      _purgeableStage = @"waiting_for_compression"; [self snapshot];
    } else if (_purgeableTicks >= 30) {
      _purgeableStage = @"before_compressed_transition"; [self snapshot];
      _purgeable.setState(VM_PURGABLE_VOLATILE); _purgeableStage = @"compressed_volatile_attempt"; [self snapshot];
      _purgeable.setState(VM_PURGABLE_NONVOLATILE); _purgeableStage = @"restored_nonvolatile"; [self snapshot];
      _purgeable.rewrite(); _purgeable.setState(VM_PURGABLE_EMPTY);
      _purgeableStage = @"emptied"; [self snapshot];
      _purgeable.release(); _purgeableStage = @"released"; [self snapshot];
      _purgeableRunning = false;
      return;
    }
    ++_purgeableTicks;
    __weak BenchMemory *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), _queue, ^{ [weakSelf purgeableTick:generation]; });
  } catch (const std::exception &error) {
    [self releaseProbe]; _purgeableStage = @"failed";
    _purgeableError = [NSString stringWithUTF8String:error.what()];
  }
}
- (void)runGraphicsCheck:(BOOL)metal resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  try {
    if (_closed.load() || !_foreground.load()) throw std::runtime_error("Graphics check requires foreground app");
    [self releaseProbe]; ++_graphicsRun; _graphicsMetal = metal; _graphicsError = nil;
    // Initialize Metal before the baseline, so driver setup is not mistaken for the buffer.
    if (metal) _metal.prepare();
    _graphicsRunning = true;
    _graphicsStage = @"baseline"; [self snapshot];
    if (metal) _metal.create(); else _graphics.create();
    _graphicsStage = @"created"; [self snapshot];
    if (metal) _metal.write(); else _graphics.write();
    if (_closed.load() || !_foreground.load()) throw std::runtime_error("Graphics check interrupted");
    _graphicsStage = @"written"; resolve([self snapshot]);
    const uint64_t generation = ++_graphicsGeneration;
    __weak BenchMemory *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 10 * NSEC_PER_SEC), _queue, ^{
      BenchMemory *strongSelf = weakSelf;
      if (!strongSelf || generation != strongSelf->_graphicsGeneration) return;
      if (strongSelf->_closed.load() || !strongSelf->_foreground.load()) { [strongSelf releaseProbe]; return; }
      strongSelf->_graphics.release(); strongSelf->_metal.release(); strongSelf->_graphicsStage = @"released";
      try { [strongSelf snapshot]; }
      catch (const std::exception &error) { strongSelf->_graphicsStage = @"failed"; strongSelf->_graphicsError = [NSString stringWithUTF8String:error.what()]; }
      strongSelf->_graphicsRunning = false;
    });
  } catch (const std::exception &error) {
    [self releaseProbe]; _graphicsStage = @"failed";
    _graphicsError = [NSString stringWithUTF8String:error.what()];
    reject(@"GRAPHICS_CHECK_FAILED", _graphicsError, nil);
  }
}
RCT_EXPORT_METHOD(mallocCheck:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  bench::MallocCheckResult result{};
  NSString *failure = nil;
  NSString *stage = @"completed";
  const double started = NSProcessInfo.processInfo.systemUptime * 1000.0;
  ++_mallocRun;
  try {
    if (_closed.load() || !_foreground.load()) throw std::runtime_error("Malloc check requires foreground app");
    [self releaseProbe];
    bench::runAppleMallocCheck(result, [&]{ return !_closed.load() && _foreground.load(); });
  } catch (const std::exception &error) {
    failure = [NSString stringWithUTF8String:error.what()];
    stage = (!_foreground.load() || _closed.load()) ? @"cancelled" : @"failed";
  }
  const double finished = NSProcessInfo.processInfo.systemUptime * 1000.0;
  // Conversion/logging begins only after the helper has released its allocations.
  auto stats = [](const malloc_statistics_t &value) -> NSDictionary * {
    return @{ @"blocks": @(value.blocks_in_use),
      @"allocatedRawBytes": [NSString stringWithFormat:@"%llu", (unsigned long long)value.size_in_use],
      @"reservedRawBytes": [NSString stringWithFormat:@"%llu", (unsigned long long)value.size_allocated] };
  };
  NSMutableArray *phases = [NSMutableArray arrayWithCapacity:result.count];
  for (unsigned i=0;i<result.count;++i) {
    const auto &row=result.phases[i];
    [phases addObject:@{ @"stage": [NSString stringWithUTF8String:row.stage],
      @"process": stats(row.process), @"zone": row.hasZone ? (id)stats(row.zone) : NSNull.null,
      @"heldBlocks": @(row.heldBlocks), @"heldBytes": @(row.heldBytes) }];
  }
  _mallocCheck = @{ @"run": @(_mallocRun), @"stage": stage, @"phases": phases,
    @"source": @"malloc_zone_statistics", @"defaultReused": @(result.defaultReused), @"customReused": @(result.customReused),
    @"queryStartedUptimeMs": @(started), @"queryFinishedUptimeMs": @(finished),
    @"heldBlocks": @0, @"heldBytes": @0, @"error": failure ?: (id)NSNull.null };
  if (failure) { reject(@"MALLOC_CHECK_FAILED", failure, nil); return; }
  try { resolve([self snapshot]); }
  catch (const std::exception &error) { reject(@"MALLOC_CHECK_INTERRUPTED", [NSString stringWithUTF8String:error.what()], nil); }
}
RCT_EXPORT_METHOD(graphicsCheck:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  [self runGraphicsCheck:NO resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(metalCheck:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  [self runGraphicsCheck:YES resolve:resolve reject:reject];
}
RCT_EXPORT_METHOD(purgeableCheck:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  try {
    if (_closed.load() || !_foreground.load()) throw std::runtime_error("Purgeable check requires foreground app");
    [self releaseProbe]; ++_purgeableRun; _purgeableRunning = true; _purgeableError = nil;
    _purgeableStage = @"baseline"; [self snapshot];
    _purgeable.hold(); _purgeableStage = @"written_nonvolatile"; _purgeableTicks = 0;
    resolve([self snapshot]);
    const uint64_t generation = ++_purgeableGeneration;
    __weak BenchMemory *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), _queue, ^{ [weakSelf purgeableTick:generation]; });
  } catch (const std::exception &error) {
    [self releaseProbe]; _purgeableStage = @"failed";
    _purgeableError = [NSString stringWithUTF8String:error.what()];
    reject(@"PURGEABLE_CHECK_FAILED", _purgeableError, nil);
  }
}
RCT_EXPORT_METHOD(read:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  const uint64_t index = _startupTraceEnabled ? ++_startupReadCount : 0;
  const bool tracing = index > 0 && index <= 8;
  if (tracing) [self traceStartup:@"native_enter" read:index];
  try {
    NSDictionary *row = [self snapshot];
    if (tracing) [self traceStartup:@"snapshot_complete" read:index];
    resolve(row);
    if (tracing) [self traceStartup:@"resolve_submitted" read:index];
  }
  catch (const std::exception &error) {
    if (tracing) [self traceStartup:@"native_rejected" read:index];
    reject(@"MEMORY_READ_FAILED", [NSString stringWithUTF8String:error.what()], nil);
  }
}
RCT_EXPORT_METHOD(hold:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  try {
    if (!_foreground.load() || _closed.load()) throw std::runtime_error("Memory check requires the foreground app");
    _probe.hold();
    if (!_foreground.load() || _closed.load()) { [self releaseProbe]; throw std::runtime_error("Memory check interrupted"); }
    const uint64_t generation = ++_generation;
    __weak BenchMemory *weakSelf = self;
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 60 * NSEC_PER_SEC), _queue, ^{
      BenchMemory *strongSelf = weakSelf;
      if (strongSelf && strongSelf->_generation == generation) [strongSelf releaseProbe];
    });
    resolve([self snapshot]);
  } catch (const std::exception &error) { reject(@"MEMORY_CHECK_FAILED", [NSString stringWithUTF8String:error.what()], nil); }
}
RCT_EXPORT_METHOD(release:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject) {
  [self releaseProbe];
  try { resolve([self snapshot]); }
  catch (const std::exception &error) { reject(@"MEMORY_READ_FAILED", [NSString stringWithUTF8String:error.what()], nil); }
}
- (void)invalidate {
  if (_closed.exchange(true)) return;
  [NSNotificationCenter.defaultCenter removeObserver:self];
  dispatch_async(_queue, ^{ [self releaseProbe]; });
}
- (void)dealloc { [NSNotificationCenter.defaultCenter removeObserver:self]; }
@end
