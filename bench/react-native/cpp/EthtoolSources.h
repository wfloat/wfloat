#pragma once
#include "NativeJson.h"
#include <linux/ethtool.h>
#include <linux/sockios.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <unistd.h>
#include <cerrno>
#include <cstring>
#include <vector>
namespace bench {
inline std::string ethtoolRaw(const void *p,size_t n){const auto *b=(const unsigned char*)p;std::string s;const char*h="0123456789abcdef";for(size_t i=0;i<n;++i){s+=h[b[i]>>4];s+=h[b[i]&15];}return jsonString(s);}
inline std::string ethtoolSources(const std::string &name){
  if(name.empty()||name.size()>=IFNAMSIZ)return jsonObject({{"error",jsonString("invalid interface name")}});
  const int fd=socket(AF_INET,SOCK_DGRAM|SOCK_CLOEXEC,0);if(fd<0)return jsonObject({{"errno",std::to_string(errno)},{"stage",jsonString("socket")}});
  struct Owner{int fd;~Owner(){close(fd);}}owner{fd};
  auto query=[&](void *data){ifreq r{};memcpy(r.ifr_name,name.c_str(),name.size()+1);r.ifr_data=(char*)data;errno=0;return ioctl(fd,SIOCETHTOOL,&r);};
  ethtool_drvinfo info{};info.cmd=ETHTOOL_GDRVINFO;const int code=query(&info),saved=code?errno:0;
  alignas(ethtool_sset_info) unsigned char setBytes[sizeof(ethtool_sset_info)+sizeof(uint32_t)]{};auto *setInfo=(ethtool_sset_info*)setBytes;setInfo->cmd=ETHTOOL_GSSET_INFO;setInfo->sset_mask=1ULL<<ETH_SS_STATS;int setCode=query(setInfo),setError=setCode?errno:0;
  uint32_t counterCount=code?0:info.n_stats;const bool countKnown=!code||(!setCode&&(setInfo->sset_mask&(1ULL<<ETH_SS_STATS)));
  if(!setCode&&(setInfo->sset_mask&(1ULL<<ETH_SS_STATS)))memcpy(&counterCount,setInfo->data,sizeof(counterCount));
  std::string records="[";bool first=true;
  auto fixed=[&](uint32_t command,size_t bytes,const char *format){std::vector<unsigned char> buffer(bytes);memcpy(buffer.data(),&command,4);int rc=query(buffer.data()),error=rc?errno:0;if(!first)records+=',';first=false;records+=jsonObject({{"command",std::to_string(command)},{"nativeFormat",jsonString(format)},{"returnCode",std::to_string(rc)},{"errno",std::to_string(error)},{"nativeBytesHex",rc?"null":ethtoolRaw(buffer.data(),buffer.size())}});};
  fixed(ETHTOOL_GLINK,sizeof(ethtool_value),"ethtool_value");fixed(ETHTOOL_GSET,sizeof(ethtool_cmd),"ethtool_cmd");fixed(ETHTOOL_GRINGPARAM,sizeof(ethtool_ringparam),"ethtool_ringparam");fixed(ETHTOOL_GCHANNELS,sizeof(ethtool_channels),"ethtool_channels");fixed(ETHTOOL_GCOALESCE,sizeof(ethtool_coalesce),"ethtool_coalesce");fixed(ETHTOOL_GPAUSEPARAM,sizeof(ethtool_pauseparam),"ethtool_pauseparam");fixed(ETHTOOL_GET_TS_INFO,sizeof(ethtool_ts_info),"ethtool_ts_info");fixed(ETHTOOL_GEEE,sizeof(ethtool_eee),"ethtool_eee");fixed(ETHTOOL_GFECPARAM,sizeof(ethtool_fecparam),"ethtool_fecparam");records+=']';
  std::string counters="[]";int namesError=0,statsError=0;bool consistent=countKnown&&counterCount==0;
  if(counterCount>0&&counterCount<=4096){
    std::vector<unsigned char> names(sizeof(ethtool_gstrings)+counterCount*ETH_GSTRING_LEN),values(sizeof(ethtool_stats)+counterCount*sizeof(uint64_t));
    auto *ns=(ethtool_gstrings*)names.data();ns->cmd=ETHTOOL_GSTRINGS;ns->string_set=ETH_SS_STATS;ns->len=counterCount;
    auto *vs=(ethtool_stats*)values.data();vs->cmd=ETHTOOL_GSTATS;vs->n_stats=counterCount;
    int nr=query(ns);namesError=nr?errno:0;int vr=query(vs);statsError=vr?errno:0;
    consistent=!nr&&!vr&&ns->len==counterCount&&vs->n_stats==counterCount;
    if(consistent){counters="[";for(uint32_t i=0;i<counterCount;++i){if(i)counters+=',';const char *n=(const char*)ns->data+i*ETH_GSTRING_LEN;uint64_t v;memcpy(&v,vs->data+i,8);counters+=jsonObject({{"index",std::to_string(i)},{"name",jsonString(std::string(n,strnlen(n,ETH_GSTRING_LEN)))},{"nativeValue",jsonInteger(v)}});}counters+=']';}
  }
  return jsonObject({{"interface",jsonString(name)},{"driver",jsonString(std::string(info.driver,strnlen(info.driver,sizeof(info.driver))))},{"version",jsonString(std::string(info.version,strnlen(info.version,sizeof(info.version))))},{"firmware",jsonString(std::string(info.fw_version,strnlen(info.fw_version,sizeof(info.fw_version))))},{"driverInfoErrno",std::to_string(saved)},{"stringSetInfoErrno",std::to_string(setError)},{"reportedCounterCount",countKnown?std::to_string(counterCount):"null"},{"counterLimitReached",counterCount>4096?"true":"false"},{"counterCountsConsistent",consistent?"true":"false"},{"namesErrno",std::to_string(namesError)},{"statsErrno",std::to_string(statsError)},{"counters",counters},{"configuration",records},{"scope",jsonString("Explicit ethtool GET snapshot; may wake interface hardware and refresh driver statistics. Native named uint64 counters may have vendor-specific units/scope. Configuration is not measured throughput. No setter, reset or packet capture.")}});
}
}
