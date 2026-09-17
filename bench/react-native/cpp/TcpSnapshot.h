#pragma once
#include "NativeJson.h"
#include <sys/socket.h>
#include <netinet/in.h>
#ifdef __APPLE__
#include <netinet/tcp.h>
#else
#include <linux/tcp.h>
#endif
#include <cstddef>
#include <cerrno>
#include <cstring>
#include <algorithm>
namespace bench {
inline std::string tcpNativeRecord(int fd,int option){
  unsigned char bytes[16384]{};socklen_t length=sizeof(bytes);errno=0;const int rc=getsockopt(fd,IPPROTO_TCP,option,bytes,&length),error=rc?errno:0;std::string hex;
  if(!rc&&length<=sizeof(bytes))for(size_t i=0;i<length;++i){hex+="0123456789abcdef"[bytes[i]>>4];hex+="0123456789abcdef"[bytes[i]&15];}
  return jsonObject({{"option",std::to_string(option)},{"errno",std::to_string(error)},{"returnedBytes",std::to_string(length)},{"nativeBytesHex",!rc&&length<=sizeof(bytes)?jsonString(hex):"null"},{"limitReached",length>=sizeof(bytes)?"true":"false"},{"scope",jsonString("Complete native TCP record for this owned descriptor; firmware ABI, not a portable struct. No resets or measurement enablement.")}});
}
inline std::string tcpResourceOptions(int fd){
  struct Entry{const char *name;int option;};const Entry entries[]={
#ifdef TCP_NODELAY
    {"TCP_NODELAY",TCP_NODELAY},
#endif
#ifdef TCP_MAXSEG
    {"TCP_MAXSEG",TCP_MAXSEG},
#endif
#ifdef TCP_CORK
    {"TCP_CORK",TCP_CORK},
#endif
#ifdef TCP_KEEPIDLE
    {"TCP_KEEPIDLE",TCP_KEEPIDLE},
#endif
#ifdef TCP_KEEPINTVL
    {"TCP_KEEPINTVL",TCP_KEEPINTVL},
#endif
#ifdef TCP_KEEPCNT
    {"TCP_KEEPCNT",TCP_KEEPCNT},
#endif
#ifdef TCP_SYNCNT
    {"TCP_SYNCNT",TCP_SYNCNT},
#endif
#ifdef TCP_LINGER2
    {"TCP_LINGER2",TCP_LINGER2},
#endif
#ifdef TCP_DEFER_ACCEPT
    {"TCP_DEFER_ACCEPT",TCP_DEFER_ACCEPT},
#endif
#ifdef TCP_WINDOW_CLAMP
    {"TCP_WINDOW_CLAMP",TCP_WINDOW_CLAMP},
#endif
#ifdef TCP_QUICKACK
    {"TCP_QUICKACK",TCP_QUICKACK},
#endif
#ifdef TCP_CONGESTION
    {"TCP_CONGESTION",TCP_CONGESTION},
#endif
#ifdef TCP_USER_TIMEOUT
    {"TCP_USER_TIMEOUT",TCP_USER_TIMEOUT},
#endif
#ifdef TCP_NOTSENT_LOWAT
    {"TCP_NOTSENT_LOWAT",TCP_NOTSENT_LOWAT},
#endif
#ifdef TCP_CC_INFO
    {"TCP_CC_INFO",TCP_CC_INFO},
#endif
#ifdef TCP_KEEPALIVE
    {"TCP_KEEPALIVE",TCP_KEEPALIVE},
#endif
#ifdef TCP_CONNECTIONTIMEOUT
    {"TCP_CONNECTIONTIMEOUT",TCP_CONNECTIONTIMEOUT},
#endif
#ifdef TCP_RXT_CONNDROPTIME
    {"TCP_RXT_CONNDROPTIME",TCP_RXT_CONNDROPTIME},
#endif
#ifdef TCP_RXT_FINDROP
    {"TCP_RXT_FINDROP",TCP_RXT_FINDROP},
#endif
  };std::string rows="[";bool first=true;for(auto &e:entries){if(!first)rows+=',';first=false;rows+=jsonObject({{"name",jsonString(e.name)},{"record",tcpNativeRecord(fd,e.option)}});}return rows+"]";
}
inline std::string tcpSnapshot(int fd) {
  const auto resourceOptions=tcpResourceOptions(fd);
#ifdef __APPLE__
  const auto privateRecord=tcpNativeRecord(fd,0x200); // XNU TCP_INFO, richer than public TCP_CONNECTION_INFO.
  tcp_connection_info v{};const int option=TCP_CONNECTION_INFO;
#else
  tcp_info v{};const int option=TCP_INFO;
#endif
  unsigned char raw[16384]{};socklen_t count=sizeof(raw);const int result=getsockopt(fd,IPPROTO_TCP,option,raw,&count);const int error=result<0?errno:0;memcpy(&v,raw,std::min<size_t>(count,sizeof(v)));
  if(error)return jsonObject({{"resourceOptions",resourceOptions},{"errno",std::to_string(error)},{"returnedBytes",std::to_string(count)}
#ifdef __APPLE__
    ,{"privateTcpInfo",privateRecord}
#endif
  });
  std::string fields="{";bool first=true;
  const auto add=[&](const char *name,uint64_t value){if(!first)fields+=',';first=false;fields+=jsonString(name)+":"+jsonInteger(value);};
#define TCP_FIELD(field) if(offsetof(decltype(v),field)+sizeof(v.field)<=count)add(#field,v.field)
#ifdef __APPLE__
  TCP_FIELD(tcpi_state);
  TCP_FIELD(tcpi_snd_wscale);
  TCP_FIELD(tcpi_rcv_wscale);
  TCP_FIELD(tcpi_options);
  TCP_FIELD(tcpi_flags);
  TCP_FIELD(tcpi_rto);
  TCP_FIELD(tcpi_maxseg);
  TCP_FIELD(tcpi_snd_ssthresh);
  TCP_FIELD(tcpi_snd_cwnd);
  TCP_FIELD(tcpi_snd_wnd);
  TCP_FIELD(tcpi_snd_sbbytes);
  TCP_FIELD(tcpi_rcv_wnd);
  TCP_FIELD(tcpi_rttcur);
  TCP_FIELD(tcpi_srtt);
  TCP_FIELD(tcpi_rttvar);
  TCP_FIELD(tcpi_txpackets);
  TCP_FIELD(tcpi_txbytes);
  TCP_FIELD(tcpi_txretransmitbytes);
  TCP_FIELD(tcpi_rxpackets);
  TCP_FIELD(tcpi_rxbytes);
  TCP_FIELD(tcpi_rxoutoforderbytes);
  TCP_FIELD(tcpi_txretransmitpackets);
  if(count>=offsetof(decltype(v),tcpi_txpackets)) {add("tcpi_tfo_cookie_req",v.tcpi_tfo_cookie_req);add("tcpi_tfo_cookie_rcv",v.tcpi_tfo_cookie_rcv);add("tcpi_tfo_syn_loss",v.tcpi_tfo_syn_loss);add("tcpi_tfo_syn_data_sent",v.tcpi_tfo_syn_data_sent);add("tcpi_tfo_syn_data_acked",v.tcpi_tfo_syn_data_acked);add("tcpi_tfo_syn_data_rcv",v.tcpi_tfo_syn_data_rcv);add("tcpi_tfo_cookie_req_rcv",v.tcpi_tfo_cookie_req_rcv);add("tcpi_tfo_cookie_sent",v.tcpi_tfo_cookie_sent);add("tcpi_tfo_cookie_invalid",v.tcpi_tfo_cookie_invalid);add("tcpi_tfo_cookie_wrong",v.tcpi_tfo_cookie_wrong);add("tcpi_tfo_no_cookie_rcv",v.tcpi_tfo_no_cookie_rcv);add("tcpi_tfo_heuristics_disable",v.tcpi_tfo_heuristics_disable);add("tcpi_tfo_send_blackhole",v.tcpi_tfo_send_blackhole);add("tcpi_tfo_recv_blackhole",v.tcpi_tfo_recv_blackhole);add("tcpi_tfo_onebyte_proxy",v.tcpi_tfo_onebyte_proxy);}
#else
  TCP_FIELD(tcpi_state);
  TCP_FIELD(tcpi_ca_state);
  TCP_FIELD(tcpi_retransmits);
  TCP_FIELD(tcpi_probes);
  TCP_FIELD(tcpi_backoff);
  TCP_FIELD(tcpi_options);
  TCP_FIELD(tcpi_rto);
  TCP_FIELD(tcpi_ato);
  TCP_FIELD(tcpi_snd_mss);
  TCP_FIELD(tcpi_rcv_mss);
  TCP_FIELD(tcpi_unacked);
  TCP_FIELD(tcpi_sacked);
  TCP_FIELD(tcpi_lost);
  TCP_FIELD(tcpi_retrans);
  TCP_FIELD(tcpi_fackets);
  TCP_FIELD(tcpi_last_data_sent);
  TCP_FIELD(tcpi_last_ack_sent);
  TCP_FIELD(tcpi_last_data_recv);
  TCP_FIELD(tcpi_last_ack_recv);
  TCP_FIELD(tcpi_pmtu);
  TCP_FIELD(tcpi_rcv_ssthresh);
  TCP_FIELD(tcpi_rtt);
  TCP_FIELD(tcpi_rttvar);
  TCP_FIELD(tcpi_snd_ssthresh);
  TCP_FIELD(tcpi_snd_cwnd);
  TCP_FIELD(tcpi_advmss);
  TCP_FIELD(tcpi_reordering);
  TCP_FIELD(tcpi_rcv_rtt);
  TCP_FIELD(tcpi_rcv_space);
  TCP_FIELD(tcpi_total_retrans);
  TCP_FIELD(tcpi_pacing_rate);
  TCP_FIELD(tcpi_max_pacing_rate);
  TCP_FIELD(tcpi_bytes_acked);
  TCP_FIELD(tcpi_bytes_received);
  TCP_FIELD(tcpi_segs_out);
  TCP_FIELD(tcpi_segs_in);
  TCP_FIELD(tcpi_notsent_bytes);
  TCP_FIELD(tcpi_min_rtt);
  TCP_FIELD(tcpi_data_segs_in);
  TCP_FIELD(tcpi_data_segs_out);
  TCP_FIELD(tcpi_delivery_rate);
  TCP_FIELD(tcpi_busy_time);
  TCP_FIELD(tcpi_rwnd_limited);
  TCP_FIELD(tcpi_sndbuf_limited);
  TCP_FIELD(tcpi_delivered);
  TCP_FIELD(tcpi_delivered_ce);
  TCP_FIELD(tcpi_bytes_sent);
  TCP_FIELD(tcpi_bytes_retrans);
  TCP_FIELD(tcpi_dsack_dups);
  TCP_FIELD(tcpi_reord_seen);
  TCP_FIELD(tcpi_rcv_ooopack);
  TCP_FIELD(tcpi_snd_wnd);
  TCP_FIELD(tcpi_rcv_wnd);
  TCP_FIELD(tcpi_rehash);
  if(count>=offsetof(decltype(v),tcpi_rto)){add("tcpi_snd_wscale",v.tcpi_snd_wscale);add("tcpi_rcv_wscale",v.tcpi_rcv_wscale);add("tcpi_delivery_rate_app_limited",v.tcpi_delivery_rate_app_limited);add("tcpi_fastopen_client_fail",v.tcpi_fastopen_client_fail);}
#endif
#undef TCP_FIELD
  std::string hex;if(count<=sizeof(raw))for(size_t i=0;i<count;++i){hex+="0123456789abcdef"[raw[i]>>4];hex+="0123456789abcdef"[raw[i]&15];}
  fields+='}';return jsonObject({{"resourceOptions",resourceOptions},{"errno","0"},{"returnedBytes",std::to_string(count)},{"fields",fields},{"nativeBytesHex",count<=sizeof(raw)?jsonString(hex):"null"},{"limitReached",count>=sizeof(raw)?"true":"false"}
#ifdef __APPLE__
    ,{"privateTcpInfo",privateRecord}
#endif
  });
}
}
