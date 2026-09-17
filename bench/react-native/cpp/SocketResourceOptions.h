#pragma once
#include "NativeJson.h"
#include <sys/socket.h>
#include <sys/time.h>
#include <cstring>
#include <cerrno>
namespace bench {
inline std::string socketResourceOptions(int fd){
  enum Kind{Signed,Unsigned,Timeval,Linger,Raw};struct Entry{const char *name;int key;Kind kind;};
  const Entry entries[]={
    {"SO_RCVTIMEO",SO_RCVTIMEO,Timeval},{"SO_SNDTIMEO",SO_SNDTIMEO,Timeval},{"SO_LINGER",SO_LINGER,Linger},
#ifdef SO_REUSEPORT
    {"SO_REUSEPORT",SO_REUSEPORT,Signed},
#endif
#ifdef SO_PRIORITY
    {"SO_PRIORITY",SO_PRIORITY,Signed},
#endif
#ifdef SO_MAX_PACING_RATE
    {"SO_MAX_PACING_RATE",SO_MAX_PACING_RATE,Unsigned},
#endif
#ifdef SO_INCOMING_CPU
    {"SO_INCOMING_CPU",SO_INCOMING_CPU,Signed},
#endif
#ifdef SO_INCOMING_NAPI_ID
    {"SO_INCOMING_NAPI_ID",SO_INCOMING_NAPI_ID,Unsigned},
#endif
#ifdef SO_BUSY_POLL
    {"SO_BUSY_POLL",SO_BUSY_POLL,Unsigned},
#endif
#ifdef SO_PREFER_BUSY_POLL
    {"SO_PREFER_BUSY_POLL",SO_PREFER_BUSY_POLL,Signed},
#endif
#ifdef SO_RESERVE_MEM
    {"SO_RESERVE_MEM",SO_RESERVE_MEM,Unsigned},
#endif
#ifdef SO_BUF_LOCK
    {"SO_BUF_LOCK",SO_BUF_LOCK,Unsigned},
#endif
#ifdef SO_TXREHASH
    {"SO_TXREHASH",SO_TXREHASH,Signed},
#endif
#ifdef SO_ZEROCOPY
    {"SO_ZEROCOPY",SO_ZEROCOPY,Signed},
#endif
#ifdef SO_TXTIME
    {"SO_TXTIME",SO_TXTIME,Raw},
#endif
#ifdef SO_BINDTOIFINDEX
    {"SO_BINDTOIFINDEX",SO_BINDTOIFINDEX,Unsigned},
#endif
#ifdef SO_TRAFFIC_CLASS
    {"SO_TRAFFIC_CLASS",SO_TRAFFIC_CLASS,Signed},
#endif
#ifdef SO_NET_SERVICE_TYPE
    {"SO_NET_SERVICE_TYPE",SO_NET_SERVICE_TYPE,Signed},
#endif
  };
  std::string rows="[";bool first=true;for(auto &entry:entries){alignas(8) unsigned char bytes[64]{};socklen_t length=sizeof(bytes);int code=getsockopt(fd,SOL_SOCKET,entry.key,bytes,&length),error=code?errno:0;std::string value="null",hex;
    if(!code&&length<=sizeof(bytes)){const char *digits="0123456789abcdef";for(size_t i=0;i<length;++i){hex+=digits[bytes[i]>>4];hex+=digits[bytes[i]&15];}
      if(entry.kind==Timeval&&length==sizeof(timeval)){timeval v{};memcpy(&v,bytes,sizeof(v));value=jsonObject({{"seconds",jsonInteger(v.tv_sec)},{"microseconds",jsonInteger(v.tv_usec)}});}
      else if(entry.kind==Linger&&length==sizeof(linger)){linger v{};memcpy(&v,bytes,sizeof(v));value=jsonObject({{"enabled",jsonInteger(v.l_onoff)},{"seconds",jsonInteger(v.l_linger)}});}
      else if(entry.kind==Unsigned&&(length==4||length==8)){uint64_t v=0;memcpy(&v,bytes,length);value=jsonInteger(v);}
      else if(entry.kind==Signed&&length==4){int32_t v;memcpy(&v,bytes,4);value=jsonInteger(v);}}
    if(!first)rows+=',';first=false;rows+=jsonObject({{"name",jsonString(entry.name)},{"errno",jsonInteger(error)},{"returnedBytes",jsonInteger(length)},{"nativeBytesHex",!code&&length<=sizeof(bytes)?jsonString(hex):"null"},{"value",value}});}
  rows+=']';return jsonObject({{"options",rows},{"scope",jsonString("Read-only socket scheduling, pacing, polling, timeouts and buffer policy. Configured limits/flags are not measured throughput or latency. Native sentinel/width retained; SO_ERROR and cookie-generation getters are excluded. No setsockopt calls.")}});
}
}
