#pragma once
#include "VulkanFields.h"
#include "VulkanTimingProbe.h"
#include "VulkanExtendedFields.h"
#include <vector>
#include <algorithm>
#include <cstring>
namespace bench {
inline std::string vulkanSignalProbe() {
  if(vulkanQuarantined().load())return jsonObject({{"error",jsonString("Previous GPU timeout; restart app before probing again")}});
  uint32_t extensionCount=0;VkResult ec=vkEnumerateInstanceExtensionProperties(nullptr,&extensionCount,nullptr);
  if(ec!=VK_SUCCESS||extensionCount>1024)return jsonObject({{"error",jsonString("instance extension enumeration failed")},{"returnCode",std::to_string(ec)}});
  std::vector<VkExtensionProperties> extensions(extensionCount);ec=vkEnumerateInstanceExtensionProperties(nullptr,&extensionCount,extensions.data());
  const char *propertiesExtension=VK_KHR_GET_PHYSICAL_DEVICE_PROPERTIES_2_EXTENSION_NAME;
  const bool properties2=std::any_of(extensions.begin(),extensions.end(),[&](const auto&e){return !strcmp(e.extensionName,propertiesExtension);});
  uint32_t loaderVersion=VK_API_VERSION_1_0;auto enumerateVersion=(PFN_vkEnumerateInstanceVersion)vkGetInstanceProcAddr(VK_NULL_HANDLE,"vkEnumerateInstanceVersion");if(enumerateVersion&&enumerateVersion(&loaderVersion)!=VK_SUCCESS)loaderVersion=VK_API_VERSION_1_0;
  VkApplicationInfo app{VK_STRUCTURE_TYPE_APPLICATION_INFO};app.pApplicationName="Wfloat OS probe";app.apiVersion=std::min(loaderVersion,VK_API_VERSION_1_3);
  VkInstanceCreateInfo create{VK_STRUCTURE_TYPE_INSTANCE_CREATE_INFO};create.pApplicationInfo=&app;if(properties2){create.enabledExtensionCount=1;create.ppEnabledExtensionNames=&propertiesExtension;}
  struct Instance {VkInstance v=VK_NULL_HANDLE;~Instance(){if(v)vkDestroyInstance(v,nullptr);}} instance;
  const auto code=vkCreateInstance(&create,nullptr,&instance.v);if(code!=VK_SUCCESS)return jsonObject({{"error",jsonString("vkCreateInstance failed")},{"returnCode",std::to_string(code)}});
  uint32_t count=0;auto rc=vkEnumeratePhysicalDevices(instance.v,&count,nullptr);if(rc!=VK_SUCCESS||count>16)return jsonObject({{"error",jsonString("physical device enumeration failed")},{"returnCode",std::to_string(rc)}});
  std::vector<VkPhysicalDevice> devices(count);rc=vkEnumeratePhysicalDevices(instance.v,&count,devices.data());
  if(rc!=VK_SUCCESS)return jsonObject({{"error",jsonString("physical device enumeration incomplete")},{"returnCode",std::to_string(rc)}});
  auto memory2=(PFN_vkGetPhysicalDeviceMemoryProperties2KHR)vkGetInstanceProcAddr(instance.v,"vkGetPhysicalDeviceMemoryProperties2KHR");
  std::string rows="[";bool first=true;
  for(auto device:devices) {
    VkPhysicalDeviceProperties p{};vkGetPhysicalDeviceProperties(device,&p);VkPhysicalDeviceFeatures features{};vkGetPhysicalDeviceFeatures(device,&features);
    uint32_t n=0;auto extCode=vkEnumerateDeviceExtensionProperties(device,nullptr,&n,nullptr);std::vector<VkExtensionProperties> exts(std::min(n,1024U));uint32_t allocated=exts.size();
    if(extCode==VK_SUCCESS)extCode=vkEnumerateDeviceExtensionProperties(device,nullptr,&allocated,exts.data());exts.resize(std::min<size_t>(allocated,exts.size()));
    std::string extRows="[";bool budget=false;for(size_t i=0;i<exts.size();++i){if(i)extRows+=',';extRows+=jsonObject({{"name",jsonString(exts[i].extensionName)},{"specVersion",jsonInteger(exts[i].specVersion)}});if(!strcmp(exts[i].extensionName,VK_EXT_MEMORY_BUDGET_EXTENSION_NAME))budget=true;}extRows+=']';
    VkPhysicalDeviceMemoryProperties memory{};vkGetPhysicalDeviceMemoryProperties(device,&memory);
    VkPhysicalDeviceMemoryBudgetPropertiesEXT b{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MEMORY_BUDGET_PROPERTIES_EXT};
    if(budget&&properties2&&memory2){VkPhysicalDeviceMemoryProperties2KHR m{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_MEMORY_PROPERTIES_2_KHR};m.pNext=&b;memory2(device,&m);memory=m.memoryProperties;}
    else budget=false;
    std::string heaps="[",types="[";for(uint32_t i=0;i<memory.memoryHeapCount;++i){if(i)heaps+=',';heaps+=jsonObject({{"index",std::to_string(i)},{"size",jsonInteger(memory.memoryHeaps[i].size)},{"flags",jsonInteger(memory.memoryHeaps[i].flags)},{"heapBudget",budget?jsonInteger(b.heapBudget[i]):"null"},{"heapUsage",budget?jsonInteger(b.heapUsage[i]):"null"}});}heaps+=']';
    for(uint32_t i=0;i<memory.memoryTypeCount;++i){if(i)types+=',';types+=jsonObject({{"index",std::to_string(i)},{"heapIndex",std::to_string(memory.memoryTypes[i].heapIndex)},{"propertyFlags",jsonInteger(memory.memoryTypes[i].propertyFlags)}});}types+=']';
    uint32_t qn=0;vkGetPhysicalDeviceQueueFamilyProperties(device,&qn,nullptr);std::vector<VkQueueFamilyProperties> queues(std::min(qn,256U));uint32_t qc=queues.size();vkGetPhysicalDeviceQueueFamilyProperties(device,&qc,queues.data());
    std::string qs="[";for(uint32_t i=0;i<std::min<uint32_t>(qc,queues.size());++i){if(i)qs+=',';const auto&q=queues[i];qs+=jsonObject({{"index",std::to_string(i)},{"queueFlags",jsonInteger(q.queueFlags)},{"queueCount",jsonInteger(q.queueCount)},{"timestampValidBits",jsonInteger(q.timestampValidBits)},{"minImageTransferGranularity",jsonObject({{"width",jsonInteger(q.minImageTransferGranularity.width)},{"height",jsonInteger(q.minImageTransferGranularity.height)},{"depth",jsonInteger(q.minImageTransferGranularity.depth)}})}});}qs+=']';
    std::string performance="[]";
    const bool hasPerformance=std::any_of(exts.begin(),exts.end(),[](const auto&e){return !strcmp(e.extensionName,VK_KHR_PERFORMANCE_QUERY_EXTENSION_NAME);});
    auto enumeratePerformance=(PFN_vkEnumeratePhysicalDeviceQueueFamilyPerformanceQueryCountersKHR)vkGetInstanceProcAddr(instance.v,"vkEnumeratePhysicalDeviceQueueFamilyPerformanceQueryCountersKHR");
    if(hasPerformance&&properties2&&enumeratePerformance) {
      performance="[";
      for(uint32_t family=0;family<queues.size();++family){if(family)performance+=',';uint32_t total=0;auto result=enumeratePerformance(device,family,&total,nullptr,nullptr);uint32_t capacity=std::min(total,4096U);
        std::vector<VkPerformanceCounterKHR> counters(capacity);std::vector<VkPerformanceCounterDescriptionKHR> descriptions(capacity);for(auto&v:counters)v.sType=VK_STRUCTURE_TYPE_PERFORMANCE_COUNTER_KHR;for(auto&v:descriptions)v.sType=VK_STRUCTURE_TYPE_PERFORMANCE_COUNTER_DESCRIPTION_KHR;
        if(result==VK_SUCCESS&&capacity)result=enumeratePerformance(device,family,&capacity,counters.data(),descriptions.data());std::string counterRows="[";
        if(result==VK_SUCCESS||result==VK_INCOMPLETE)for(uint32_t i=0;i<std::min<uint32_t>(capacity,counters.size());++i){if(i)counterRows+=',';const auto&c=counters[i];const auto&d=descriptions[i];std::string uuid;const char *hex="0123456789abcdef";for(auto byte:c.uuid){uuid+=hex[byte>>4];uuid+=hex[byte&15];}counterRows+=jsonObject({{"index",std::to_string(i)},{"uuidHex",jsonString(uuid)},{"unit",jsonInteger(c.unit)},{"scope",jsonInteger(c.scope)},{"storage",jsonInteger(c.storage)},{"flags",jsonInteger(d.flags)},{"name",jsonString(d.name)},{"category",jsonString(d.category)},{"description",jsonString(d.description)}});}counterRows+=']';
        performance+=jsonObject({{"queueFamily",std::to_string(family)},{"returnCode",std::to_string(result)},{"reportedCount",std::to_string(total)},{"complete",result==VK_SUCCESS&&total<=counters.size()?"true":"false"},{"counters",counterRows}});
      }performance+=']';
    }
    std::string extended=jsonObject({{"error",jsonString("aggregate Vulkan 1.1/1.2 properties require negotiated API 1.2")}});
    const uint32_t negotiated=std::min(app.apiVersion,p.apiVersion);
    auto getProperties=(PFN_vkGetPhysicalDeviceProperties2)vkGetInstanceProcAddr(instance.v,"vkGetPhysicalDeviceProperties2");auto getFeatures=(PFN_vkGetPhysicalDeviceFeatures2)vkGetInstanceProcAddr(instance.v,"vkGetPhysicalDeviceFeatures2");
    if(negotiated>=VK_API_VERSION_1_2&&getProperties&&getFeatures) {
      VkPhysicalDeviceVulkan11Properties p11{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_PROPERTIES};VkPhysicalDeviceVulkan12Properties p12{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_PROPERTIES};VkPhysicalDeviceVulkan13Properties p13{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_PROPERTIES};
      VkPhysicalDeviceVulkan11Features f11{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_1_FEATURES};VkPhysicalDeviceVulkan12Features f12{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_2_FEATURES};VkPhysicalDeviceVulkan13Features f13{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_VULKAN_1_3_FEATURES};
      p11.pNext=&p12;f11.pNext=&f12;if(negotiated>=VK_API_VERSION_1_3){p12.pNext=&p13;f12.pNext=&f13;}
      VkPhysicalDeviceProperties2 properties{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PROPERTIES_2};properties.pNext=&p11;getProperties(device,&properties);VkPhysicalDeviceFeatures2 features2{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2};features2.pNext=&f11;getFeatures(device,&features2);
      extended=jsonObject({{"queriedApiVersion",jsonInteger(negotiated)},{"vulkan11Properties",vulkanExtendedFields(p11)},{"vulkan11Features",vulkanExtendedFields(f11)},{"vulkan12Properties",vulkanExtendedFields(p12)},{"vulkan12Features",vulkanExtendedFields(f12)},{"vulkan13Properties",negotiated>=VK_API_VERSION_1_3?vulkanExtendedFields(p13):"null"},{"vulkan13Features",negotiated>=VK_API_VERSION_1_3?vulkanExtendedFields(f13):"null"}});
    }
    bool retain=false;const auto timing=vulkanTimingProbe(device,p,queues,retain,instance.v,exts);
    std::string additional="[";bool firstFamily=true,skippedPrimary=false,additionalLimited=false;const auto additionalDeadline=std::chrono::steady_clock::now()+std::chrono::seconds(10);
    if(hasPerformance&&!retain)for(uint32_t f=0;f<queues.size();++f){if(!queues[f].queueCount||!(queues[f].queueFlags&(VK_QUEUE_GRAPHICS_BIT|VK_QUEUE_COMPUTE_BIT)))continue;if(!skippedPrimary){skippedPrimary=true;continue;}if(std::chrono::steady_clock::now()>=additionalDeadline){additionalLimited=true;break;}if(!firstFamily)additional+=',';firstFamily=false;additional+=jsonObject({{"queueFamily",std::to_string(f)},{"probe",vulkanTimingProbe(device,p,queues,retain,instance.v,exts,f)}});if(retain)break;}
    additional+=']';if(retain)instance.v=VK_NULL_HANDLE;
    if(!first)rows+=',';first=false;rows+=jsonObject({{"additionalPerformanceQueueLimitReached",additionalLimited?"true":"false"},{"additionalPerformanceQueueFamilies",additional},{"extendedCore",extended},{"performanceCounterExtensionAdvertised",hasPerformance?"true":"false"},{"performanceCounterEnumerationCallable",properties2&&enumeratePerformance?"true":"false"},{"performanceCounters",performance},{"timingProbe",timing},{"name",jsonString(p.deviceName)},{"apiVersion",jsonInteger(p.apiVersion)},{"driverVersion",jsonInteger(p.driverVersion)},{"vendorID",jsonInteger(p.vendorID)},{"deviceID",jsonInteger(p.deviceID)},{"deviceType",jsonInteger(p.deviceType)},{"limits",vulkanFields(p.limits)},{"features",vulkanFields(features)},{"sparseProperties",vulkanFields(p.sparseProperties)},{"extensionsReturnCode",std::to_string(extCode)},{"extensions",extRows},{"memoryBudgetAvailable",budget?"true":"false"},{"memoryHeaps",heaps},{"memoryTypes",types},{"queueFamilies",qs},{"queueFamiliesComplete",qn<=queues.size()?"true":"false"}});
    if(retain)break;
  }
  rows+=']';return jsonObject({{"error","null"},{"devices",rows},{"loaderApiVersion",jsonInteger(loaderVersion)},{"requestedApiVersion",jsonInteger(app.apiVersion)},{"instanceExtensionReturnCode",std::to_string(ec)},{"scope",jsonString("explicit Vulkan driver discovery and current process memory estimates")}});
}
}
