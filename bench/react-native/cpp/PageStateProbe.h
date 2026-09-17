#pragma once
#include "NativeJson.h"
#include <sys/mman.h>
#include <sys/resource.h>
#include <unistd.h>
#include <fcntl.h>
#include <cerrno>
#include <cstdint>
#include <time.h>
#include <vector>
#ifdef __APPLE__
#include <mach/mach.h>
#include <mach/vm_map.h>
#endif
namespace bench {
inline std::string pageStateProbe() {
  const auto stamp=[](){timespec t{};clock_gettime(CLOCK_MONOTONIC,&t);return uint64_t(t.tv_sec)*1000000000ULL+t.tv_nsec;};
  const long pageSize=sysconf(_SC_PAGESIZE);if(pageSize<=0)return jsonObject({{"error",jsonString("invalid page size")}});
  constexpr size_t count=16;const size_t bytes=count*pageSize;
  struct Mapping {void *p=MAP_FAILED;size_t n;~Mapping(){if(p!=MAP_FAILED)munmap(p,n);}} map{MAP_FAILED,bytes};
  map.p=mmap(nullptr,bytes,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0);
  if(map.p==MAP_FAILED)return jsonObject({{"error",jsonString("mmap failed")},{"errno",std::to_string(errno)}});
#ifndef __APPLE__
  struct File {int fd=-1;~File(){if(fd>=0)close(fd);}} pagemap{open("/proc/self/pagemap",O_RDONLY|O_CLOEXEC)};
  const int openError=pagemap.fd<0?errno:0;
#endif
  std::string phases="[";bool first=true;uint64_t checksum=0;
  const auto sample=[&](const char *name) {
    const auto began=stamp();
    std::vector<unsigned char> residency(count);
#ifdef __APPLE__
    const int rc=mincore(map.p,bytes,reinterpret_cast<char *>(residency.data()));
#else
    const int rc=mincore(map.p,bytes,residency.data());
#endif
    const int error=rc<0?errno:0;std::string pages="[";
    for(size_t i=0;i<count;++i) {
      if(i)pages+=',';
      const uintptr_t address=reinterpret_cast<uintptr_t>(map.p)+i*pageSize;
#ifdef __APPLE__
      integer_t disposition=0,refs=0;const auto code=vm_map_page_query(mach_task_self(),address,&disposition,&refs);
      const auto query=jsonObject({{"returnCode",std::to_string(code)},{"disposition",code==KERN_SUCCESS?jsonInteger(disposition):"null"},{"referenceCount",code==KERN_SUCCESS?jsonInteger(refs):"null"}});
#else
      uint64_t word=0;errno=0;const ssize_t read=pagemap.fd<0?-1:pread(pagemap.fd,&word,sizeof(word),static_cast<off_t>((address/pageSize)*8));
      const int code=pagemap.fd<0?openError:read==sizeof(word)?0:read<0?errno:EIO;
      const auto query=jsonObject({{"errno",std::to_string(code)},{"word",code==0?jsonInteger(word):"null"}});
#endif
      pages+=jsonObject({{"index",std::to_string(i)},{"mincoreRaw",rc==0?std::to_string(residency[i]):"null"},{"nativePageQuery",query}});
    }
    pages+=']';rusage usage{};const int usageError=getrusage(RUSAGE_SELF,&usage)==0?0:errno;
    if(!first)phases+=',';first=false;phases+=jsonObject({{"phase",jsonString(name)},{"startedMonotonicNs",jsonInteger(began)},{"finishedMonotonicNs",jsonInteger(stamp())},{"mincoreErrno",std::to_string(error)},{"pages",pages},{"rusageErrno",std::to_string(usageError)},{"minorFaults",jsonInteger(usage.ru_minflt)},{"majorFaults",jsonInteger(usage.ru_majflt)}});
  };
  sample("fresh_mapping");
  auto *p=static_cast<volatile unsigned char *>(map.p);
  for(size_t i=0;i<count;i+=2)checksum+=p[i*pageSize];sample("read_even_pages");
  for(size_t i=1;i<count;i+=2)p[i*pageSize]=static_cast<unsigned char>(i+1);sample("write_odd_pages");
  const int advice=madvise(map.p,bytes/2,MADV_DONTNEED),adviceError=advice<0?errno:0;sample("dontneed_first_half");
  phases+=']';
  return jsonObject({{"error","null"},{"pageSize",jsonInteger(pageSize)},{"pageCount",std::to_string(count)},{"address",jsonInteger(reinterpret_cast<uintptr_t>(map.p))},{"phases",phases},{"advice",jsonString("MADV_DONTNEED")},{"adviceErrno",std::to_string(adviceError)},{"checksum",jsonInteger(checksum)}});
}
}
