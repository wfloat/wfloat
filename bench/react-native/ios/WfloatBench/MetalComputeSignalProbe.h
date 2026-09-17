#pragma once
#import <Metal/Metal.h>
#include "MetalRegistryResponseProbe.h"
// Owned, bounded compute workload; no SDK/model instrumentation.
static NSDictionary *metalComputeSignalProbe(id<MTLDevice> device,BOOL (^shouldStop)(void)) {
  metalProbeProgress(@"compute_properties");NSMutableDictionary *result=[NSMutableDictionary new];
  const MTLSize maximum=device.maxThreadsPerThreadgroup;
  result[@"deviceMaxThreadsPerThreadgroup"]=@[@(maximum.width),@(maximum.height),@(maximum.depth)];
  result[@"deviceMaxThreadgroupMemoryLength"]=exact(device.maxThreadgroupMemoryLength);
  result[@"readWriteTextureSupport"]=@(device.readWriteTextureSupport);
  result[@"argumentBuffersSupport"]=@(device.argumentBuffersSupport);
  result[@"sparseTileSizeInBytes"]=exact(device.sparseTileSizeInBytes);
  NSString *source=@"#include <metal_stdlib>\nusing namespace metal;\nkernel void os_probe(device uint *out [[buffer(0)]], uint i [[thread_position_in_grid]], uint local [[thread_index_in_threadgroup]]) { threadgroup uint scratch[64]; scratch[local]=i ^ 0x5a5a5a5au; threadgroup_barrier(mem_flags::mem_threadgroup); out[i]=scratch[63-local]; }";
  NSError *error=nil;const double libraryStart=NSProcessInfo.processInfo.systemUptime;
  metalProbeProgress(@"compute_library_compilation");id<MTLLibrary> library=[device newLibraryWithSource:source options:nil error:&error];
  result[@"libraryCompilationWallSeconds"]=@(NSProcessInfo.processInfo.systemUptime-libraryStart);
  if(!library){result[@"error"]=error.description?:@"library unavailable";return result;}
  id<MTLFunction> function=[library newFunctionWithName:@"os_probe"];
  const double pipelineStart=NSProcessInfo.processInfo.systemUptime;
  metalProbeProgress(@"compute_pipeline_creation");id<MTLComputePipelineState> pipeline=function?[device newComputePipelineStateWithFunction:function error:&error]:nil;
  result[@"pipelineCreationWallSeconds"]=@(NSProcessInfo.processInfo.systemUptime-pipelineStart);
  if(!pipeline){result[@"error"]=error.description?:@"pipeline unavailable";return result;}
  result[@"pipelineMaxTotalThreadsPerThreadgroup"]=exact(pipeline.maxTotalThreadsPerThreadgroup);
  result[@"threadExecutionWidth"]=exact(pipeline.threadExecutionWidth);
  result[@"staticThreadgroupMemoryLength"]=exact(pipeline.staticThreadgroupMemoryLength);
  result[@"supportIndirectCommandBuffers"]=@(pipeline.supportIndirectCommandBuffers);
  if(@available(iOS 18.0,*))result[@"shaderValidation"]=@(pipeline.shaderValidation);
  if(pipeline.maxTotalThreadsPerThreadgroup<64){result[@"error"]=@"64-thread probe unsupported";return result;}
  id<MTLCommandQueue> queue=[device newCommandQueue];id<MTLBuffer> buffer=[device newBufferWithLength:1024*1024 options:MTLResourceStorageModeShared];
  if(!queue||!buffer){result[@"error"]=@"queue/buffer unavailable";return result;}
  NSMutableArray *targets=[NSMutableArray arrayWithObject:NSNull.null],*samples=[NSMutableArray new];
  for(id<MTLCounterSet> set in device.counterSets)if([set.name isEqual:MTLCommonCounterSetTimestamp]||[set.name isEqual:MTLCommonCounterSetStageUtilization]||[set.name isEqual:MTLCommonCounterSetStatistic])[targets addObject:set];
  for(id target in targets){
    metalProbeProgress([@"compute_dispatch_begin:" stringByAppendingString:target==NSNull.null?@"no_counters":[target name]]);
    NSMutableDictionary *row=[@{@"counterSet":target==NSNull.null?@"command_buffer_only":[target name]} mutableCopy];
    const BOOL stage=[device supportsCounterSampling:MTLCounterSamplingPointAtStageBoundary],dispatch=[device supportsCounterSampling:MTLCounterSamplingPointAtDispatchBoundary];
    id<MTLCounterSampleBuffer> sample=nil;
    if(target!=NSNull.null){
      if(!stage&&!dispatch){row[@"error"]=@"No compute sampling point";[samples addObject:row];continue;}
      MTLCounterSampleBufferDescriptor *desc=[MTLCounterSampleBufferDescriptor new];desc.counterSet=target;desc.sampleCount=2;desc.storageMode=MTLStorageModeShared;
      sample=[device newCounterSampleBufferWithDescriptor:desc error:&error];if(!sample){row[@"error"]=error.description?:@"counter buffer unavailable";[samples addObject:row];continue;}
    }
    memset(buffer.contents,0,buffer.length);id<MTLCommandBuffer> command=[queue commandBuffer];id<MTLComputeCommandEncoder> encoder=nil;
    if(sample&&stage){MTLComputePassDescriptor *pass=[MTLComputePassDescriptor computePassDescriptor];pass.sampleBufferAttachments[0].sampleBuffer=sample;pass.sampleBufferAttachments[0].startOfEncoderSampleIndex=0;pass.sampleBufferAttachments[0].endOfEncoderSampleIndex=1;encoder=[command computeCommandEncoderWithDescriptor:pass];}
    else{encoder=[command computeCommandEncoder];if(sample)[encoder sampleCountersInBuffer:sample atSampleIndex:0 withBarrier:YES];}
    if(!command||!encoder){row[@"error"]=@"encoder unavailable";[samples addObject:row];continue;}
    [encoder setComputePipelineState:pipeline];[encoder setBuffer:buffer offset:0 atIndex:0];[encoder dispatchThreadgroups:MTLSizeMake(buffer.length/sizeof(uint32_t)/64,1,1) threadsPerThreadgroup:MTLSizeMake(64,1,1)];
    if(sample&&!stage)[encoder sampleCountersInBuffer:sample atSampleIndex:1 withBarrier:YES];[encoder endEncoding];
    dispatch_semaphore_t done=dispatch_semaphore_create(0);[command addCompletedHandler:^(id<MTLCommandBuffer> c){dispatch_semaphore_signal(done);}];[command commit];
    if(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC))!=0){row[@"error"]=@"GPU completion exceeded 5 seconds";[samples addObject:row];break;}
    row[@"status"]=@(command.status);row[@"error"]=command.error.description?:(id)NSNull.null;
    row[@"GPUStartTimeSeconds"]=@(command.GPUStartTime);row[@"GPUEndTimeSeconds"]=@(command.GPUEndTime);row[@"kernelStartTimeSeconds"]=@(command.kernelStartTime);row[@"kernelEndTimeSeconds"]=@(command.kernelEndTime);
    if(command.status==MTLCommandBufferStatusCompleted){const uint32_t *words=(const uint32_t *)buffer.contents;bool verified=words!=nullptr;for(NSUInteger i=0;words&&i<buffer.length/sizeof(uint32_t);++i)if(words[i]!=uint32_t(((i/64)*64+(63-i%64))^0x5a5a5a5aU)){verified=false;break;}row[@"computeVerified"]=@(verified);row[@"outputWords"]=exact(buffer.length/sizeof(uint32_t));
      if(sample){NSData *data=[sample resolveCounterRange:NSMakeRange(0,2)];row[@"resolvedBytes"]=@(data.length);row[@"resolvedBase64"]=data?[data base64EncodedStringWithOptions:0]:(id)NSNull.null;NSMutableArray *raw=[NSMutableArray new];if(data.length%8==0)for(NSUInteger i=0;i<data.length;i+=8){uint64_t value;memcpy(&value,(const char *)data.bytes+i,8);[raw addObject:exact(value)];}row[@"resolvedNativeUInt64"]=raw;}
    }[samples addObject:row];
  }
  metalProbeProgress(@"compute_complete");
  bool safe=true;for(NSDictionary *row in samples)if(row[@"error"]!=NSNull.null||![row[@"computeVerified"] boolValue])safe=false;
  if(safe)result[@"registryResponseProbe"]=metalRegistryResponseProbe(pipeline,queue,buffer,shouldStop);
  result[@"samples"]=samples;result[@"error"]=NSNull.null;return result;
}
