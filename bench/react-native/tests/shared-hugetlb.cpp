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
    const auto sample = read("Rss: 8 kB\nPss: 4 kB\nReferenced: 999999 kB\nShared_Hugetlb: " + std::to_string(kb) + " kB\n");
    assert(sample.bytes == 8192 && sample.pss.bytes == 4096 && sample.sharedHugetlb.bytes == kb * 1024ULL);
  }
  const auto sum = read("Rss: 4 kB\nShared_Hugetlb: 3 kB\nRss: 8 kB\nShared_Hugetlb: 5 kB\n", false);
  assert(sum.bytes == 12288 && sum.sharedHugetlb.bytes == 8192);
  assert(sum.sharedHugetlb.source == "/proc/self/smaps:sum(Shared_Hugetlb)");
  for (const auto &text : {"Rss: 8 kB\nReferenced: 4 kB\n", "Rss: 8 kB\nShared_Hugetlb: -1 kB\n",
      "Rss: 8 kB\nShared_Hugetlb: 1 MB\n", "Rss: 8 kB\nShared_Hugetlb: 1 kB extra\n",
      "Rss: 8 kB\nShared_Hugetlb: 1 kB\nShared_Hugetlb: 2 kB\n",
      "Rss: 8 kB\nShared_Hugetlb: 18014398509481984 kB\n"}) {
    const auto bad = read(text); assert(bad.bytes == 8192 && !bad.sharedHugetlb.bytes && !bad.sharedHugetlb.error.empty());
  }
  for (const auto &text : {"Rss: 4 kB\nRss: 8 kB\nShared_Hugetlb: 3 kB\n",
      "Rss: 4 kB\nShared_Hugetlb: 3 kB\nRss: 8 kB\n",
      "Rss: 4 kB\nShared_Hugetlb: 18014398509481983 kB\nRss: 8 kB\nShared_Hugetlb: 1 kB\n"}) {
    const auto bad = read(text, false); assert(bad.bytes == 12288 && !bad.sharedHugetlb.bytes);
  }
  assert(!read("Shared_Hugetlb: 1 kB\nRss: 8 kB\n").sharedHugetlb.bytes);
  assert(!read("Rss: 4 kB\nShared_Hugetlb: 1 kB\nRss: 4 kB\nRss: 4 kB\nShared_Hugetlb: 1 kB\n", false).sharedHugetlb.bytes);
  const auto independent = read("Rss: 8 kB\nShared_Hugetlb: 16 kB\nReferenced: invalid kB\n");
  assert(independent.sharedHugetlb.bytes == 16384 && !independent.referenced.bytes);
  const auto exact = read("Rss: 8 kB\nShared_Hugetlb: 18014398509481983 kB\n");
  assert(exact.sharedHugetlb.bytes == 18446744073709550592ULL);
  const auto both = read("Rss: 8 kB\nShared_Hugetlb: 2048 kB\nPrivate_Hugetlb: 4096 kB\n");
  assert(both.sharedHugetlb.bytes == 2097152 && both.privateHugetlb.bytes == 4194304);
  const auto missingShared = read("Rss: 8 kB\nPrivate_Hugetlb: 2048 kB\n");
  assert(!missingShared.sharedHugetlb.bytes && missingShared.privateHugetlb.bytes == 2097152);
  std::cout << "Shared_Hugetlb parser: zero, field selection, sum, missing regions, malformed data, duplicate and overflow checks passed\n";
#ifdef __ANDROID__
  alarm(30);
  const auto sample=[](const char *phase) {
    const auto reading=bench::readResidentMemory();assert(reading.sharedHugetlb.bytes);
    std::ifstream raw("/proc/self/smaps_rollup");std::string line;bool seen=false;
    while(std::getline(raw,line)) if(line.rfind("Shared_Hugetlb:",0)==0) {
      std::istringstream field(line.substr(15));uint64_t kb;std::string unit;
      assert(field>>kb>>unit);assert(unit=="kB" && kb*1024==*reading.sharedHugetlb.bytes);
      std::cout << "raw rollup " << line << "\n";seen=true;
    }
    assert(seen);
    std::ifstream maps("/proc/self/smaps");const auto summed=bench::memoryFromSmaps(maps,false);
    assert(summed.sharedHugetlb.bytes==reading.sharedHugetlb.bytes);
    std::cout << phase << " sharedHugetlb=" << *reading.sharedHugetlb.bytes
      << " RSS=" << reading.bytes << " source=" << reading.sharedHugetlb.source << "\n";
    return *reading.sharedHugetlb.bytes;
  };
  const auto baseline=sample("baseline");
  constexpr size_t ordinarySize=1024*1024;
  void *ordinary=mmap(nullptr,ordinarySize,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_ANONYMOUS,-1,0);
  assert(ordinary!=MAP_FAILED);auto bytes=static_cast<volatile unsigned char *>(ordinary);
  for(size_t i=0;i<ordinarySize;i+=4096) bytes[i]=37;
  assert(sample("ordinary_written")==baseline);
  assert(munmap(ordinary,ordinarySize)==0);assert(sample("ordinary_released")==baseline);
  std::cout << "Raw rollup and mapping sum agree; ordinary allocation excluded. No global settings changed.\n";
#endif
}
