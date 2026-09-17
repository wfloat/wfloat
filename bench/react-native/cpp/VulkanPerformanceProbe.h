#pragma once
#include "NativeJson.h"
#include <vulkan/vulkan.h>
#include <chrono>
#include <cstring>
#include <vector>
namespace bench {
// Explicit owned work only. Preserve all counters in the selected queue family;
// one pool, all required passes, no extrapolation from a partial pass set.
inline std::string vulkanPerformanceProbe(VkInstance instance,VkPhysicalDevice physical,VkDevice device,uint32_t family,VkBuffer buffer,VkDeviceSize bytes,VkPipeline pipeline,VkPipelineLayout layout,VkDescriptorSet descriptor,bool &retain) {
  auto enumerate=(PFN_vkEnumeratePhysicalDeviceQueueFamilyPerformanceQueryCountersKHR)vkGetInstanceProcAddr(instance,"vkEnumeratePhysicalDeviceQueueFamilyPerformanceQueryCountersKHR");
  auto passes=(PFN_vkGetPhysicalDeviceQueueFamilyPerformanceQueryPassesKHR)vkGetInstanceProcAddr(instance,"vkGetPhysicalDeviceQueueFamilyPerformanceQueryPassesKHR");
  auto acquire=(PFN_vkAcquireProfilingLockKHR)vkGetDeviceProcAddr(device,"vkAcquireProfilingLockKHR");
  auto release=(PFN_vkReleaseProfilingLockKHR)vkGetDeviceProcAddr(device,"vkReleaseProfilingLockKHR");
  auto fail=[](const char *stage,VkResult rc){return jsonObject({{"stage",jsonString(stage)},{"returnCode",std::to_string(rc)}});};
  if(!enumerate||!passes||!acquire||!release)return fail("performance entry points unavailable",VK_ERROR_EXTENSION_NOT_PRESENT);
  uint32_t count=0;auto rc=enumerate(physical,family,&count,nullptr,nullptr);
  if(rc!=VK_SUCCESS)return fail("counter count",rc);
  if(!count||count>4096)return jsonObject({{"reportedCount",std::to_string(count)},{"error",jsonString(count?"4096-counter allocation bound":"no counters")}});
  std::vector<VkPerformanceCounterKHR> counters(count);std::vector<uint32_t> indices(count);
  for(uint32_t i=0;i<count;++i){counters[i].sType=VK_STRUCTURE_TYPE_PERFORMANCE_COUNTER_KHR;indices[i]=i;}
  uint32_t received=count;rc=enumerate(physical,family,&received,counters.data(),nullptr);
  if(rc!=VK_SUCCESS||received!=count)return fail("counter enumeration changed",rc==VK_SUCCESS?VK_INCOMPLETE:rc);
  VkQueryPoolPerformanceCreateInfoKHR info{VK_STRUCTURE_TYPE_QUERY_POOL_PERFORMANCE_CREATE_INFO_KHR};info.queueFamilyIndex=family;info.counterIndexCount=count;info.pCounterIndices=indices.data();uint32_t passCount=0;passes(physical,&info,&passCount);
  if(!passCount||passCount>64)return jsonObject({{"requiredPasses",std::to_string(passCount)},{"error",jsonString("outside bounded 1..64 pass experiment")}});
  struct Owned{VkDevice d;PFN_vkReleaseProfilingLockKHR release;VkQueryPool query=VK_NULL_HANDLE;VkCommandPool pool=VK_NULL_HANDLE;VkFence fence=VK_NULL_HANDLE;bool locked=false,retained=false;
    ~Owned(){if(retained)return;if(fence)vkDestroyFence(d,fence,nullptr);if(pool)vkDestroyCommandPool(d,pool,nullptr);if(query)vkDestroyQueryPool(d,query,nullptr);if(locked)release(d);}} owned{device,release};
  VkQueryPoolCreateInfo qc{VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO};qc.pNext=&info;qc.queryType=VK_QUERY_TYPE_PERFORMANCE_QUERY_KHR;qc.queryCount=1;rc=vkCreateQueryPool(device,&qc,nullptr,&owned.query);if(rc!=VK_SUCCESS)return fail("performance query pool",rc);
  VkAcquireProfilingLockInfoKHR lock{VK_STRUCTURE_TYPE_ACQUIRE_PROFILING_LOCK_INFO_KHR};lock.timeout=100000000ULL;rc=acquire(device,&lock);if(rc!=VK_SUCCESS)return fail("profiling lock (100 ms)",rc);owned.locked=true;
  VkCommandPoolCreateInfo pc{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};pc.queueFamilyIndex=family;rc=vkCreateCommandPool(device,&pc,nullptr,&owned.pool);if(rc!=VK_SUCCESS)return fail("command pool",rc);
  VkCommandBuffer commands[2]{};VkCommandBufferAllocateInfo ca{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};ca.commandPool=owned.pool;ca.level=VK_COMMAND_BUFFER_LEVEL_PRIMARY;ca.commandBufferCount=2;rc=vkAllocateCommandBuffers(device,&ca,commands);if(rc!=VK_SUCCESS)return fail("command buffers",rc);
  VkFenceCreateInfo fc{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};rc=vkCreateFence(device,&fc,nullptr,&owned.fence);if(rc!=VK_SUCCESS)return fail("fence",rc);
  VkQueue queue;vkGetDeviceQueue(device,family,0,&queue);
  const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
  auto submit=[&](VkCommandBuffer command,const void *next)->VkResult{
    auto remaining=std::chrono::duration_cast<std::chrono::nanoseconds>(deadline-std::chrono::steady_clock::now()).count();if(remaining<=0)return VK_TIMEOUT;
    auto result=vkResetFences(device,1,&owned.fence);if(result!=VK_SUCCESS)return result;
    VkSubmitInfo si{VK_STRUCTURE_TYPE_SUBMIT_INFO};si.pNext=next;si.commandBufferCount=1;si.pCommandBuffers=&command;result=vkQueueSubmit(queue,1,&si,owned.fence);if(result!=VK_SUCCESS)return result;
    result=vkWaitForFences(device,1,&owned.fence,VK_TRUE,(uint64_t)remaining);
    if(result==VK_TIMEOUT){owned.retained=true;retain=true;}return result;
  };
  // A performance query cannot be reset in the command buffer that begins it.
  VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};rc=vkBeginCommandBuffer(commands[0],&begin);if(rc!=VK_SUCCESS)return fail("begin reset",rc);vkCmdResetQueryPool(commands[0],owned.query,0,1);rc=vkEndCommandBuffer(commands[0]);if(rc!=VK_SUCCESS)return fail("end reset",rc);rc=submit(commands[0],nullptr);if(rc!=VK_SUCCESS)return fail("reset submission",rc);
  rc=vkBeginCommandBuffer(commands[1],&begin);if(rc!=VK_SUCCESS)return fail("begin workload",rc);
  // First/last command also satisfies COMMAND_BUFFER-scoped counter rules.
  vkCmdBeginQuery(commands[1],owned.query,0,0);
  vkCmdFillBuffer(commands[1],buffer,0,bytes,0x5a5a5a5a);
  if(pipeline){VkMemoryBarrier b{VK_STRUCTURE_TYPE_MEMORY_BARRIER};b.srcAccessMask=VK_ACCESS_TRANSFER_WRITE_BIT;b.dstAccessMask=VK_ACCESS_SHADER_WRITE_BIT;vkCmdPipelineBarrier(commands[1],VK_PIPELINE_STAGE_TRANSFER_BIT,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,0,1,&b,0,nullptr,0,nullptr);vkCmdBindPipeline(commands[1],VK_PIPELINE_BIND_POINT_COMPUTE,pipeline);vkCmdBindDescriptorSets(commands[1],VK_PIPELINE_BIND_POINT_COMPUTE,layout,0,1,&descriptor,0,nullptr);vkCmdDispatch(commands[1],4096,1,1);}
  VkMemoryBarrier b{VK_STRUCTURE_TYPE_MEMORY_BARRIER};b.srcAccessMask=VK_ACCESS_MEMORY_WRITE_BIT;b.dstAccessMask=VK_ACCESS_MEMORY_READ_BIT|VK_ACCESS_MEMORY_WRITE_BIT;vkCmdPipelineBarrier(commands[1],VK_PIPELINE_STAGE_ALL_COMMANDS_BIT,VK_PIPELINE_STAGE_ALL_COMMANDS_BIT,0,1,&b,0,nullptr,0,nullptr);
  vkCmdEndQuery(commands[1],owned.query,0);rc=vkEndCommandBuffer(commands[1]);if(rc!=VK_SUCCESS)return fail("end workload",rc);
  for(uint32_t pass=0;pass<passCount;++pass){VkPerformanceQuerySubmitInfoKHR pi{VK_STRUCTURE_TYPE_PERFORMANCE_QUERY_SUBMIT_INFO_KHR};pi.counterPassIndex=pass;rc=submit(commands[1],&pi);if(rc!=VK_SUCCESS)return jsonObject({{"stage",jsonString("performance pass")},{"returnCode",std::to_string(rc)},{"completedPasses",std::to_string(pass)},{"requiredPasses",std::to_string(passCount)},{"resourcesRetained",retain?"true":"false"}});}
  std::vector<VkPerformanceCounterResultKHR> values(count);rc=vkGetQueryPoolResults(device,owned.query,0,1,values.size()*sizeof(values[0]),values.data(),values.size()*sizeof(values[0]),0);
  std::string rows="[";if(rc==VK_SUCCESS)for(uint32_t i=0;i<count;++i){if(i)rows+=',';std::string value="null";switch(counters[i].storage){case VK_PERFORMANCE_COUNTER_STORAGE_INT32_KHR:value=jsonInteger(values[i].int32);break;case VK_PERFORMANCE_COUNTER_STORAGE_INT64_KHR:value=jsonInteger(values[i].int64);break;case VK_PERFORMANCE_COUNTER_STORAGE_UINT32_KHR:value=jsonInteger(values[i].uint32);break;case VK_PERFORMANCE_COUNTER_STORAGE_UINT64_KHR:value=jsonInteger(values[i].uint64);break;case VK_PERFORMANCE_COUNTER_STORAGE_FLOAT32_KHR:value=jsonReal(values[i].float32);break;case VK_PERFORMANCE_COUNTER_STORAGE_FLOAT64_KHR:value=jsonReal(values[i].float64);break;default:break;}const auto *raw=(const unsigned char*)&values[i];std::string hex;for(size_t j=0;j<sizeof(values[i]);++j){hex+="0123456789abcdef"[raw[j]>>4];hex+="0123456789abcdef"[raw[j]&15];}rows+=jsonObject({{"counterIndex",std::to_string(i)},{"storage",std::to_string(counters[i].storage)},{"unit",std::to_string(counters[i].unit)},{"scope",std::to_string(counters[i].scope)},{"value",value},{"nativeUnionHex",jsonString(hex)}});}rows+=']';
  return jsonObject({{"returnCode",std::to_string(rc)},{"queueFamily",std::to_string(family)},{"completedPasses",std::to_string(passCount)},{"counters",rows},{"scope",jsonString("Explicit repeated owned fill/compute work; native driver units and concurrent-work flags apply. Not passive whole-device utilization.")}});
}
}
