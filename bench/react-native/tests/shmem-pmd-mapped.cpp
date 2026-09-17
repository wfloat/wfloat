#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>
#include <chrono>
#include <thread>
#include <sys/stat.h>
#include <sys/vfs.h>
#include <sys/syscall.h>
#include <linux/memfd.h>

int main() {
  std::cout << std::unitbuf;
  const auto read = [](const std::string &text, bool rollup = true) {
    std::istringstream input(text); return bench::memoryFromSmaps(input, rollup);
  };
  for (const auto kb : {0, 4, 65536}) {
    const auto sample = read("Rss: 8 kB\nPss: 4 kB\nReferenced: 999999 kB\nShmemPmdMapped: " + std::to_string(kb) + " kB\n");
    assert(sample.bytes == 8192 && sample.pss.bytes == 4096 && sample.shmemPmdMapped.bytes == kb * 1024ULL);
  }
  const auto sum = read("Rss: 4 kB\nShmemPmdMapped: 3 kB\nRss: 8 kB\nShmemPmdMapped: 5 kB\n", false);
  assert(sum.bytes == 12288 && sum.shmemPmdMapped.bytes == 8192);
  assert(sum.shmemPmdMapped.source == "/proc/self/smaps:sum(ShmemPmdMapped)");
  for (const auto &text : {"Rss: 8 kB\nReferenced: 4 kB\n", "Rss: 8 kB\nShmemPmdMapped: -1 kB\n",
      "Rss: 8 kB\nShmemPmdMapped: 1 MB\n", "Rss: 8 kB\nShmemPmdMapped: 1 kB extra\n",
      "Rss: 8 kB\nShmemPmdMapped: 1 kB\nShmemPmdMapped: 2 kB\n",
      "Rss: 8 kB\nShmemPmdMapped: 18014398509481984 kB\n"}) {
    const auto bad = read(text); assert(bad.bytes == 8192 && !bad.shmemPmdMapped.bytes && !bad.shmemPmdMapped.error.empty());
  }
  for (const auto &text : {"Rss: 4 kB\nRss: 8 kB\nShmemPmdMapped: 3 kB\n",
      "Rss: 4 kB\nShmemPmdMapped: 3 kB\nRss: 8 kB\n",
      "Rss: 4 kB\nShmemPmdMapped: 18014398509481983 kB\nRss: 8 kB\nShmemPmdMapped: 1 kB\n"}) {
    const auto bad = read(text, false); assert(bad.bytes == 12288 && !bad.shmemPmdMapped.bytes);
  }
  assert(!read("ShmemPmdMapped: 1 kB\nRss: 8 kB\n").shmemPmdMapped.bytes);
  assert(!read("Rss: 4 kB\nShmemPmdMapped: 1 kB\nRss: 4 kB\nRss: 4 kB\nShmemPmdMapped: 1 kB\n", false).shmemPmdMapped.bytes);
  const auto independent = read("Rss: 8 kB\nShmemPmdMapped: 16 kB\nReferenced: invalid kB\n");
  assert(independent.shmemPmdMapped.bytes == 16384 && !independent.referenced.bytes);
  const auto exact = read("Rss: 8 kB\nShmemPmdMapped: 18014398509481983 kB\n");
  assert(exact.shmemPmdMapped.bytes == 18446744073709550592ULL);
  std::cout << "ShmemPmdMapped parser: zero, field selection, sum, missing regions, malformed data, duplicate and overflow checks passed\n";
#ifdef __ANDROID__
  alarm(30);
  uint64_t size=0;std::ifstream("/sys/kernel/mm/transparent_hugepage/hpage_pmd_size")>>size;
  const long page=sysconf(_SC_PAGESIZE);
  if(page<=0 || size<static_cast<uint64_t>(page) || size>8*1024*1024 || (size&(size-1))) {
    std::cout << "PMD size unavailable/out of bounds; live experiment skipped\n";return 0;
  }
  const int fd=static_cast<int>(syscall(__NR_memfd_create,"wfloat-shmem-pmd",MFD_CLOEXEC));assert(fd>=0);
  assert(ftruncate(fd,size)==0);struct statfs fs{};assert(fstatfs(fd,&fs)==0);assert(fs.f_type==0x01021994);
  std::cout << "PMD bytes=" << size << " base page bytes=" << page << " filesystem magic=" << std::hex << fs.f_type << std::dec << "\n";
  const auto sample=[](const char *phase) {
    auto r=bench::readResidentMemory();assert(r.shmemPmdMapped.bytes && r.filePmdMapped.bytes && r.anonHugePages.bytes);
    std::cout << phase << " shmemPmdMapped=" << *r.shmemPmdMapped.bytes << " RSS=" << r.bytes
      << " PSS=" << (r.pss.bytes?std::to_string(*r.pss.bytes):"unavailable")
      << " FilePmdMapped=" << *r.filePmdMapped.bytes << " AnonHugePages=" << *r.anonHugePages.bytes << " bytes\n";
    std::ifstream raw("/proc/self/smaps_rollup");std::string line;
    while(std::getline(raw,line)) if(line.rfind("ShmemPmdMapped:",0)==0) std::cout << "raw rollup " << line << "\n";
    return *r.shmemPmdMapped.bytes;
  };
  const auto mapAligned=[&]() {
    void *reservation=mmap(nullptr,size*2,PROT_NONE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(reservation!=MAP_FAILED);
    const auto first=reinterpret_cast<uintptr_t>(reservation),aligned=(first+size-1)&~(size-1);
    const size_t prefix=aligned-first,suffix=size-prefix;
    // Replace only a subrange of this diagnostic's own address reservation.
    void *region=mmap(reinterpret_cast<void *>(aligned),size,PROT_READ|PROT_WRITE,MAP_SHARED|MAP_FIXED,fd,0);assert(region!=MAP_FAILED);
    if(prefix) assert(munmap(reservation,prefix)==0);
    if(suffix) assert(munmap(reinterpret_cast<void *>(aligned+size),suffix)==0);
    return region;
  };
  const auto collapse=[&](void *region) {
    errno=0;const int result=madvise(region,size,MADV_COLLAPSE),saved=errno;
    std::cout << "MADV_COLLAPSE status=" << result << " errno=" << saved << "\n";
  };
  const auto baseline=sample("baseline");
  void *base=mapAligned();assert(madvise(base,size,MADV_NOHUGEPAGE)==0);
  auto bytes=static_cast<volatile unsigned char *>(base);
  for(size_t offset=0;offset<size;offset+=page) bytes[offset]=43;
  sample("base_written");assert(munmap(base,size)==0);sample("base_released");
  void *region=mapAligned();assert(madvise(region,size,MADV_HUGEPAGE)==0);
  bytes=static_cast<volatile unsigned char *>(region);
  for(size_t offset=0;offset<size;offset+=page) assert(bytes[offset]==43);
  sample("huge_read");collapse(region);const auto held=sample("after_collapse");
  // A second virtual mapping of the same object does not allocate another
  // shared-memory object. Test that non-proportional mapping accounting agrees.
  void *alias=mapAligned();assert(madvise(alias,size,MADV_HUGEPAGE)==0);
  auto other=static_cast<volatile unsigned char *>(alias);
  for(size_t offset=0;offset<size;offset+=page) assert(other[offset]==43);
  collapse(alias);const auto doubled=sample("two_mappings");
  other[0]=59;assert(bytes[0]==59); // Validate actual sharing.
  assert(munmap(alias,size)==0);const auto single=sample("alias_released");
  for(size_t offset=page;offset<size;offset+=page) assert(bytes[offset]==43);
  assert(munmap(region,size)==0);const auto released=sample("all_released");
  const bool response=held==baseline+size && doubled==baseline+size*2 && single==held && released==baseline;
  std::cout << "One/two/one/zero mapping response observed=" << (response?"yes":"no") << "\n";
  assert(close(fd)==0);
  std::cout << "Shared data verified; mappings and memfd released. No global THP settings changed.\n";
#endif
}
