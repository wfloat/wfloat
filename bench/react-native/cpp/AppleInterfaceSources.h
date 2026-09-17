#pragma once
#include "NativeJson.h"
#include <sys/sysctl.h>
#include <sys/socket.h>
#include <net/if.h>
// iPhone SDK exposes if_msghdr2 but omits net/route.h. These message
// selectors are the published XNU routing ABI; validate version and size.
#include <vector>
#include <cstring>
#include <cerrno>
namespace bench {
constexpr unsigned char routeVersion=5,routeInterfaceInfo2=0x12;
inline std::string appleInterfaceRecords(const unsigned char *data,size_t length) {
  size_t offset=0,count=0;std::string rows="[",error;
  while(offset<length) {
    if(length-offset<4){error="short route-message header";break;}
    uint16_t size;memcpy(&size,data+offset,sizeof(size));
    if(size<4||size>length-offset){error="invalid route-message length";break;}
    const auto version=data[offset+2],type=data[offset+3];
    if(type==routeInterfaceInfo2) {
      if(version!=routeVersion||size<sizeof(if_msghdr2)){error="unsupported or short interface message";break;}
      if(count>=128){error="interface limit reached";break;}
      if_msghdr2 h{};memcpy(&h,data+offset,sizeof(h));const auto &v=h.ifm_data;
      if(count++)rows+=',';
      // Address records and the address tail of IFINFO2 are deliberately omitted.
      rows+=jsonObject({{"index",jsonInteger(h.ifm_index)},{"flags",jsonInteger(h.ifm_flags)},
        {"sendQueueLength",jsonInteger(h.ifm_snd_len)},{"sendQueueMaximum",jsonInteger(h.ifm_snd_maxlen)},{"sendQueueDrops",jsonInteger(h.ifm_snd_drops)},{"watchdogTimer",jsonInteger(h.ifm_timer)},
        {"type",jsonInteger(v.ifi_type)},{"typeLength",jsonInteger(v.ifi_typelen)},{"physical",jsonInteger(v.ifi_physical)},{"addressLength",jsonInteger(v.ifi_addrlen)},{"headerLength",jsonInteger(v.ifi_hdrlen)},
        {"receiveQuota",jsonInteger(v.ifi_recvquota)},{"transmitQuota",jsonInteger(v.ifi_xmitquota)},{"mtu",jsonInteger(v.ifi_mtu)},{"metric",jsonInteger(v.ifi_metric)},{"baudrate",jsonInteger(v.ifi_baudrate)},
        {"ipackets",jsonInteger(v.ifi_ipackets)},{"opackets",jsonInteger(v.ifi_opackets)},{"ierrors",jsonInteger(v.ifi_ierrors)},{"oerrors",jsonInteger(v.ifi_oerrors)},{"collisions",jsonInteger(v.ifi_collisions)},
        {"ibytes",jsonInteger(v.ifi_ibytes)},{"obytes",jsonInteger(v.ifi_obytes)},{"imcasts",jsonInteger(v.ifi_imcasts)},{"omcasts",jsonInteger(v.ifi_omcasts)},{"iqdrops",jsonInteger(v.ifi_iqdrops)},{"noproto",jsonInteger(v.ifi_noproto)},
        {"receiveTimingMicroseconds",jsonInteger(v.ifi_recvtiming)},{"transmitTimingMicroseconds",jsonInteger(v.ifi_xmittiming)},
        {"lastChangeSeconds",jsonInteger(v.ifi_lastchange.tv_sec)},{"lastChangeMicroseconds",jsonInteger(v.ifi_lastchange.tv_usec)}});
    }
    offset+=size;
  }
  rows+=']';return jsonObject({{"interfaces",rows},{"parsedBytes",jsonInteger(offset)},{"returnedBytes",jsonInteger(length)},{"complete",offset==length?"true":"false"},{"parseError",error.empty()?"null":jsonString(error)},
    {"scope",jsonString("system interfaces; 64-bit traffic counters, native queue counts and optional timing; no addresses; zero timing need not mean instrumented")}});
}
inline std::string appleInterfaceSources() {
  int mib[]={CTL_NET,PF_ROUTE,0,0,NET_RT_IFLIST2,0};size_t length=0;
  if(sysctl(mib,6,nullptr,&length,nullptr,0))return jsonObject({{"errno",jsonInteger(errno)}});
  constexpr size_t maximum=1024*1024;
  if(length>maximum)return jsonObject({{"error",jsonString("interface snapshot exceeds 1 MiB bound")},{"requiredBytes",jsonInteger(length)}});
  // One bounded fetch. A concurrent interface change can fail with ENOMEM;
  // preserve it instead of repeatedly allocating or parsing a partial reply.
  std::vector<unsigned char> bytes(length?length:1);size_t returned=length;
  if(sysctl(mib,6,bytes.data(),&returned,nullptr,0))return jsonObject({{"errno",jsonInteger(errno)},{"requiredBytes",jsonInteger(returned)}});
  if(returned>length)return jsonObject({{"error",jsonString("reply exceeds allocated size")}});
  return appleInterfaceRecords(bytes.data(),returned);
}
}
