#pragma once
#include "VulkanFields.h"
#include "VulkanPerformanceProbe.h"
#include "VulkanPipelineDiagnostics.h"
#include <algorithm>
#include "shaders/ProbeSpirv.h"
#include <atomic>
#include <vector>
#include <cstring>
namespace bench {
inline std::atomic<bool> &vulkanQuarantined(){static std::atomic<bool> value{false};return value;}
inline std::string vulkanTimingProbe(VkPhysicalDevice physical,const VkPhysicalDeviceProperties &properties,const std::vector<VkQueueFamilyProperties> &families,bool &retainInstance,VkInstance instance,const std::vector<VkExtensionProperties> &extensions,uint32_t requestedFamily=UINT32_MAX) {
  uint32_t family=UINT32_MAX;for(uint32_t i=0;i<families.size();++i)if(families[i].queueCount&&(families[i].queueFlags&(VK_QUEUE_GRAPHICS_BIT|VK_QUEUE_COMPUTE_BIT))){family=i;break;}
  if(requestedFamily!=UINT32_MAX){if(requestedFamily>=families.size()||!families[requestedFamily].queueCount||!(families[requestedFamily].queueFlags&(VK_QUEUE_GRAPHICS_BIT|VK_QUEUE_COMPUTE_BIT)))return jsonObject({{"error",jsonString("Requested queue family cannot record performance queries")}});family=requestedFamily;}
  if(family==UINT32_MAX)return jsonObject({{"error",jsonString("No graphics/compute queue")}});
  struct Resources {
    VkDevice device=VK_NULL_HANDLE;VkBuffer buffer=VK_NULL_HANDLE;VkDeviceMemory memory=VK_NULL_HANDLE;VkCommandPool pool=VK_NULL_HANDLE;VkQueryPool queries=VK_NULL_HANDLE;VkFence fence=VK_NULL_HANDLE;VkQueryPool statistics=VK_NULL_HANDLE;VkDescriptorSetLayout setLayout=VK_NULL_HANDLE;VkDescriptorPool descriptorPool=VK_NULL_HANDLE;VkPipelineLayout pipelineLayout=VK_NULL_HANDLE;VkShaderModule shader=VK_NULL_HANDLE;VkPipeline pipeline=VK_NULL_HANDLE;bool retain=false;
    ~Resources(){if(!device||retain)return;if(fence)vkDestroyFence(device,fence,nullptr);if(pool)vkDestroyCommandPool(device,pool,nullptr);if(queries)vkDestroyQueryPool(device,queries,nullptr);if(statistics)vkDestroyQueryPool(device,statistics,nullptr);if(pipeline)vkDestroyPipeline(device,pipeline,nullptr);if(shader)vkDestroyShaderModule(device,shader,nullptr);if(descriptorPool)vkDestroyDescriptorPool(device,descriptorPool,nullptr);if(pipelineLayout)vkDestroyPipelineLayout(device,pipelineLayout,nullptr);if(setLayout)vkDestroyDescriptorSetLayout(device,setLayout,nullptr);if(buffer)vkDestroyBuffer(device,buffer,nullptr);if(memory)vkFreeMemory(device,memory,nullptr);vkDestroyDevice(device,nullptr);}
  } r;
  const auto failure=[](const char *where,VkResult code){return jsonObject({{"error",jsonString(where)},{"returnCode",std::to_string(code)}});};
  const float priority=1;VkDeviceQueueCreateInfo q{VK_STRUCTURE_TYPE_DEVICE_QUEUE_CREATE_INFO};q.queueFamilyIndex=family;q.queueCount=1;q.pQueuePriorities=&priority;
  VkPhysicalDeviceFeatures supported{},enabled{};vkGetPhysicalDeviceFeatures(physical,&supported);const bool compute=(families[family].queueFlags&VK_QUEUE_COMPUTE_BIT)!=0;const bool computeStatistics=supported.pipelineStatisticsQuery&&compute;enabled.pipelineStatisticsQuery=computeStatistics;
  const auto advertised=[&](const char *name){return std::any_of(extensions.begin(),extensions.end(),[&](const auto&e){return !strcmp(e.extensionName,name);});};
  VkPhysicalDevicePipelineExecutablePropertiesFeaturesKHR executableFeature{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PIPELINE_EXECUTABLE_PROPERTIES_FEATURES_KHR};
  auto featureQuery=(PFN_vkGetPhysicalDeviceFeatures2KHR)vkGetInstanceProcAddr(instance,"vkGetPhysicalDeviceFeatures2KHR");if(!featureQuery)featureQuery=(PFN_vkGetPhysicalDeviceFeatures2KHR)vkGetInstanceProcAddr(instance,"vkGetPhysicalDeviceFeatures2");
  if(compute&&featureQuery&&advertised(VK_KHR_PIPELINE_EXECUTABLE_PROPERTIES_EXTENSION_NAME)){VkPhysicalDeviceFeatures2KHR f{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2_KHR};f.pNext=&executableFeature;featureQuery(physical,&f);}
  VkPhysicalDevicePerformanceQueryFeaturesKHR performanceFeature{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_PERFORMANCE_QUERY_FEATURES_KHR};
  if(featureQuery&&advertised(VK_KHR_PERFORMANCE_QUERY_EXTENSION_NAME)){VkPhysicalDeviceFeatures2KHR f{VK_STRUCTURE_TYPE_PHYSICAL_DEVICE_FEATURES_2_KHR};f.pNext=&performanceFeature;featureQuery(physical,&f);}
  const bool performance=performanceFeature.performanceCounterQueryPools!=0;performanceFeature.performanceCounterMultipleQueryPools=VK_FALSE;
  const bool executable=executableFeature.pipelineExecutableInfo!=0,feedback=compute&&advertised(VK_EXT_PIPELINE_CREATION_FEEDBACK_EXTENSION_NAME),calibrated=advertised(VK_EXT_CALIBRATED_TIMESTAMPS_EXTENSION_NAME);
  std::vector<const char *> enabledExtensions;if(performance)enabledExtensions.push_back(VK_KHR_PERFORMANCE_QUERY_EXTENSION_NAME);if(executable)enabledExtensions.push_back(VK_KHR_PIPELINE_EXECUTABLE_PROPERTIES_EXTENSION_NAME);if(feedback)enabledExtensions.push_back(VK_EXT_PIPELINE_CREATION_FEEDBACK_EXTENSION_NAME);if(calibrated)enabledExtensions.push_back(VK_EXT_CALIBRATED_TIMESTAMPS_EXTENSION_NAME);
  VkPipelineCreationFeedbackEXT pipelineFeedback{},stageFeedback{};std::string executableData="null",beforeCalibration="null",afterCalibration="null";
  VkDeviceCreateInfo dc{VK_STRUCTURE_TYPE_DEVICE_CREATE_INFO};dc.pEnabledFeatures=&enabled;dc.enabledExtensionCount=enabledExtensions.size();dc.ppEnabledExtensionNames=enabledExtensions.data();if(executable)dc.pNext=&executableFeature;if(performance){performanceFeature.pNext=const_cast<void*>(dc.pNext);dc.pNext=&performanceFeature;}dc.queueCreateInfoCount=1;dc.pQueueCreateInfos=&q;auto code=vkCreateDevice(physical,&dc,nullptr,&r.device);if(code!=VK_SUCCESS)return failure("vkCreateDevice",code);
  if(calibrated)beforeCalibration=calibratedTimestamps(instance,physical,r.device);
  VkBufferCreateInfo bc{VK_STRUCTURE_TYPE_BUFFER_CREATE_INFO};bc.size=(compute?2:1)*1024*1024;bc.usage=VK_BUFFER_USAGE_TRANSFER_DST_BIT|VK_BUFFER_USAGE_STORAGE_BUFFER_BIT;bc.sharingMode=VK_SHARING_MODE_EXCLUSIVE;
  code=vkCreateBuffer(r.device,&bc,nullptr,&r.buffer);if(code!=VK_SUCCESS)return failure("vkCreateBuffer",code);
  VkMemoryRequirements requirement{};vkGetBufferMemoryRequirements(r.device,r.buffer,&requirement);VkPhysicalDeviceMemoryProperties memory{};vkGetPhysicalDeviceMemoryProperties(physical,&memory);
  uint32_t type=UINT32_MAX;for(uint32_t i=0;i<memory.memoryTypeCount;++i)if((requirement.memoryTypeBits&(1U<<i))&&(memory.memoryTypes[i].propertyFlags&VK_MEMORY_PROPERTY_HOST_VISIBLE_BIT)){type=i;if(memory.memoryTypes[i].propertyFlags&VK_MEMORY_PROPERTY_HOST_COHERENT_BIT)break;}
  if(type==UINT32_MAX)return jsonObject({{"error",jsonString("No host-visible memory for verification")}});
  VkMemoryAllocateInfo alloc{VK_STRUCTURE_TYPE_MEMORY_ALLOCATE_INFO};alloc.allocationSize=requirement.size;alloc.memoryTypeIndex=type;
  code=vkAllocateMemory(r.device,&alloc,nullptr,&r.memory);if(code!=VK_SUCCESS)return failure("vkAllocateMemory",code);
  code=vkBindBufferMemory(r.device,r.buffer,r.memory,0);if(code!=VK_SUCCESS)return failure("vkBindBufferMemory",code);
  VkCommandPoolCreateInfo pc{VK_STRUCTURE_TYPE_COMMAND_POOL_CREATE_INFO};pc.queueFamilyIndex=family;code=vkCreateCommandPool(r.device,&pc,nullptr,&r.pool);if(code!=VK_SUCCESS)return failure("vkCreateCommandPool",code);
  const bool timestamps=families[family].timestampValidBits>0;
  if(timestamps){VkQueryPoolCreateInfo qc{VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO};qc.queryType=VK_QUERY_TYPE_TIMESTAMP;qc.queryCount=2;code=vkCreateQueryPool(r.device,&qc,nullptr,&r.queries);if(code!=VK_SUCCESS)return failure("vkCreateQueryPool",code);}
  VkDescriptorSet descriptor=VK_NULL_HANDLE;
  if(compute) {
    if(computeStatistics){VkQueryPoolCreateInfo sc{VK_STRUCTURE_TYPE_QUERY_POOL_CREATE_INFO};sc.queryType=VK_QUERY_TYPE_PIPELINE_STATISTICS;sc.queryCount=1;sc.pipelineStatistics=VK_QUERY_PIPELINE_STATISTIC_COMPUTE_SHADER_INVOCATIONS_BIT;code=vkCreateQueryPool(r.device,&sc,nullptr,&r.statistics);if(code!=VK_SUCCESS)return failure("statistics query pool",code);}
    VkDescriptorSetLayoutBinding binding{};binding.binding=0;binding.descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;binding.descriptorCount=1;binding.stageFlags=VK_SHADER_STAGE_COMPUTE_BIT;
    VkDescriptorSetLayoutCreateInfo sl{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_LAYOUT_CREATE_INFO};sl.bindingCount=1;sl.pBindings=&binding;code=vkCreateDescriptorSetLayout(r.device,&sl,nullptr,&r.setLayout);if(code!=VK_SUCCESS)return failure("descriptor layout",code);
    VkPipelineLayoutCreateInfo pl{VK_STRUCTURE_TYPE_PIPELINE_LAYOUT_CREATE_INFO};pl.setLayoutCount=1;pl.pSetLayouts=&r.setLayout;code=vkCreatePipelineLayout(r.device,&pl,nullptr,&r.pipelineLayout);if(code!=VK_SUCCESS)return failure("pipeline layout",code);
    VkShaderModuleCreateInfo sm{VK_STRUCTURE_TYPE_SHADER_MODULE_CREATE_INFO};sm.codeSize=sizeof(probeSpirv);sm.pCode=probeSpirv;code=vkCreateShaderModule(r.device,&sm,nullptr,&r.shader);if(code!=VK_SUCCESS)return failure("shader module",code);
    VkComputePipelineCreateInfo cp{VK_STRUCTURE_TYPE_COMPUTE_PIPELINE_CREATE_INFO};cp.stage.sType=VK_STRUCTURE_TYPE_PIPELINE_SHADER_STAGE_CREATE_INFO;cp.stage.stage=VK_SHADER_STAGE_COMPUTE_BIT;cp.stage.module=r.shader;cp.stage.pName="main";cp.layout=r.pipelineLayout;if(executable)cp.flags|=VK_PIPELINE_CREATE_CAPTURE_STATISTICS_BIT_KHR;VkPipelineCreationFeedbackCreateInfoEXT feedbackInfo{VK_STRUCTURE_TYPE_PIPELINE_CREATION_FEEDBACK_CREATE_INFO_EXT};feedbackInfo.pPipelineCreationFeedback=&pipelineFeedback;feedbackInfo.pipelineStageCreationFeedbackCount=1;feedbackInfo.pPipelineStageCreationFeedbacks=&stageFeedback;if(feedback)cp.pNext=&feedbackInfo;code=vkCreateComputePipelines(r.device,VK_NULL_HANDLE,1,&cp,nullptr,&r.pipeline);if(code!=VK_SUCCESS)return failure("compute pipeline",code);if(executable)executableData=pipelineExecutableDiagnostics(r.device,r.pipeline);
    VkDescriptorPoolSize size{VK_DESCRIPTOR_TYPE_STORAGE_BUFFER,1};VkDescriptorPoolCreateInfo dp{VK_STRUCTURE_TYPE_DESCRIPTOR_POOL_CREATE_INFO};dp.maxSets=1;dp.poolSizeCount=1;dp.pPoolSizes=&size;code=vkCreateDescriptorPool(r.device,&dp,nullptr,&r.descriptorPool);if(code!=VK_SUCCESS)return failure("descriptor pool",code);
    VkDescriptorSetAllocateInfo da{VK_STRUCTURE_TYPE_DESCRIPTOR_SET_ALLOCATE_INFO};da.descriptorPool=r.descriptorPool;da.descriptorSetCount=1;da.pSetLayouts=&r.setLayout;code=vkAllocateDescriptorSets(r.device,&da,&descriptor);if(code!=VK_SUCCESS)return failure("descriptor allocation",code);
    VkDescriptorBufferInfo info{r.buffer,1024*1024,1024*1024};VkWriteDescriptorSet write{VK_STRUCTURE_TYPE_WRITE_DESCRIPTOR_SET};write.dstSet=descriptor;write.dstBinding=0;write.descriptorCount=1;write.descriptorType=VK_DESCRIPTOR_TYPE_STORAGE_BUFFER;write.pBufferInfo=&info;vkUpdateDescriptorSets(r.device,1,&write,0,nullptr);
  }
  VkCommandBufferAllocateInfo ca{VK_STRUCTURE_TYPE_COMMAND_BUFFER_ALLOCATE_INFO};ca.commandPool=r.pool;ca.level=VK_COMMAND_BUFFER_LEVEL_PRIMARY;ca.commandBufferCount=1;VkCommandBuffer command;code=vkAllocateCommandBuffers(r.device,&ca,&command);if(code!=VK_SUCCESS)return failure("vkAllocateCommandBuffers",code);
  VkCommandBufferBeginInfo begin{VK_STRUCTURE_TYPE_COMMAND_BUFFER_BEGIN_INFO};begin.flags=VK_COMMAND_BUFFER_USAGE_ONE_TIME_SUBMIT_BIT;code=vkBeginCommandBuffer(command,&begin);if(code!=VK_SUCCESS)return failure("vkBeginCommandBuffer",code);
  if(timestamps){vkCmdResetQueryPool(command,r.queries,0,2);vkCmdWriteTimestamp(command,VK_PIPELINE_STAGE_TOP_OF_PIPE_BIT,r.queries,0);}
  if(computeStatistics)vkCmdResetQueryPool(command,r.statistics,0,1);
  vkCmdFillBuffer(command,r.buffer,0,bc.size,0x5a5a5a5a);
  if(compute) {
    VkMemoryBarrier computeBarrier{VK_STRUCTURE_TYPE_MEMORY_BARRIER};computeBarrier.srcAccessMask=VK_ACCESS_TRANSFER_WRITE_BIT;computeBarrier.dstAccessMask=VK_ACCESS_SHADER_WRITE_BIT;vkCmdPipelineBarrier(command,VK_PIPELINE_STAGE_TRANSFER_BIT,VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT,0,1,&computeBarrier,0,nullptr,0,nullptr);
    vkCmdBindPipeline(command,VK_PIPELINE_BIND_POINT_COMPUTE,r.pipeline);vkCmdBindDescriptorSets(command,VK_PIPELINE_BIND_POINT_COMPUTE,r.pipelineLayout,0,1,&descriptor,0,nullptr);
    if(computeStatistics)vkCmdBeginQuery(command,r.statistics,0,0);vkCmdDispatch(command,4096,1,1);if(computeStatistics)vkCmdEndQuery(command,r.statistics,0);
  }
  VkMemoryBarrier barrier{VK_STRUCTURE_TYPE_MEMORY_BARRIER};barrier.srcAccessMask=VK_ACCESS_TRANSFER_WRITE_BIT|(compute?VK_ACCESS_SHADER_WRITE_BIT:0);barrier.dstAccessMask=VK_ACCESS_HOST_READ_BIT;vkCmdPipelineBarrier(command,VK_PIPELINE_STAGE_TRANSFER_BIT|(compute?VK_PIPELINE_STAGE_COMPUTE_SHADER_BIT:0),VK_PIPELINE_STAGE_HOST_BIT,0,1,&barrier,0,nullptr,0,nullptr);
  if(timestamps)vkCmdWriteTimestamp(command,VK_PIPELINE_STAGE_BOTTOM_OF_PIPE_BIT,r.queries,1);
  code=vkEndCommandBuffer(command);if(code!=VK_SUCCESS)return failure("vkEndCommandBuffer",code);
  VkFenceCreateInfo fc{VK_STRUCTURE_TYPE_FENCE_CREATE_INFO};code=vkCreateFence(r.device,&fc,nullptr,&r.fence);if(code!=VK_SUCCESS)return failure("vkCreateFence",code);
  VkQueue queue;vkGetDeviceQueue(r.device,family,0,&queue);VkSubmitInfo submit{VK_STRUCTURE_TYPE_SUBMIT_INFO};submit.commandBufferCount=1;submit.pCommandBuffers=&command;
  code=vkQueueSubmit(queue,1,&submit,r.fence);if(code!=VK_SUCCESS)return failure("vkQueueSubmit",code);
  code=vkWaitForFences(r.device,1,&r.fence,VK_TRUE,5000000000ULL);
  if(code!=VK_SUCCESS) {if(code==VK_TIMEOUT){r.retain=true;retainInstance=true;vulkanQuarantined().store(true);}return failure(code==VK_TIMEOUT?"GPU fence timeout: resources retained until process exit; further Vulkan probes disabled":"vkWaitForFences",code);}
  void *mapped=nullptr;code=vkMapMemory(r.device,r.memory,0,VK_WHOLE_SIZE,0,&mapped);if(code!=VK_SUCCESS)return failure("vkMapMemory",code);
  if(!(memory.memoryTypes[type].propertyFlags&VK_MEMORY_PROPERTY_HOST_COHERENT_BIT)){VkMappedMemoryRange range{VK_STRUCTURE_TYPE_MAPPED_MEMORY_RANGE};range.memory=r.memory;range.size=VK_WHOLE_SIZE;code=vkInvalidateMappedMemoryRanges(r.device,1,&range);}
  bool verified=code==VK_SUCCESS,computeVerified=code==VK_SUCCESS;
  if(verified){const auto *bytes=(const unsigned char *)mapped;for(size_t i=0;i<1024*1024;++i)if(bytes[i]!=0x5a){verified=false;break;}
    if(compute){const auto *words=(const uint32_t *)(bytes+1024*1024);for(uint32_t i=0;i<262144;++i)if(words[i]!=(i^0x5a5a5a5aU)){computeVerified=false;break;}}
  }vkUnmapMemory(r.device,r.memory);
  if(calibrated)afterCalibration=calibratedTimestamps(instance,physical,r.device);
  uint64_t statistics[2]{};VkResult statsCode=VK_NOT_READY;if(computeStatistics)statsCode=vkGetQueryPoolResults(r.device,r.statistics,0,1,sizeof(statistics),statistics,sizeof(statistics),VK_QUERY_RESULT_64_BIT|VK_QUERY_RESULT_WITH_AVAILABILITY_BIT);

  uint64_t values[4]{};VkResult queryCode=VK_NOT_READY;if(timestamps)queryCode=vkGetQueryPoolResults(r.device,r.queries,0,2,sizeof(values),values,2*sizeof(uint64_t),VK_QUERY_RESULT_64_BIT|VK_QUERY_RESULT_WITH_AVAILABILITY_BIT);
  std::string performanceData=performance?vulkanPerformanceProbe(instance,physical,r.device,family,r.buffer,bc.size,r.pipeline,r.pipelineLayout,descriptor,retainInstance):jsonObject({{"error",jsonString("performanceCounterQueryPools not supported")}});
  if(retainInstance){r.retain=true;vulkanQuarantined().store(true);}
  const auto feedbackJson=[](const VkPipelineCreationFeedbackEXT &v){return jsonObject({{"flags",jsonInteger(v.flags)},{"valid",(v.flags&VK_PIPELINE_CREATION_FEEDBACK_VALID_BIT_EXT)?"true":"false"},{"durationNanoseconds",(v.flags&VK_PIPELINE_CREATION_FEEDBACK_VALID_BIT_EXT)?jsonInteger(v.duration):"null"}});};
  return jsonObject({{"performanceCounterSample",performanceData},{"computeWorkSubmitted",compute?"true":"false"},{"pipelineExecutableInfoEnabled",executable?"true":"false"},{"pipelineExecutables",executableData},{"pipelineCreationFeedback",feedback?feedbackJson(pipelineFeedback):"null"},{"stageCreationFeedback",feedback?feedbackJson(stageFeedback):"null"},{"calibratedTimestampsBefore",beforeCalibration},{"calibratedTimestampsAfter",afterCalibration},{"error",code==VK_SUCCESS?"null":jsonString("vkInvalidateMappedMemoryRanges failed")},{"returnCode",std::to_string(code)},{"fillVerified",verified?"true":"false"},{"fillBytes",jsonInteger(1024*1024)},{"computeStatisticsEnabled",computeStatistics?"true":"false"},{"computeVerified",compute?(computeVerified?"true":"false"):"null"},{"expectedComputeInvocations",compute?jsonInteger(262144):"null"},{"computeInvocations",computeStatistics&&statsCode==VK_SUCCESS&&statistics[1]?jsonInteger(statistics[0]):"null"},{"computeCounterAvailable",computeStatistics&&(statsCode==VK_SUCCESS||statsCode==VK_NOT_READY)?jsonInteger(statistics[1]):"null"},{"statisticsQueryReturnCode",std::to_string(statsCode)},{"allocationBytes",jsonInteger(requirement.size)},{"memoryTypeIndex",jsonInteger(type)},{"queueFamily",jsonInteger(family)},{"timestampValidBits",jsonInteger(families[family].timestampValidBits)},{"timestampPeriodNanoseconds",jsonReal(properties.limits.timestampPeriod)},{"timestampQueryReturnCode",std::to_string(queryCode)},{"startTicks",timestamps&&(queryCode==VK_SUCCESS||queryCode==VK_NOT_READY)&&values[1]?jsonInteger(values[0]):"null"},{"startAvailable",timestamps&&(queryCode==VK_SUCCESS||queryCode==VK_NOT_READY)?jsonInteger(values[1]):"null"},{"endTicks",timestamps&&(queryCode==VK_SUCCESS||queryCode==VK_NOT_READY)&&values[3]?jsonInteger(values[2]):"null"},{"endAvailable",timestamps&&(queryCode==VK_SUCCESS||queryCode==VK_NOT_READY)?jsonInteger(values[3]):"null"}});
}
}
