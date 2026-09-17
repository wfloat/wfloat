#include "../VulkanPerformanceProbe.h"
#include <cassert>
#include <cstdio>
#include <cstring>
#include <cstdint>
namespace {
bool locked=false;int activeCommands=0,passesSeen=0,resetSubmissions=0,freedPools=0,released=0;bool timeoutMode=false;
VkCommandBuffer resetCommand=(VkCommandBuffer)uintptr_t(10),workCommand=(VkCommandBuffer)uintptr_t(11);bool resetRecorded=false,queryBegun=false,queryEnded=false;
VKAPI_ATTR VkResult VKAPI_CALL enumerate(VkPhysicalDevice,uint32_t,uint32_t *n,VkPerformanceCounterKHR *c,VkPerformanceCounterDescriptionKHR*){if(!c){*n=6;return VK_SUCCESS;}assert(*n==6);for(unsigned i=0;i<6;++i){c[i].storage=(VkPerformanceCounterStorageKHR)i;c[i].scope=VK_PERFORMANCE_COUNTER_SCOPE_COMMAND_BUFFER_KHR;}return VK_SUCCESS;}
VKAPI_ATTR void VKAPI_CALL passCount(VkPhysicalDevice,const VkQueryPoolPerformanceCreateInfoKHR *p,uint32_t *n){assert(p->counterIndexCount==6);for(unsigned i=0;i<6;++i)assert(p->pCounterIndices[i]==i);*n=3;}
VKAPI_ATTR VkResult VKAPI_CALL acquire(VkDevice,const VkAcquireProfilingLockInfoKHR *p){assert(p->timeout==100000000ULL);locked=true;return VK_SUCCESS;}
VKAPI_ATTR void VKAPI_CALL release(VkDevice){assert(locked&&freedPools);locked=false;++released;}
}
extern "C" {
VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL vkGetInstanceProcAddr(VkInstance,const char *n){if(!strcmp(n,"vkEnumeratePhysicalDeviceQueueFamilyPerformanceQueryCountersKHR"))return (PFN_vkVoidFunction)enumerate;if(!strcmp(n,"vkGetPhysicalDeviceQueueFamilyPerformanceQueryPassesKHR"))return (PFN_vkVoidFunction)passCount;return nullptr;}
VKAPI_ATTR PFN_vkVoidFunction VKAPI_CALL vkGetDeviceProcAddr(VkDevice,const char *n){if(!strcmp(n,"vkAcquireProfilingLockKHR"))return (PFN_vkVoidFunction)acquire;if(!strcmp(n,"vkReleaseProfilingLockKHR"))return (PFN_vkVoidFunction)release;return nullptr;}
VKAPI_ATTR VkResult VKAPI_CALL vkCreateQueryPool(VkDevice,const VkQueryPoolCreateInfo *p,const VkAllocationCallbacks*,VkQueryPool *v){assert(p->queryType==VK_QUERY_TYPE_PERFORMANCE_QUERY_KHR&&p->queryCount==1);*v=(VkQueryPool)uintptr_t(1);return VK_SUCCESS;}
VKAPI_ATTR VkResult VKAPI_CALL vkCreateCommandPool(VkDevice,const VkCommandPoolCreateInfo*,const VkAllocationCallbacks*,VkCommandPool *v){*v=(VkCommandPool)uintptr_t(2);return VK_SUCCESS;}
VKAPI_ATTR VkResult VKAPI_CALL vkAllocateCommandBuffers(VkDevice,const VkCommandBufferAllocateInfo *p,VkCommandBuffer *v){assert(p->commandBufferCount==2);v[0]=resetCommand;v[1]=workCommand;return VK_SUCCESS;}
VKAPI_ATTR VkResult VKAPI_CALL vkCreateFence(VkDevice,const VkFenceCreateInfo*,const VkAllocationCallbacks*,VkFence *v){*v=(VkFence)uintptr_t(3);return VK_SUCCESS;}
VKAPI_ATTR void VKAPI_CALL vkGetDeviceQueue(VkDevice,uint32_t,uint32_t,VkQueue *v){*v=(VkQueue)uintptr_t(4);}
VKAPI_ATTR VkResult VKAPI_CALL vkBeginCommandBuffer(VkCommandBuffer,const VkCommandBufferBeginInfo *p){assert(locked&&!(p->flags&VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT));activeCommands=0;return VK_SUCCESS;}
VKAPI_ATTR void VKAPI_CALL vkCmdResetQueryPool(VkCommandBuffer c,VkQueryPool,uint32_t,uint32_t){assert(c==resetCommand);resetRecorded=true;++activeCommands;}
VKAPI_ATTR void VKAPI_CALL vkCmdBeginQuery(VkCommandBuffer c,VkQueryPool,uint32_t,VkQueryControlFlags){assert(c==workCommand&&activeCommands==0&&resetSubmissions==1);queryBegun=true;++activeCommands;}
VKAPI_ATTR void VKAPI_CALL vkCmdFillBuffer(VkCommandBuffer,VkBuffer,VkDeviceSize,VkDeviceSize,uint32_t){assert(queryBegun&&!queryEnded);++activeCommands;}
VKAPI_ATTR void VKAPI_CALL vkCmdPipelineBarrier(VkCommandBuffer,VkPipelineStageFlags,VkPipelineStageFlags,VkDependencyFlags,uint32_t,const VkMemoryBarrier*,uint32_t,const VkBufferMemoryBarrier*,uint32_t,const VkImageMemoryBarrier*){assert(!queryEnded);++activeCommands;}
VKAPI_ATTR void VKAPI_CALL vkCmdBindPipeline(VkCommandBuffer,VkPipelineBindPoint,VkPipeline){assert(!queryEnded);++activeCommands;}
VKAPI_ATTR void VKAPI_CALL vkCmdBindDescriptorSets(VkCommandBuffer,VkPipelineBindPoint,VkPipelineLayout,uint32_t,uint32_t,const VkDescriptorSet*,uint32_t,const uint32_t*){assert(!queryEnded);++activeCommands;}
VKAPI_ATTR void VKAPI_CALL vkCmdDispatch(VkCommandBuffer,uint32_t,uint32_t,uint32_t){assert(!queryEnded);++activeCommands;}
VKAPI_ATTR void VKAPI_CALL vkCmdEndQuery(VkCommandBuffer c,VkQueryPool,uint32_t){assert(c==workCommand);queryEnded=true;++activeCommands;}
VKAPI_ATTR VkResult VKAPI_CALL vkEndCommandBuffer(VkCommandBuffer c){assert(c==resetCommand?resetRecorded:queryEnded);return VK_SUCCESS;}
VKAPI_ATTR VkResult VKAPI_CALL vkResetFences(VkDevice,uint32_t,const VkFence*){return VK_SUCCESS;}
VKAPI_ATTR VkResult VKAPI_CALL vkQueueSubmit(VkQueue,uint32_t n,const VkSubmitInfo *p,VkFence){assert(n==1&&locked);if(*p->pCommandBuffers==resetCommand){assert(!p->pNext);++resetSubmissions;}else{const auto *v=(const VkPerformanceQuerySubmitInfoKHR*)p->pNext;assert(v&&v->counterPassIndex==(unsigned)passesSeen&&queryEnded);++passesSeen;}return VK_SUCCESS;}
VKAPI_ATTR VkResult VKAPI_CALL vkWaitForFences(VkDevice,uint32_t,const VkFence*,VkBool32,uint64_t timeout){assert(timeout>0&&timeout<=5000000000ULL);return timeoutMode&&passesSeen?VK_TIMEOUT:VK_SUCCESS;}
VKAPI_ATTR VkResult VKAPI_CALL vkGetQueryPoolResults(VkDevice,VkQueryPool,uint32_t,uint32_t,size_t n,void *p,VkDeviceSize stride,VkQueryResultFlags flags){assert(passesSeen==3&&flags==0&&n==48&&stride==48);auto *v=(VkPerformanceCounterResultKHR*)p;v[0].int32=-3;v[1].int64=-9007199254740993LL;v[2].uint32=4000000000U;v[3].uint64=UINT64_MAX;v[4].float32=1.25f;v[5].float64=2.5;return VK_SUCCESS;}
VKAPI_ATTR void VKAPI_CALL vkDestroyFence(VkDevice,VkFence,const VkAllocationCallbacks*){}
VKAPI_ATTR void VKAPI_CALL vkDestroyCommandPool(VkDevice,VkCommandPool,const VkAllocationCallbacks*){assert(locked);++freedPools;}
VKAPI_ATTR void VKAPI_CALL vkDestroyQueryPool(VkDevice,VkQueryPool,const VkAllocationCallbacks*){assert(freedPools&&locked);}
}
int main(){bool retain=false;auto run=[&]{return bench::vulkanPerformanceProbe((VkInstance)uintptr_t(1),(VkPhysicalDevice)uintptr_t(1),(VkDevice)uintptr_t(1),0,(VkBuffer)uintptr_t(1),4096,VK_NULL_HANDLE,VK_NULL_HANDLE,VK_NULL_HANDLE,retain);};auto result=run();assert(!retain&&!locked&&released==1&&passesSeen==3);assert(result.find("-9007199254740993")!=std::string::npos&&result.find("18446744073709551615")!=std::string::npos);passesSeen=resetSubmissions=freedPools=released=0;resetRecorded=queryBegun=queryEnded=false;timeoutMode=true;result=run();assert(retain&&locked&&freedPools==0&&released==0&&passesSeen==1);puts("PASS: separate reset, first/last query commands, all passes, exact typed results, lock lifetime and pending-timeout retention");}
