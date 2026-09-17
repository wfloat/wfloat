#include "../AppleInterfaceSources.h"
#include <cstdlib>
#include <iostream>
static void require(bool ok){if(!ok)std::abort();}
int main(){
  if_msghdr2 h{};h.ifm_msglen=sizeof(h);h.ifm_version=bench::routeVersion;h.ifm_type=bench::routeInterfaceInfo2;h.ifm_index=7;h.ifm_data.ifi_ibytes=9007199254740993ULL;
  auto valid=bench::appleInterfaceRecords((unsigned char *)&h,sizeof(h));require(valid.find("9007199254740993")!=std::string::npos);require(valid.find("\"complete\":true")!=std::string::npos);
  require(bench::appleInterfaceRecords((unsigned char *)&h,3).find("short route-message header")!=std::string::npos);
  h.ifm_msglen=0;require(bench::appleInterfaceRecords((unsigned char *)&h,sizeof(h)).find("invalid route-message length")!=std::string::npos);
  h.ifm_msglen=sizeof(h);h.ifm_version=255;require(bench::appleInterfaceRecords((unsigned char *)&h,sizeof(h)).find("unsupported or short")!=std::string::npos);
  h.ifm_version=bench::routeVersion;h.ifm_type=0x0c;require(bench::appleInterfaceRecords((unsigned char *)&h,sizeof(h)).find("\"interfaces\":[]")!=std::string::npos);
  std::cout<<"64-bit precision, truncated/malformed messages, ABI version and address exclusion passed\n";
}
