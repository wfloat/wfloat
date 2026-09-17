#pragma once
#include "NativeJson.h"
#include <sys/ioctl.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstdint>
#include <cerrno>
#include <vector>
#include <algorithm>
#include <chrono>
namespace bench {
struct KgslProperty {uint32_t type;void *value;size_t bytes;};
struct KgslDeviceInfo {uint32_t device,chip,mmu;unsigned long gmemAddress;uint32_t legacyGpuId;size_t gmemBytes;};
static_assert(sizeof(KgslProperty)==(sizeof(void*)==8?24:12));
static_assert(sizeof(KgslDeviceInfo)==(sizeof(void*)==8?40:24));
struct KgslCounterQuery {uint32_t group;uint32_t *countables;uint32_t count,maximum,pad[2];};
struct KgslCounterValue {uint32_t group,countable;uint64_t value;};
struct KgslCounterRead {KgslCounterValue *values;uint32_t count,pad[2];};
static_assert(sizeof(KgslCounterQuery)==(sizeof(void*)==8?32:24));
static_assert(sizeof(KgslCounterRead)==(sizeof(void*)==8?24:16));
static_assert(sizeof(KgslCounterValue)==16);
inline std::string kgslCounterSource(){
  const int fd=open("/dev/kgsl-3d0",O_RDONLY|O_CLOEXEC);if(fd<0)return jsonObject({{"stage",jsonString("open /dev/kgsl-3d0")},{"errno",std::to_string(errno)}});
  struct Owner{int fd;~Owner(){close(fd);}}owner{fd};
  const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
  std::string properties="[";KgslDeviceInfo device{};KgslProperty property{1,&device,sizeof(device)};errno=0;int propertyRc=ioctl(fd,_IOWR(0x09,0x02,KgslProperty),&property);int propertyError=propertyRc?errno:0;
  properties+=jsonObject({{"name",jsonString("DEVICE_INFO")},{"errno",std::to_string(propertyError)},{"gmemCapacityBytes",propertyRc?"null":jsonInteger(device.gmemBytes)},{"chipId",propertyRc?"null":jsonInteger(device.chip)},{"mmuEnabled",propertyRc?"null":jsonInteger(device.mmu)},{"scope",jsonString("On-chip graphics tile-memory capacity, not current usage or system GPU allocations. Legacy GPU ID and address placeholders are not measurements.")}});
  struct Item{uint32_t id;const char *name;};const Item items[]={{0x17,"HIGHEST_BANK_BIT"},{0x1a,"MIN_ACCESS_LENGTH"},{0x1b,"UBWC_MODE"},{0x18,"DEVICE_BITNESS"},{0x25,"SPEED_BIN"},{0x2a,"VK_DEVICE_ID"},{0x2b,"IS_LPAC_ENABLED"}};
  for(auto item:items){uint32_t value=0;property={item.id,&value,sizeof(value)};errno=0;propertyRc=ioctl(fd,_IOWR(0x09,0x02,KgslProperty),&property);propertyError=propertyRc?errno:0;properties+=',';properties+=jsonObject({{"name",jsonString(item.name)},{"errno",std::to_string(propertyError)},{"nativeValue",propertyRc?"null":jsonInteger(value)}});}
  uint32_t firmware[2]{};property={0x15,firmware,sizeof(firmware)};errno=0;propertyRc=ioctl(fd,_IOWR(0x09,0x02,KgslProperty),&property);propertyError=propertyRc?errno:0;properties+=',';properties+=jsonObject({{"name",jsonString("UCODE_VERSION")},{"errno",std::to_string(propertyError)},{"pfp",propertyRc?"null":jsonInteger(firmware[0])},{"pm4",propertyRc?"null":jsonInteger(firmware[1])}});uint64_t vaBytes=0;property={0x2c,&vaBytes,sizeof(vaBytes)};errno=0;propertyRc=ioctl(fd,_IOWR(0x09,0x02,KgslProperty),&property);propertyError=propertyRc?errno:0;properties+=',';properties+=jsonObject({{"name",jsonString("GPU_VA64_SIZE")},{"errno",std::to_string(propertyError)},{"virtualAddressCapacityBytes",propertyRc?"null":jsonInteger(vaBytes)}});properties+=']';
  std::string groups="[";std::vector<KgslCounterValue> reads;bool first=true,complete=false,limited=false;
  for(uint32_t group=0;group<128;++group){
    if(std::chrono::steady_clock::now()>=deadline){limited=true;break;}
    KgslCounterQuery q{};q.group=group;errno=0;int rc=ioctl(fd,_IOWR(0x09,0x3a,KgslCounterQuery),&q),error=rc?errno:0;
    if(!first)groups+=',';first=false;
    if(rc){groups+=jsonObject({{"groupId",std::to_string(group)},{"stage",jsonString("query group size")},{"errno",std::to_string(error)}});if(error==EINVAL)complete=true;break;}
    const uint32_t reported=q.maximum;std::vector<uint32_t> counters(std::min(reported,4096U),UINT32_MAX);q.countables=counters.data();q.count=counters.size();
    if(q.count){errno=0;rc=ioctl(fd,_IOWR(0x09,0x3a,KgslCounterQuery),&q);error=rc?errno:0;}
    std::string ids="[";if(!rc)for(uint32_t i=0;i<std::min<uint32_t>(q.maximum,counters.size());++i){if(i)ids+=',';ids+=jsonInteger(counters[i]);if(counters[i]<0xfffffffeU)reads.push_back({group,counters[i],0});}ids+=']';
    if(reported>4096||q.maximum>counters.size()||group==127)limited=true;
    groups+=jsonObject({{"groupId",std::to_string(group)},{"reportedRegisters",std::to_string(reported)},{"reportedAtRead",std::to_string(q.maximum)},{"errno",std::to_string(error)},{"configuredCountables",ids}});
  }groups+=']';
  std::string batches="[";bool firstBatch=true;
  for(size_t offset=0;offset<reads.size();offset+=100){
    if(std::chrono::steady_clock::now()>=deadline){limited=true;break;}
    KgslCounterRead request{};request.values=reads.data()+offset;request.count=std::min<size_t>(100,reads.size()-offset);errno=0;int rc=ioctl(fd,_IOWR(0x09,0x3b,KgslCounterRead),&request),error=rc?errno:0;
    std::string values="[";for(uint32_t i=0;i<request.count;++i){if(i)values+=',';auto &v=reads[offset+i];values+=jsonObject({{"groupId",std::to_string(v.group)},{"countableId",std::to_string(v.countable)},{"nativeValue",rc?"null":jsonInteger(v.value)}});}values+=']';
    if(!firstBatch)batches+=',';firstBatch=false;batches+=jsonObject({{"errno",std::to_string(error)},{"values",values}});
    if(rc)break;
  }batches+=']';
  return jsonObject({{"deviceProperties",properties},{"groups",groups},{"groupRangeEnded",complete?"true":"false"},{"limitReached",limited?"true":"false"},{"readBatches",batches},{"scope",jsonString("Explicit KGSL metadata properties and QUERY/READ of already-configured counters only. No GET allocation, PUT, event selection, context or setting changes. Reads may wake hardware; firmware may prohibit reads when context-switch counter clearing is enabled. Configuration can race; values can decrease or wrap across power/context transitions. No monotonic delta or utilization is inferred. Zero is not proof of an active counter. IDs/units require matching GPU driver; not process-attributed.")}});
}
}
