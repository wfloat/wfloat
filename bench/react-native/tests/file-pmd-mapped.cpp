#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>
#include <chrono>
#include <thread>
#include <sys/stat.h>
#include <sys/vfs.h>

int main() {
  std::cout << std::unitbuf;
  const auto read = [](const std::string &text, bool rollup = true) {
    std::istringstream input(text); return bench::memoryFromSmaps(input, rollup);
  };
  for (const auto kb : {0, 4, 65536}) {
    const auto sample = read("Rss: 8 kB\nPss: 4 kB\nReferenced: 999999 kB\nFilePmdMapped: " + std::to_string(kb) + " kB\n");
    assert(sample.bytes == 8192 && sample.pss.bytes == 4096 && sample.filePmdMapped.bytes == kb * 1024ULL);
  }
  const auto sum = read("Rss: 4 kB\nFilePmdMapped: 3 kB\nRss: 8 kB\nFilePmdMapped: 5 kB\n", false);
  assert(sum.bytes == 12288 && sum.filePmdMapped.bytes == 8192);
  assert(sum.filePmdMapped.source == "/proc/self/smaps:sum(FilePmdMapped)");
  for (const auto &text : {"Rss: 8 kB\nReferenced: 4 kB\n", "Rss: 8 kB\nFilePmdMapped: -1 kB\n",
      "Rss: 8 kB\nFilePmdMapped: 1 MB\n", "Rss: 8 kB\nFilePmdMapped: 1 kB extra\n",
      "Rss: 8 kB\nFilePmdMapped: 1 kB\nFilePmdMapped: 2 kB\n",
      "Rss: 8 kB\nFilePmdMapped: 18014398509481984 kB\n"}) {
    const auto bad = read(text); assert(bad.bytes == 8192 && !bad.filePmdMapped.bytes && !bad.filePmdMapped.error.empty());
  }
  for (const auto &text : {"Rss: 4 kB\nRss: 8 kB\nFilePmdMapped: 3 kB\n",
      "Rss: 4 kB\nFilePmdMapped: 3 kB\nRss: 8 kB\n",
      "Rss: 4 kB\nFilePmdMapped: 18014398509481983 kB\nRss: 8 kB\nFilePmdMapped: 1 kB\n"}) {
    const auto bad = read(text, false); assert(bad.bytes == 12288 && !bad.filePmdMapped.bytes);
  }
  assert(!read("FilePmdMapped: 1 kB\nRss: 8 kB\n").filePmdMapped.bytes);
  assert(!read("Rss: 4 kB\nFilePmdMapped: 1 kB\nRss: 4 kB\nRss: 4 kB\nFilePmdMapped: 1 kB\n", false).filePmdMapped.bytes);
  const auto independent = read("Rss: 8 kB\nFilePmdMapped: 16 kB\nReferenced: invalid kB\n");
  assert(independent.filePmdMapped.bytes == 16384 && !independent.referenced.bytes);
  const auto exact = read("Rss: 8 kB\nFilePmdMapped: 18014398509481983 kB\n");
  assert(exact.filePmdMapped.bytes == 18446744073709550592ULL);
  std::cout << "FilePmdMapped parser: zero, field selection, sum, missing regions, malformed data, duplicate and overflow checks passed\n";
#ifdef __ANDROID__
  alarm(30);
  uint64_t size=0;std::ifstream("/sys/kernel/mm/transparent_hugepage/hpage_pmd_size")>>size;
  const long page=sysconf(_SC_PAGESIZE);
  if(page<=0 || size<static_cast<uint64_t>(page) || size>8*1024*1024 || (size&(size-1))) {
    std::cout << "PMD size unavailable/out of bounds; live experiment skipped\n";return 0;
  }
  char path[]="/data/local/tmp/wfloat-file-pmd-XXXXXX";
  int writer=mkstemp(path);assert(writer>=0);
  struct statfs fs{};assert(fstatfs(writer,&fs)==0);
  std::cout << "PMD bytes=" << size << " base page bytes=" << page << " filesystem magic=" << std::hex << fs.f_type << std::dec << "\n";
  assert(fs.f_type!=0x01021994); // tmpfs is a separate metric.
  std::vector<unsigned char> block(page, 37);
  for(size_t offset=0;offset<size;offset+=page) assert(write(writer,block.data(),block.size())==static_cast<ssize_t>(block.size()));
  assert(fsync(writer)==0);assert(fchmod(writer,0500)==0);assert(close(writer)==0);
  const int fd=open(path,O_RDONLY);assert(fd>=0);assert(unlink(path)==0);
  const auto sample=[](const char *phase) {
    auto r=bench::readResidentMemory();assert(r.filePmdMapped.bytes);
    std::cout << phase << " filePmdMapped=" << *r.filePmdMapped.bytes << " RSS=" << r.bytes << " bytes\n";
    std::ifstream raw("/proc/self/smaps_rollup");std::string line;
    while(std::getline(raw,line)) if(line.rfind("FilePmdMapped:",0)==0) std::cout << "raw rollup " << line << "\n";
    return *r.filePmdMapped.bytes;
  };
  sample("baseline");
  for(const bool huge:{false,true}) {
    void *reservation=mmap(nullptr,size*2,PROT_NONE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);assert(reservation!=MAP_FAILED);
    const auto first=reinterpret_cast<uintptr_t>(reservation),aligned=(first+size-1)&~(size-1);
    const size_t prefix=aligned-first,suffix=size-prefix;
    // MAP_FIXED replaces only the subrange owned by this reservation.
    void *region=mmap(reinterpret_cast<void *>(aligned),size,PROT_READ|PROT_EXEC,MAP_PRIVATE|MAP_FIXED,fd,0);
    if(region==MAP_FAILED) {
      std::cout << "Read/execute file mapping failed errno=" << errno << "; live huge-page response unverified\n";
      assert(munmap(reservation,size*2)==0);break;
    }
    if(prefix) assert(munmap(reservation,prefix)==0);
    if(suffix) assert(munmap(reinterpret_cast<void *>(aligned+size),suffix)==0);
    errno=0;const int advice=madvise(region,size,huge?MADV_HUGEPAGE:MADV_NOHUGEPAGE),adviceError=errno;
    std::cout << (huge?"MADV_HUGEPAGE":"MADV_NOHUGEPAGE") << " status=" << advice << " errno=" << adviceError << "\n";
    auto bytes=static_cast<volatile unsigned char *>(region);
    for(size_t offset=0;offset<size;offset+=page) assert(bytes[offset]==37);
    auto held=sample(huge?"huge_read":"base_read");
    if(huge) {
      errno=0;const int result=madvise(region,size,MADV_COLLAPSE),saved=errno;
      std::cout << "MADV_COLLAPSE status=" << result << " errno=" << saved << "\n";
      held=sample("after_collapse");
    }
    std::ifstream maps("/proc/self/smaps");std::string line;bool target=false;
    while(std::getline(maps,line)) {
      std::istringstream fields(line);std::string token;fields>>token;const auto dash=token.find('-');
      if(dash!=std::string::npos && token.find(':')==std::string::npos) {
        try { const auto lo=std::stoull(token.substr(0,dash),nullptr,16),hi=std::stoull(token.substr(dash+1),nullptr,16);target=lo<=aligned && aligned<hi; }
        catch(...) { target=false; }
      }
      if(target && (line.rfind("FilePmdMapped:",0)==0 || line.rfind("Rss:",0)==0 || line.rfind("THPeligible:",0)==0 || line.rfind("VmFlags:",0)==0)) std::cout << "mapping " << line << "\n";
    }
    for(size_t offset=0;offset<size;offset+=page) assert(bytes[offset]==37);
    assert(munmap(region,size)==0);const auto released=sample(huge?"huge_released":"base_released");
    if(huge) std::cout << "Nonzero mapping/release response observed=" << (held>=size && held-released>=size?"yes":"no") << "\n";
  }
  assert(close(fd)==0);
  std::cout << "File bytes verified; mappings and temporary file released. No global THP settings changed.\n";
#endif
}
