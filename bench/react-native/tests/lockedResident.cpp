#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>
#include <chrono>
#include <thread>
#include <cerrno>
#include <cstring>
#ifdef __ANDROID__
#include <sys/syscall.h>
#endif

int main() {
  std::cout << std::unitbuf;
  const auto read = [](const std::string &text, bool rollup = true) {
    std::istringstream input(text); return bench::memoryFromSmaps(input, rollup);
  };
  for (const auto kb : {0, 4, 65536}) {
    const auto sample = read("Rss: 8 kB\nPss: 4 kB\nReferenced: 999999 kB\nLocked: " + std::to_string(kb) + " kB\n");
    assert(sample.bytes == 8192 && sample.pss.bytes == 4096 && sample.lockedResident.bytes == kb * 1024ULL);
  }
  const auto sum = read("Rss: 4 kB\nLocked: 3 kB\nRss: 8 kB\nLocked: 5 kB\n", false);
  assert(sum.bytes == 12288 && sum.lockedResident.bytes == 8192);
  assert(sum.lockedResident.source == "/proc/self/smaps:sum(Locked)");
  for (const auto &text : {"Rss: 8 kB\nReferenced: 4 kB\n", "Rss: 8 kB\nLocked: -1 kB\n",
      "Rss: 8 kB\nLocked: 1 MB\n", "Rss: 8 kB\nLocked: 1 kB extra\n",
      "Rss: 8 kB\nLocked: 1 kB\nLocked: 2 kB\n",
      "Rss: 8 kB\nLocked: 18014398509481984 kB\n"}) {
    const auto bad = read(text); assert(bad.bytes == 8192 && !bad.lockedResident.bytes && !bad.lockedResident.error.empty());
  }
  for (const auto &text : {"Rss: 4 kB\nRss: 8 kB\nLocked: 3 kB\n",
      "Rss: 4 kB\nLocked: 3 kB\nRss: 8 kB\n",
      "Rss: 4 kB\nLocked: 18014398509481983 kB\nRss: 8 kB\nLocked: 1 kB\n"}) {
    const auto bad = read(text, false); assert(bad.bytes == 12288 && !bad.lockedResident.bytes);
  }
  assert(!read("Locked: 1 kB\nRss: 8 kB\n").lockedResident.bytes);
  assert(!read("Rss: 4 kB\nLocked: 1 kB\nRss: 4 kB\nRss: 4 kB\nLocked: 1 kB\n", false).lockedResident.bytes);
  const auto independent = read("Rss: 8 kB\nLocked: 16 kB\nReferenced: invalid kB\n");
  assert(independent.lockedResident.bytes == 16384 && !independent.referenced.bytes);
  const auto exact = read("Rss: 8 kB\nLocked: 18014398509481983 kB\n");
  assert(exact.lockedResident.bytes == 18446744073709550592ULL);
  std::cout << "Locked resident parser checks passed\n";
#ifdef __ANDROID__
  alarm(30);
  const long page=sysconf(_SC_PAGESIZE);assert(page>0);const size_t size=page*4;
  rlimit limit{};assert(getrlimit(RLIMIT_MEMLOCK,&limit)==0);
  const auto sample=[](const char* phase){
    auto r=bench::readResidentMemory();assert(r.lockedResident.bytes && r.locked.bytes);
    std::ifstream raw("/proc/self/smaps_rollup");std::string line;
    while(std::getline(raw,line))if(line.rfind("Locked:",0)==0)std::cout<<"raw "<<line<<"\n";
    std::ifstream maps("/proc/self/smaps");auto sum=bench::memoryFromSmaps(maps,false);assert(sum.lockedResident.bytes==r.lockedResident.bytes);
    std::cout<<phase<<" Locked="<<*r.lockedResident.bytes<<" VmLck="<<*r.locked.bytes<<" RSS="<<r.bytes<<"\n";
    return std::pair<uint64_t,uint64_t>(*r.lockedResident.bytes,*r.locked.bytes);
  };
  const auto base=sample("baseline");std::cout<<"page="<<page<<" uid="<<getuid()<<" lockLimit="<<limit.rlim_cur<<"\n";
  if(limit.rlim_cur<base.second || limit.rlim_cur-base.second<size){std::cout<<"Insufficient lock allowance\n";return 77;}
  void* mem=mmap(nullptr,size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(mem!=MAP_FAILED);
  if(mlock(mem,size)!=0){int code=errno;munmap(mem,size);std::cout<<"mlock unavailable errno="<<code<<"\n";return 77;}
  auto held=sample("locked");assert(held.first==base.first+size && held.second==base.second+size);
  assert(munlock(mem,size)==0);assert(sample("unlocked")==base);assert(munmap(mem,size)==0);
  mem=mmap(nullptr,size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(mem!=MAP_FAILED);
  errno=0;int deferred=static_cast<int>(syscall(SYS_mlock2,mem,size,MLOCK_ONFAULT));int error=errno;
  std::cout<<"mlock2 onfault status="<<deferred<<" errno="<<error<<"\n";
  if(deferred==0){
    auto untouched=sample("deferred_untouched");assert(untouched.first==base.first && untouched.second==base.second+size);
    auto data=static_cast<volatile unsigned char*>(mem);data[0]=71;
    auto one=sample("deferred_one_page");assert(one.first==base.first+page && one.second==base.second+size);
    for(size_t i=page;i<size;i+=page)data[i]=71;
    auto all=sample("deferred_all_pages");assert(all.first==base.first+size && all.second==base.second+size);
    assert(data[0]==71);
  }
  assert(munmap(mem,size)==0);assert(sample("released")==base);
  std::cout<<"Locked residency responds independently of deferred VmLck; mappings released\n";
#endif
}
