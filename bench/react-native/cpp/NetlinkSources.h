#pragma once
#include "NativeJson.h"
#include <sys/socket.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <linux/if_link.h>
#include <unistd.h>
#include <poll.h>
#include <cerrno>
#include <cstring>
#include <chrono>
namespace bench {
inline std::string netlinkBytes(const void *p,size_t n){const auto *b=(const unsigned char*)p;std::string s;const char *h="0123456789abcdef";for(size_t i=0;i<n;++i){s+=h[b[i]>>4];s+=h[b[i]&15];}return jsonString(s);}
inline std::string netlinkLinkRecord(const nlmsghdr *header,bool &valid){
  const bool stats=header->nlmsg_type==RTM_NEWSTATS;const size_t infoSize=stats?sizeof(if_stats_msg):sizeof(ifinfomsg);
  if(header->nlmsg_len<NLMSG_LENGTH(infoSize)){valid=false;return "null";}
  ifinfomsg info{};if(stats){if_stats_msg v{};memcpy(&v,NLMSG_DATA(header),sizeof(v));info.ifi_index=v.ifindex;}else memcpy(&info,NLMSG_DATA(header),sizeof(info));
  int remaining=header->nlmsg_len-NLMSG_LENGTH(infoSize);auto *a=(const rtattr*)((const char*)NLMSG_DATA(header)+NLMSG_ALIGN(infoSize));
  std::string attributes="[";bool first=true;
  for(;RTA_OK(a,remaining);a=RTA_NEXT(a,remaining)){
    const unsigned type=a->rta_type&NLA_TYPE_MASK;const size_t size=RTA_PAYLOAD(a);
    // Statistics and queue/link configuration only; no hardware addresses,
    // packet contents or unrelated driver configuration blobs.
    const bool keep=stats||type==IFLA_STATS||type==IFLA_STATS64||type==IFLA_MTU||type==IFLA_TXQLEN||type==IFLA_OPERSTATE||type==IFLA_LINKMODE||type==IFLA_NUM_TX_QUEUES||type==IFLA_NUM_RX_QUEUES||type==IFLA_CARRIER||type==IFLA_CARRIER_CHANGES||type==IFLA_CARRIER_UP_COUNT||type==IFLA_CARRIER_DOWN_COUNT||type==IFLA_QDISC||type==IFLA_IFNAME||type==IFLA_AF_SPEC;
    if(!keep)continue;
    std::string words="null";
    if((stats&&type==IFLA_STATS_LINK_64)||(!stats&&(type==IFLA_STATS||type==IFLA_STATS64))){const size_t width=stats||type==IFLA_STATS64?8:4;words="[";for(size_t i=0;i+width<=size;i+=width){uint64_t value=0;memcpy(&value,(const char*)RTA_DATA(a)+i,width);if(i)words+=',';words+=jsonInteger(value);}words+=']';if(size%width)valid=false;}
    if(!first)attributes+=',';first=false;attributes+=jsonObject({{"type",std::to_string(type)},{"nativeTypeFlags",std::to_string(a->rta_type)},{"bytes",std::to_string(size)},{"rawHex",netlinkBytes(RTA_DATA(a),size)},{"nativeCounterWords",words}});
  }
  if(remaining)valid=false;attributes+=']';
  return jsonObject({{"interfaceIndex",std::to_string(info.ifi_index)},{"interfaceType",stats?"null":std::to_string(info.ifi_type)},{"flags",stats?"null":jsonInteger(info.ifi_flags)},{"attributes",attributes}});
}
inline std::string netlinkInterfaceSources(bool stats=false,bool extended=false){
  const int fd=socket(AF_NETLINK,SOCK_RAW|SOCK_CLOEXEC|SOCK_NONBLOCK,NETLINK_ROUTE);
  if(fd<0)return jsonObject({{"stage",jsonString("socket")},{"errno",std::to_string(errno)},{"complete","false"}});
  struct Owner{int fd;~Owner(){close(fd);}} owner{fd};
  // sendto assigns a local netlink port automatically; no multicast binding.
  struct {nlmsghdr h;unsigned char body[sizeof(ifinfomsg)];} request{};
  request.h.nlmsg_len=NLMSG_LENGTH(stats?sizeof(if_stats_msg):sizeof(ifinfomsg));request.h.nlmsg_type=stats?RTM_GETSTATS:RTM_GETLINK;request.h.nlmsg_flags=NLM_F_REQUEST|NLM_F_DUMP;request.h.nlmsg_seq=1;
  if(stats){if_stats_msg v{};v.family=AF_UNSPEC;v.filter_mask=extended?((1U<<IFLA_STATS_MAX)-1):IFLA_STATS_FILTER_BIT(IFLA_STATS_LINK_64);memcpy(request.body,&v,sizeof(v));}
  else {ifinfomsg v{};v.ifi_family=AF_UNSPEC;memcpy(request.body,&v,sizeof(v));}
  sockaddr_nl kernel{};kernel.nl_family=AF_NETLINK;
  if(sendto(fd,&request,request.h.nlmsg_len,0,(sockaddr*)&kernel,sizeof(kernel))<0)return jsonObject({{"stage",jsonString("send")},{"errno",std::to_string(errno)},{"complete","false"}});
  std::string rows="[";bool first=true,done=false,valid=true,interrupted=false,truncated=false;int error=0;size_t total=0;
  const auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);
  alignas(nlmsghdr) unsigned char buffer[65536];
  while(!done&&total<1048576&&std::chrono::steady_clock::now()<deadline){
    pollfd ready{fd,POLLIN,0};int wait=poll(&ready,1,10);if(wait<0){if(errno==EINTR)continue;error=errno;break;}if(!wait)continue;
    sockaddr_nl sender{};iovec iov{buffer,sizeof(buffer)};msghdr msg{};msg.msg_name=&sender;msg.msg_namelen=sizeof(sender);msg.msg_iov=&iov;msg.msg_iovlen=1;
    ssize_t n=recvmsg(fd,&msg,0);if(n<0){if(errno==EAGAIN||errno==EINTR)continue;error=errno;break;}if(!n){error=EIO;break;}
    if(msg.msg_flags&MSG_TRUNC){truncated=true;break;}if(sender.nl_pid!=0)continue;total+=n;int remaining=n;
    for(auto *h=(nlmsghdr*)buffer;NLMSG_OK(h,remaining);h=NLMSG_NEXT(h,remaining)){
      if(h->nlmsg_seq!=1)continue;if(h->nlmsg_flags&NLM_F_DUMP_INTR)interrupted=true;
      if(h->nlmsg_type==NLMSG_DONE){if(h->nlmsg_len>=NLMSG_LENGTH(sizeof(int))){int status;memcpy(&status,NLMSG_DATA(h),sizeof(status));if(status<0)error=-status;}done=true;break;}
      if(h->nlmsg_type==NLMSG_ERROR){if(h->nlmsg_len>=NLMSG_LENGTH(sizeof(nlmsgerr))){nlmsgerr e{};memcpy(&e,NLMSG_DATA(h),sizeof(e));error=-e.error;}else valid=false;done=true;break;}
      if(h->nlmsg_type==RTM_NEWLINK||h->nlmsg_type==RTM_NEWSTATS){if(!first)rows+=',';first=false;rows+=netlinkLinkRecord(h,valid);}
    }
    if(!done&&remaining)valid=false;
  }
  rows+=']';return jsonObject({{"interfaces",rows},{"errno",std::to_string(error)},{"complete",done&&!error&&valid&&!interrupted&&!truncated?"true":"false"},{"layoutValid",valid?"true":"false"},{"dumpInterrupted",interrupted?"true":"false"},{"datagramTruncated",truncated?"true":"false"},{"receivedBytes",std::to_string(total)},{"limitReached",!done&&!error?"true":"false"},{"scope",jsonString("RTM_GETLINK/RTM_GETSTATS read-only multipart dump; native rtnl_link_stats words and protocol AF_SPEC bytes; system interface accounting, not app traffic. 250 ms/1 MiB bounds; no subscriptions or link changes.")}});
}
}
