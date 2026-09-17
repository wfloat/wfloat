#include "../NetlinkSources.h"
#include <cassert>
#include <iostream>
int main(){
 alignas(nlmsghdr) unsigned char bytes[512]{};auto *h=(nlmsghdr*)bytes;h->nlmsg_len=NLMSG_LENGTH(sizeof(ifinfomsg));h->nlmsg_type=RTM_NEWLINK;
 auto *info=(ifinfomsg*)NLMSG_DATA(h);info->ifi_index=42;auto *a=(rtattr*)(bytes+h->nlmsg_len);a->rta_type=IFLA_STATS64;a->rta_len=RTA_LENGTH(26*sizeof(uint64_t));
 uint64_t values[26]{};values[0]=9007199254740993ULL;values[25]=123456;memcpy(RTA_DATA(a),values,sizeof(values));h->nlmsg_len+=RTA_ALIGN(a->rta_len);
 bool valid=true;auto s=bench::netlinkLinkRecord(h,valid);assert(valid);assert(s.find("9007199254740993")!=std::string::npos);assert(s.find("123456")!=std::string::npos);
 a->rta_len=600;valid=true;bench::netlinkLinkRecord(h,valid);assert(!valid);
 h->nlmsg_len=NLMSG_LENGTH(sizeof(ifinfomsg))-1;valid=true;bench::netlinkLinkRecord(h,valid);assert(!valid);
 memset(bytes,0,sizeof(bytes));h=(nlmsghdr*)bytes;h->nlmsg_type=RTM_NEWSTATS;h->nlmsg_len=NLMSG_LENGTH(sizeof(if_stats_msg));auto *stats=(if_stats_msg*)NLMSG_DATA(h);stats->ifindex=43;
 a=(rtattr*)(bytes+h->nlmsg_len);a->rta_type=IFLA_STATS_LINK_64;a->rta_len=RTA_LENGTH(sizeof(values));memcpy(RTA_DATA(a),values,sizeof(values));h->nlmsg_len+=RTA_ALIGN(a->rta_len);valid=true;s=bench::netlinkLinkRecord(h,valid);assert(valid&&s.find("9007199254740993")!=std::string::npos&&s.find("123456")!=std::string::npos);
 std::cout<<"native counter width, future tail and malformed-length checks passed\n";
}
