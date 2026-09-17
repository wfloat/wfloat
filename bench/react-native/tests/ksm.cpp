#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>
#include <chrono>
#include <thread>
#include <cerrno>
#include <cstring>

int main() {
  std::cout << std::unitbuf;
  const auto read = [](const std::string &text, bool rollup = true) {
    std::istringstream input(text); return bench::memoryFromSmaps(input, rollup);
  };
  for (const auto kb : {0, 4, 65536}) {
    const auto sample = read("Rss: 8 kB\nPss: 4 kB\nReferenced: 999999 kB\nKSM: " + std::to_string(kb) + " kB\n");
    assert(sample.bytes == 8192 && sample.pss.bytes == 4096 && sample.ksm.bytes == kb * 1024ULL);
  }
  const auto sum = read("Rss: 4 kB\nKSM: 3 kB\nRss: 8 kB\nKSM: 5 kB\n", false);
  assert(sum.bytes == 12288 && sum.ksm.bytes == 8192);
  assert(sum.ksm.source == "/proc/self/smaps:sum(KSM)");
  for (const auto &text : {"Rss: 8 kB\nReferenced: 4 kB\n", "Rss: 8 kB\nKSM: -1 kB\n",
      "Rss: 8 kB\nKSM: 1 MB\n", "Rss: 8 kB\nKSM: 1 kB extra\n",
      "Rss: 8 kB\nKSM: 1 kB\nKSM: 2 kB\n",
      "Rss: 8 kB\nKSM: 18014398509481984 kB\n"}) {
    const auto bad = read(text); assert(bad.bytes == 8192 && !bad.ksm.bytes && !bad.ksm.error.empty());
  }
  for (const auto &text : {"Rss: 4 kB\nRss: 8 kB\nKSM: 3 kB\n",
      "Rss: 4 kB\nKSM: 3 kB\nRss: 8 kB\n",
      "Rss: 4 kB\nKSM: 18014398509481983 kB\nRss: 8 kB\nKSM: 1 kB\n"}) {
    const auto bad = read(text, false); assert(bad.bytes == 12288 && !bad.ksm.bytes);
  }
  assert(!read("KSM: 1 kB\nRss: 8 kB\n").ksm.bytes);
  assert(!read("Rss: 4 kB\nKSM: 1 kB\nRss: 4 kB\nRss: 4 kB\nKSM: 1 kB\n", false).ksm.bytes);
  const auto independent = read("Rss: 8 kB\nKSM: 16 kB\nReferenced: invalid kB\n");
  assert(independent.ksm.bytes == 16384 && !independent.referenced.bytes);
  const auto exact = read("Rss: 8 kB\nKSM: 18014398509481983 kB\n");
  assert(exact.ksm.bytes == 18446744073709550592ULL);
  std::cout << "KSM parser checks passed\n";
#ifdef __ANDROID__
  alarm(30);
  const long page=sysconf(_SC_PAGESIZE);assert(page>0);
  const size_t size=page*8;
  const auto sample=[](const char* phase){
    auto r=bench::readResidentMemory();
    std::ifstream raw("/proc/self/smaps_rollup");std::string line;
    while(std::getline(raw,line)) if(line.rfind("KSM:",0)==0) std::cout<<"raw "<<line<<"\n";
    std::ifstream maps("/proc/self/smaps");auto sum=bench::memoryFromSmaps(maps,false);
    assert(r.ksm.bytes.has_value()==sum.ksm.bytes.has_value());
    if(r.ksm.bytes) {
      std::cout<<phase<<" KSM="<<*r.ksm.bytes<<" smapsSum="<<*sum.ksm.bytes<<" RSS="<<r.bytes<<"\n";
    } else {
      assert(!r.ksm.error.empty() && !sum.ksm.error.empty());
      std::cout<<phase<<" KSM=unavailable error="<<r.ksm.error
        <<" smapsSum=unavailable error="<<sum.ksm.error<<" RSS="<<r.bytes<<"\n";
    }
    return r.ksm.bytes;
  };
  auto baseline=sample("baseline");
  void* mem=mmap(nullptr,size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(mem!=MAP_FAILED);
  auto data=static_cast<volatile unsigned char*>(mem);
  for(size_t i=0;i<size;++i)data[i]=static_cast<unsigned char>((i%page)%251+1);
  sample("written");errno=0;int status=madvise(mem,size,MADV_MERGEABLE);int error=errno;
  std::cout<<"MADV_MERGEABLE status="<<status<<" errno="<<error<<"\n";
  int run=-1;std::ifstream("/sys/kernel/mm/ksm/run")>>run;std::cout<<"ksmd run="<<run<<"\n";
  if(status==0 && run==1 && baseline){for(int i=0;i<10;++i){sleep(1);const auto value=sample("merge_wait");if(value && *value>*baseline)break;}}
  else sample("after_advice");
  for(size_t i=0;i<size;++i)assert(data[i]==static_cast<unsigned char>((i%page)%251+1));
  assert(munmap(mem,size)==0);sample("released");
  std::cout<<"Data verified; bounded mapping released; no global KSM changes\n";
#endif
}
