// Host regression for the physical iPhone EXC_GUARD / GUARD_DUP crash.
// Private guard creation is used only by this test, never by the app collector.
#include "../cpp/DescriptorSources.h"
#include <dlfcn.h>
#include <cassert>
#include <iostream>
int main() {
  using Open=int(*)(const char*,const uint64_t*,unsigned,int,...);
  using Close=int(*)(int,const uint64_t*);
  auto openGuarded=(Open)dlsym(RTLD_DEFAULT,"guarded_open_np");
  auto closeGuarded=(Close)dlsym(RTLD_DEFAULT,"guarded_close_np");
  assert(openGuarded && closeGuarded);
  const uint64_t guard=0x57464c4f41544455ULL;
  int fd=openGuarded("/dev/null",&guard,3,O_RDONLY|O_CLOEXEC);if(fd<0)perror("guarded_open_np");assert(fd>=0);
  for(int i=0;i<10;++i){auto result=bench::descriptorSources();assert(result.find("direct_nonatomic_no_duplication")!=std::string::npos);assert(fcntl(fd,F_GETFD)>=0);}
  assert(closeGuarded(fd,&guard)==0);
  std::cout<<"10 guarded-descriptor scans survived; original handle preserved and guard-aware close passed\n";
}
