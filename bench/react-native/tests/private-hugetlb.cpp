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
    const auto sample = read("Rss: 8 kB\nPss: 4 kB\nReferenced: 999999 kB\nPrivate_Hugetlb: " + std::to_string(kb) + " kB\n");
    assert(sample.bytes == 8192 && sample.pss.bytes == 4096 && sample.privateHugetlb.bytes == kb * 1024ULL);
  }
  const auto sum = read("Rss: 4 kB\nPrivate_Hugetlb: 3 kB\nRss: 8 kB\nPrivate_Hugetlb: 5 kB\n", false);
  assert(sum.bytes == 12288 && sum.privateHugetlb.bytes == 8192);
  assert(sum.privateHugetlb.source == "/proc/self/smaps:sum(Private_Hugetlb)");
  for (const auto &text : {"Rss: 8 kB\nReferenced: 4 kB\n", "Rss: 8 kB\nPrivate_Hugetlb: -1 kB\n",
      "Rss: 8 kB\nPrivate_Hugetlb: 1 MB\n", "Rss: 8 kB\nPrivate_Hugetlb: 1 kB extra\n",
      "Rss: 8 kB\nPrivate_Hugetlb: 1 kB\nPrivate_Hugetlb: 2 kB\n",
      "Rss: 8 kB\nPrivate_Hugetlb: 18014398509481984 kB\n"}) {
    const auto bad = read(text); assert(bad.bytes == 8192 && !bad.privateHugetlb.bytes && !bad.privateHugetlb.error.empty());
  }
  for (const auto &text : {"Rss: 4 kB\nRss: 8 kB\nPrivate_Hugetlb: 3 kB\n",
      "Rss: 4 kB\nPrivate_Hugetlb: 3 kB\nRss: 8 kB\n",
      "Rss: 4 kB\nPrivate_Hugetlb: 18014398509481983 kB\nRss: 8 kB\nPrivate_Hugetlb: 1 kB\n"}) {
    const auto bad = read(text, false); assert(bad.bytes == 12288 && !bad.privateHugetlb.bytes);
  }
  assert(!read("Private_Hugetlb: 1 kB\nRss: 8 kB\n").privateHugetlb.bytes);
  assert(!read("Rss: 4 kB\nPrivate_Hugetlb: 1 kB\nRss: 4 kB\nRss: 4 kB\nPrivate_Hugetlb: 1 kB\n", false).privateHugetlb.bytes);
  const auto independent = read("Rss: 8 kB\nPrivate_Hugetlb: 16 kB\nReferenced: invalid kB\n");
  assert(independent.privateHugetlb.bytes == 16384 && !independent.referenced.bytes);
  const auto exact = read("Rss: 8 kB\nPrivate_Hugetlb: 18014398509481983 kB\n");
  assert(exact.privateHugetlb.bytes == 18446744073709550592ULL);
  std::cout << "Private_Hugetlb parser: zero, field selection, sum, missing regions, malformed data, duplicate and overflow checks passed\n";
#ifdef __ANDROID__
  alarm(30);
  const auto sample=[](const char *phase) {
    const auto reading=bench::readResidentMemory();assert(reading.privateHugetlb.bytes);
    std::ifstream raw("/proc/self/smaps_rollup");std::string line;bool seen=false;
    while(std::getline(raw,line)) if(line.rfind("Private_Hugetlb:",0)==0) {
      std::istringstream field(line.substr(16));uint64_t kb;std::string unit;
      assert(field>>kb>>unit);assert(unit=="kB" && kb*1024==*reading.privateHugetlb.bytes);
      std::cout << "raw rollup " << line << "\n";seen=true;
    }
    assert(seen);
    std::ifstream maps("/proc/self/smaps");const auto summed=bench::memoryFromSmaps(maps,false);
    assert(summed.privateHugetlb.bytes==reading.privateHugetlb.bytes);
    std::cout << phase << " privateHugetlb=" << *reading.privateHugetlb.bytes
      << " RSS=" << reading.bytes << " source=" << reading.privateHugetlb.source << "\n";
    return *reading.privateHugetlb.bytes;
  };
  const auto baseline=sample("baseline");
  constexpr size_t ordinarySize=1024*1024;
  void *ordinary=mmap(nullptr,ordinarySize,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  assert(ordinary!=MAP_FAILED);auto bytes=static_cast<volatile unsigned char *>(ordinary);
  for(size_t i=0;i<ordinarySize;i+=4096) bytes[i]=37;
  assert(sample("ordinary_written")==baseline);
  assert(munmap(ordinary,ordinarySize)==0);assert(sample("ordinary_released")==baseline);
  // No MAP_NORESERVE: do not defer failure for an absent pool until a page fault.
  // A bounded, explicit 2 MiB request does not create or resize a HugeTLB pool.
  constexpr size_t hugeSize=2*1024*1024;
  errno=0;void *huge=mmap(nullptr,hugeSize,PROT_READ|PROT_WRITE,
    MAP_PRIVATE|MAP_ANONYMOUS|MAP_HUGETLB|(21<<26),-1,0);const int saved=errno;
  std::cout << "Explicit 2 MiB MAP_HUGETLB mapping=" << (huge==MAP_FAILED?"failed":"accepted")
    << " errno=" << saved << " message=" << std::strerror(saved) << "\n";
  if(huge!=MAP_FAILED) {
    // Acceptance alone is not evidence of resident HugeTLB bytes. This probe
    // checks allocation access only; a fault/release test is a separate step.
    assert(munmap(huge,hugeSize)==0);
    std::cout << "Untouched reservation released; nonzero residency not tested\n";
  }
  assert(sample("after_probe")==baseline);
  std::cout << "Raw rollup and mapping sum agree; ordinary allocation excluded. No global settings changed.\n";
#endif
}
