#pragma once
#include "PowerRegistrySource.h"
#include "HIDSensorSources.h"
// Reuses the verified compute pipeline. Explicit bounded activity, not part of
// passive collection. Driver-wide percentages retain unknown averaging windows.
static NSDictionary *metalRegistryResponseProbe(id<MTLComputePipelineState> pipeline,id<MTLCommandQueue> queue,id<MTLBuffer> buffer,BOOL (^shouldStop)(void)) {
  NSMutableArray *observations=[NSMutableArray new];
  auto observe=[&](NSString *phase){[observations addObject:@{@"phase":phase,@"uptimeSeconds":@(NSProcessInfo.processInfo.systemUptime),@"registry":registryPropertySource(@"IOGPU"),@"hidSensors":hidSensorSources(false)}];};
  observe(@"before");metalProbeProgress(@"registry_response_load_start");
  const double start=NSProcessInfo.processInfo.systemUptime;double next=start+2;uint64_t batches=0;NSString *failure=nil;
  while(NSProcessInfo.processInfo.systemUptime-start<20){@autoreleasepool{
    if(shouldStop&&shouldStop()){failure=@"foreground ended or collector closed";break;}
    if(NSProcessInfo.processInfo.thermalState>=NSProcessInfoThermalStateSerious){failure=@"stopped at serious/critical thermal state";break;}
    id<MTLCommandBuffer> command=[queue commandBuffer];id<MTLComputeCommandEncoder> encoder=[command computeCommandEncoder];
    if(!command||!encoder){failure=@"command/encoder unavailable";break;}
    [encoder setComputePipelineState:pipeline];[encoder setBuffer:buffer offset:0 atIndex:0];
    for(unsigned i=0;i<64;++i)[encoder dispatchThreadgroups:MTLSizeMake(buffer.length/sizeof(uint32_t)/64,1,1) threadsPerThreadgroup:MTLSizeMake(64,1,1)];
    [encoder endEncoding];dispatch_semaphore_t done=dispatch_semaphore_create(0);
    [command addCompletedHandler:^(id<MTLCommandBuffer> c){dispatch_semaphore_signal(done);}];[command commit];
    if(dispatch_semaphore_wait(done,dispatch_time(DISPATCH_TIME_NOW,5*NSEC_PER_SEC))){failure=@"GPU completion exceeded 5 seconds";break;}
    if(command.status!=MTLCommandBufferStatusCompleted){failure=command.error.description?:@"GPU command failed";break;}
    ++batches;const double now=NSProcessInfo.processInfo.systemUptime;if(now>=next){observe(@"load");next=now+2;}
  }}
  const double finished=NSProcessInfo.processInfo.systemUptime;observe(@"after_load");
  bool verified=batches>0&&!failure;const uint32_t *words=(const uint32_t *)buffer.contents;
  if(verified)for(NSUInteger i=0;i<buffer.length/sizeof(uint32_t);++i)if(words[i]!=uint32_t(((i/64)*64+(63-i%64))^0x5a5a5a5aU)){verified=false;break;}
  // Never inspect potentially in-flight output after a timeout; the command
  // retains its resources until completion. No further work is submitted.
  if(!failure){for(unsigned i=0;i<50;++i){if(shouldStop&&shouldStop()){failure=@"foreground ended during recovery";break;}[NSThread sleepForTimeInterval:0.1];}if(!failure)observe(@"recovery");}
  metalProbeProgress(@"registry_response_complete");
  return @{@"observations":observations,@"completedBatches":exact(batches),@"dispatchesPerBatch":@64,@"outputVerified":@(verified),@"loadStartedUptimeSeconds":@(start),@"loadFinishedUptimeSeconds":@(finished),@"requestedLoadSeconds":@20,@"error":failure?:(id)NSNull.null,@"scope":@"owned repeated compute; registry is whole-driver accounting with unknown averaging/caching, not app-attributed utilization; synchronous explicit probe pauses this module's ordinary sampler"};
}
