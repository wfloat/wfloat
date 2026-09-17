#pragma once
#import <Metal/Metal.h>
#include "MetalProbeProgress.h"
#include "MetalComputeSignalProbe.h"
// Explicit probe: GPU context creation and sampling are not passive observations.
static NSDictionary *metalSignalProbe(BOOL (^shouldStop)(void)) {
  metalProbeProgress(@"device_creation");id<MTLDevice> device=MTLCreateSystemDefaultDevice();
  if(!device) return @{@"error":@"Metal device unavailable"};
  NSMutableDictionary *result=[@{@"deviceName":device.name,@"requestedAtMs":@(NSDate.date.timeIntervalSince1970*1000.),@"error":NSNull.null} mutableCopy];
  metalProbeProgress(@"counter_and_device_properties");NSMutableArray *sets=[NSMutableArray new];
  for(id<MTLCounterSet> set in device.counterSets) {
    NSMutableArray *counters=[NSMutableArray new];for(id<MTLCounter> counter in set.counters) [counters addObject:counter.name];
    [sets addObject:@{@"name":set.name,@"counters":counters}];
  }
  result[@"counterSets"]=sets;
  result[@"samplingPoints"]=@{@"draw":@([device supportsCounterSampling:MTLCounterSamplingPointAtDrawBoundary]),@"dispatch":@([device supportsCounterSampling:MTLCounterSamplingPointAtDispatchBoundary]),@"tileDispatch":@([device supportsCounterSampling:MTLCounterSamplingPointAtTileDispatchBoundary]),@"blit":@([device supportsCounterSampling:MTLCounterSamplingPointAtBlitBoundary]),@"stage":@([device supportsCounterSampling:MTLCounterSamplingPointAtStageBoundary])};
  result[@"currentAllocatedSizeBefore"]=exact(device.currentAllocatedSize);
  result[@"maxBufferLength"]=exact(device.maxBufferLength);
  result[@"hasUnifiedMemory"]=@(device.hasUnifiedMemory);
  result[@"maxArgumentBufferSamplerCount"]=exact(device.maxArgumentBufferSamplerCount);
  result[@"capabilities"]=@{@"rasterOrderGroups":@(device.rasterOrderGroupsSupported),@"programmableSamplePositions":@(device.programmableSamplePositionsSupported),@"float32Filtering":@(device.supports32BitFloatFiltering),@"float32MSAA":@(device.supports32BitMSAA),@"queryTextureLOD":@(device.supportsQueryTextureLOD),@"pullModelInterpolation":@(device.supportsPullModelInterpolation),@"dynamicLibraries":@(device.supportsDynamicLibraries),@"functionPointers":@(device.supportsFunctionPointers),@"raytracing":@(device.supportsRaytracing),@"primitiveMotionBlur":@(device.supportsPrimitiveMotionBlur)};
  if(@available(iOS 15.0,*))result[@"renderCapabilities"]=@{@"dynamicLibraries":@(device.supportsRenderDynamicLibraries),@"functionPointers":@(device.supportsFunctionPointersFromRender),@"raytracing":@(device.supportsRaytracingFromRender)};
  if(@available(iOS 16.0,*))result[@"recommendedMaxWorkingSetSize"]=exact(device.recommendedMaxWorkingSetSize);
  if(@available(iOS 17.0,*))result[@"architectureName"]=device.architecture.name;
  NSMutableArray *families=[NSMutableArray new];
  const MTLGPUFamily familyIds[]={MTLGPUFamilyApple1,MTLGPUFamilyApple2,MTLGPUFamilyApple3,MTLGPUFamilyApple4,MTLGPUFamilyApple5,MTLGPUFamilyApple6,MTLGPUFamilyApple7,MTLGPUFamilyApple8,MTLGPUFamilyMac1,MTLGPUFamilyMac2,MTLGPUFamilyCommon1,MTLGPUFamilyCommon2,MTLGPUFamilyCommon3};
  for(auto family:familyIds)[families addObject:@{@"nativeFamily":@(family),@"supported":@([device supportsFamily:family])}];
  if(@available(iOS 17.0,*))[families addObject:@{@"nativeFamily":@(MTLGPUFamilyApple9),@"supported":@([device supportsFamily:MTLGPUFamilyApple9])}];
  if(@available(iOS 16.0,*))[families addObject:@{@"nativeFamily":@(MTLGPUFamilyMetal3),@"supported":@([device supportsFamily:MTLGPUFamilyMetal3])}];
  result[@"gpuFamilies"]=families;

  metalProbeProgress(@"device_properties_complete");
  // One MiB fill verifies that the command executed, independent of counter support.
  id<MTLCommandQueue> queue=[device newCommandQueue];
  id<MTLBuffer> buffer=[device newBufferWithLength:1024*1024 options:MTLResourceStorageModeShared];
  if(!queue||!buffer) {result[@"error"]=@"Metal queue or buffer allocation failed";return result;}
  NSMutableArray *samples=[NSMutableArray new];BOOL timedOut=NO;
  // Run each advertised standard set separately; unknown formats remain discoverable.
  NSMutableArray *targets=[NSMutableArray arrayWithObject:NSNull.null];
  for(id<MTLCounterSet> set in device.counterSets) if([set.name isEqual:MTLCommonCounterSetTimestamp]||[set.name isEqual:MTLCommonCounterSetStageUtilization]||[set.name isEqual:MTLCommonCounterSetStatistic]) [targets addObject:set];
  for(id target in targets) {
    metalProbeProgress([@"blit_begin:" stringByAppendingString:target==NSNull.null?@"no_counters":[target name]]);
    NSMutableDictionary *row=[NSMutableDictionary new];id<MTLCounterSampleBuffer> sample=nil;
    row[@"counterSet"]=target==NSNull.null?@"command_buffer_only":[target name];
    const BOOL stage=[device supportsCounterSampling:MTLCounterSamplingPointAtStageBoundary];
    const BOOL blit=[device supportsCounterSampling:MTLCounterSamplingPointAtBlitBoundary];
    if(target!=NSNull.null) {
      if(!stage&&!blit) {row[@"error"]=@"No supported blit sampling point";[samples addObject:row];continue;}
      MTLCounterSampleBufferDescriptor *desc=[MTLCounterSampleBufferDescriptor new];desc.counterSet=target;desc.sampleCount=2;desc.storageMode=MTLStorageModeShared;
      NSError *error=nil;sample=[device newCounterSampleBufferWithDescriptor:desc error:&error];
      if(!sample) {row[@"error"]=error.description?:@"Counter buffer unavailable";[samples addObject:row];continue;}
    }
    if(buffer.contents) memset(buffer.contents,0,buffer.length);
    MTLTimestamp cpuBefore=0,gpuBefore=0;[device sampleTimestamps:&cpuBefore gpuTimestamp:&gpuBefore];
    id<MTLCommandBuffer> command=[queue commandBuffer];id<MTLBlitCommandEncoder> encoder=nil;
    if(sample&&stage) {MTLBlitPassDescriptor *pass=[MTLBlitPassDescriptor blitPassDescriptor];pass.sampleBufferAttachments[0].sampleBuffer=sample;pass.sampleBufferAttachments[0].startOfEncoderSampleIndex=0;pass.sampleBufferAttachments[0].endOfEncoderSampleIndex=1;encoder=[command blitCommandEncoderWithDescriptor:pass];}
    else {encoder=[command blitCommandEncoder];if(sample) [encoder sampleCountersInBuffer:sample atSampleIndex:0 withBarrier:YES];}
    if(!command||!encoder) {row[@"error"]=@"Command encoder unavailable";[samples addObject:row];continue;}
    [encoder fillBuffer:buffer range:NSMakeRange(0,buffer.length) value:0x5a];
    if(sample&&!stage) [encoder sampleCountersInBuffer:sample atSampleIndex:1 withBarrier:YES];
    [encoder endEncoding];
    dispatch_semaphore_t done=dispatch_semaphore_create(0);[command addCompletedHandler:^(id<MTLCommandBuffer> c){dispatch_semaphore_signal(done);}];[command commit];
    if(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC))!=0) {timedOut=YES;row[@"error"]=@"GPU completion exceeded 5 seconds";[samples addObject:row];break;}
    MTLTimestamp cpuAfter=0,gpuAfter=0;[device sampleTimestamps:&cpuAfter gpuTimestamp:&gpuAfter];
    row[@"status"]=@(command.status);row[@"error"]=command.error.description?: (id)NSNull.null;
    row[@"GPUStartTimeSeconds"]=@(command.GPUStartTime);row[@"GPUEndTimeSeconds"]=@(command.GPUEndTime);
    row[@"kernelStartTimeSeconds"]=@(command.kernelStartTime);row[@"kernelEndTimeSeconds"]=@(command.kernelEndTime);
    row[@"cpuTimestampBefore"]=exact(cpuBefore);row[@"gpuTimestampBefore"]=exact(gpuBefore);row[@"cpuTimestampAfter"]=exact(cpuAfter);row[@"gpuTimestampAfter"]=exact(gpuAfter);
    if(command.status==MTLCommandBufferStatusCompleted) {
      const auto *bytes=(const unsigned char *)buffer.contents;bool valid=bytes!=nullptr;
      if(bytes) for(NSUInteger i=0;i<buffer.length;++i) if(bytes[i]!=0x5a){valid=false;break;}
      row[@"fillVerified"]=@(valid);row[@"fillBytes"]=exact(buffer.length);
      if(sample) {NSData *data=[sample resolveCounterRange:NSMakeRange(0,2)];row[@"resolvedBytes"]=@(data.length);row[@"resolvedBase64"]=data?[data base64EncodedStringWithOptions:0]:(id)NSNull.null;
        // Preserve native result words, including MTLCounterErrorValue, without units conversion.
        NSMutableArray *words=[NSMutableArray new];if(data.length%sizeof(uint64_t)==0) for(NSUInteger i=0;i<data.length;i+=sizeof(uint64_t)){uint64_t word;memcpy(&word,(const char *)data.bytes+i,sizeof(word));[words addObject:exact(word)];}row[@"resolvedNativeUInt64"]=words;
      }
    }
    [samples addObject:row];
  }
  metalProbeProgress(@"blit_complete");result[@"samples"]=samples;result[@"computeProbe"]=timedOut?@{@"error":@"Skipped after blit timeout"}:metalComputeSignalProbe(device,shouldStop);metalProbeProgress(@"probe_complete");result[@"receivedAtMs"]=@(NSDate.date.timeIntervalSince1970*1000.);return result;
}
