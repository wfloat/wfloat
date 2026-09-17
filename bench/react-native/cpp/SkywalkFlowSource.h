#pragma once
#ifdef __APPLE__
#include "NativeJson.h"
#include <sys/sysctl.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <cstddef>
#include <cerrno>
#include <vector>
namespace bench {
// Reviewed XNU info_tuple/nexus_mib_filter ABI. The input is an owned TCP
// connection selector, not a configuration write or unrestricted flow dump.
struct SkywalkAddress {union {sockaddr sa;sockaddr_in v4;sockaddr_in6 v6;};};
struct SkywalkTuple {uint8_t protocol;SkywalkAddress local,remote;};
struct SkywalkFilter {uint32_t type;uint64_t bitmap;uint8_t nexus[16],flow[16];int32_t pid;SkywalkTuple tuple;};
static_assert(sizeof(SkywalkTuple)==60&&offsetof(SkywalkTuple,local)==4);
static_assert(sizeof(SkywalkFilter)==112&&offsetof(SkywalkFilter,tuple)==52);
inline std::string skywalkFlowSource(int fd){
  SkywalkFilter filter{};filter.type=1U<<3;filter.bitmap=1ULL<<3;filter.tuple.protocol=IPPROTO_TCP;
  socklen_t n=sizeof(SkywalkAddress);if(getsockname(fd,&filter.tuple.local.sa,&n))return jsonObject({{"stage",jsonString("getsockname")},{"errno",std::to_string(errno)}});
  n=sizeof(SkywalkAddress);if(getpeername(fd,&filter.tuple.remote.sa,&n))return jsonObject({{"stage",jsonString("getpeername")},{"errno",std::to_string(errno)}});
  size_t required=0;errno=0;int rc=sysctlbyname("kern.skywalk.stats.flow",nullptr,&required,&filter,sizeof(filter));int error=rc?errno:0;
  if(rc)return jsonObject({{"stage",jsonString("tuple-scoped sizing")},{"returnCode",std::to_string(rc)},{"errno",std::to_string(error)}});
  if(required>65536)return jsonObject({{"requiredBytes",std::to_string(required)},{"limitReached","true"}});
  if(!required)return jsonObject({{"returnCode","0"},{"returnedBytes","0"},{"nativeBytesHex",jsonString("")},{"scope",jsonString("No matching Skywalk flow; loopback or legacy TCP may not use Skywalk.")}});
  std::vector<unsigned char> bytes(required);size_t size=bytes.size();errno=0;rc=sysctlbyname("kern.skywalk.stats.flow",bytes.data(),&size,&filter,sizeof(filter));error=rc?errno:0;std::string hex;
  if(!rc&&size<=bytes.size())for(size_t i=0;i<size;++i){hex+="0123456789abcdef"[bytes[i]>>4];hex+="0123456789abcdef"[bytes[i]&15];}
  return jsonObject({{"returnCode",std::to_string(rc)},{"errno",std::to_string(error)},{"requiredBytes",std::to_string(required)},{"returnedBytes",std::to_string(size)},{"nativeBytesHex",!rc&&size<=bytes.size()?jsonString(hex):"null"},{"scope",jsonString("sk_stats_flow records matched to this owned TCP tuple; native firmware ABI; no reset or flow configuration")}});
}
}
#endif
