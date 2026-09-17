#pragma once
#include "NativeJson.h"
#include "TcpSnapshot.h"
#include "SocketResourceOptions.h"
#include <vector>
#include <cstring>
#include <sys/stat.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <fcntl.h>
#include <unistd.h>
#include <cerrno>
#include <chrono>
#if defined(__linux__)
#include <linux/sock_diag.h>
#include <linux/sockios.h>
#endif
namespace bench {
inline std::string descriptorJson(const std::vector<std::pair<std::string,std::string>> &fields) {std::string out="{";bool first=true;for(const auto &f:fields){if(!first)out+=',';first=false;out+=jsonString(f.first)+":"+f.second;}return out+'}';}

inline std::string descriptorDetails(int fd) {
  struct stat v{};const int code=fstat(fd,&v),saved=code?errno:0;
  if(code)return jsonObject({{"fstatErrno",jsonInteger(saved)}});
  std::vector<std::pair<std::string,std::string>> fields={{"fstatErrno","0"},{"device",jsonInteger(v.st_dev)},{"inode",jsonInteger(v.st_ino)},{"mode",jsonInteger(v.st_mode)},{"links",jsonInteger(v.st_nlink)},{"uid",jsonInteger(v.st_uid)},{"gid",jsonInteger(v.st_gid)},{"rdev",jsonInteger(v.st_rdev)},{"sizeNative",jsonInteger(v.st_size)},{"sizeSemantics",jsonString("object-dependent stat size: regular-file bytes; Darwin kqueue pending event count; not universally bytes")},{"blocks512Bytes",jsonInteger(v.st_blocks)},{"preferredBlockBytes",jsonInteger(v.st_blksize)}};
#if defined(__APPLE__)
  fields.emplace_back("flags",jsonInteger(v.st_flags));fields.emplace_back("generation",jsonInteger(v.st_gen));
  const timespec times[]={v.st_atimespec,v.st_mtimespec,v.st_ctimespec,v.st_birthtimespec};
#else
  const timespec times[]={v.st_atim,v.st_mtim,v.st_ctim};
#endif
  const char *names[]={"access","modification","metadataChange","birth"};
  for(size_t i=0;i<sizeof(times)/sizeof(times[0]);++i)fields.emplace_back(std::string(names[i])+"Time",jsonObject({{"seconds",jsonInteger(times[i].tv_sec)},{"nanoseconds",jsonInteger(times[i].tv_nsec)}}));
  const int flags=fcntl(fd,F_GETFL);fields.emplace_back("statusFlags",flags>=0?jsonInteger(flags):"null");fields.emplace_back("statusFlagsErrno",jsonInteger(flags>=0?0:errno));
  if(S_ISSOCK(v.st_mode)) {
    fields.emplace_back("resourceOptions",socketResourceOptions(fd));
    std::string options="[";bool first=true;
    const std::pair<const char *,int> keys[]={{"SO_TYPE",SO_TYPE},{"SO_SNDBUF",SO_SNDBUF},{"SO_RCVBUF",SO_RCVBUF},{"SO_SNDLOWAT",SO_SNDLOWAT},{"SO_RCVLOWAT",SO_RCVLOWAT},{"SO_ACCEPTCONN",SO_ACCEPTCONN},{"SO_KEEPALIVE",SO_KEEPALIVE},{"SO_REUSEADDR",SO_REUSEADDR},{"SO_BROADCAST",SO_BROADCAST}};
#if defined(__linux__)
    uint32_t memory[SK_MEMINFO_VARS]{};socklen_t memorySize=sizeof(memory);
    const int mc=getsockopt(fd,SOL_SOCKET,SO_MEMINFO,memory,&memorySize),me=mc?errno:0;
    const char *memoryNames[]={"RMEM_ALLOC","RCVBUF","WMEM_ALLOC","SNDBUF","FWD_ALLOC","WMEM_QUEUED","OPTMEM","BACKLOG","DROPS"};
    std::string mem="[";
    for(size_t i=0;i<sizeof(memoryNames)/sizeof(memoryNames[0]);++i){if(i)mem+=',';mem+=jsonObject({{"name",jsonString(memoryNames[i])},{"value",!mc&&memorySize>=(i+1)*sizeof(uint32_t)?jsonInteger(memory[i]):"null"}});}mem+=']';
    fields.emplace_back("socketMemory",jsonObject({{"errno",jsonInteger(me)},{"returnedBytes",jsonInteger(memorySize)},{"fields",mem},{"scope",jsonString("Linux per-socket kernel accounting; byte allocations/limits except DROPS count; overlapping fields, not payload bytes or process RSS")}}));
    int queued=0;const int qc=ioctl(fd,SIOCOUTQ,&queued),qe=qc?errno:0;
    fields.emplace_back("SIOCOUTQ",jsonObject({{"value",qc?"null":jsonInteger(queued)},{"errno",jsonInteger(qe)}}));
#elif defined(__APPLE__)
    for(auto key:std::initializer_list<std::pair<const char *,int>>{{"SO_NREAD",SO_NREAD},{"SO_NWRITE",SO_NWRITE}}){int value=0;socklen_t size=sizeof(value);const int r=getsockopt(fd,SOL_SOCKET,key.second,&value,&size),e=r?errno:0;fields.emplace_back(key.first,jsonObject({{"value",r?"null":jsonInteger(value)},{"returnedBytes",jsonInteger(size)},{"errno",jsonInteger(e)}}));}
#endif
    // Never query SO_ERROR: that consumes pending socket errors.
    for(auto key:keys){int value=0;socklen_t size=sizeof(value);const int r=getsockopt(fd,SOL_SOCKET,key.second,&value,&size);const int e=r?errno:0;if(!first)options+=',';first=false;options+=jsonObject({{"name",jsonString(key.first)},{"value",r?"null":jsonInteger(value)},{"returnedBytes",jsonInteger(size)},{"errno",jsonInteger(e)}});}options+=']';fields.emplace_back("socketOptions",options);
    int pending=0;const int r=ioctl(fd,FIONREAD,&pending);const int e=r?errno:0;fields.emplace_back("pendingReadBytes",r?"null":jsonInteger(pending));fields.emplace_back("pendingReadErrno",jsonInteger(e));
    sockaddr_storage address{};socklen_t size=sizeof(address);const int ar=getsockname(fd,(sockaddr *)&address,&size);fields.emplace_back("addressFamily",ar?"null":jsonInteger(address.ss_family));fields.emplace_back("addressFamilyErrno",jsonInteger(ar?errno:0));
    int socketType=0;socklen_t typeSize=sizeof(socketType);if(!ar&&(address.ss_family==AF_INET||address.ss_family==AF_INET6)&&getsockopt(fd,SOL_SOCKET,SO_TYPE,&socketType,&typeSize)==0&&socketType==SOCK_STREAM){
      fields.emplace_back("tcpInfo",tcpSnapshot(fd));
#if defined(__linux__)
      int unsent=0;const int uc=ioctl(fd,SIOCOUTQNSD,&unsent),ue=uc?errno:0;
      fields.emplace_back("SIOCOUTQNSD",jsonObject({{"value",uc?"null":jsonInteger(unsent)},{"errno",jsonInteger(ue)}}));
#endif
    }
  }
  if(S_ISFIFO(v.st_mode)) {
    int pending=0;const int r=ioctl(fd,FIONREAD,&pending);fields.emplace_back("pendingReadBytes",r?"null":jsonInteger(pending));fields.emplace_back("pendingReadErrno",jsonInteger(r?errno:0));
#ifdef F_GETPIPE_SZ
    const int capacity=fcntl(fd,F_GETPIPE_SZ);fields.emplace_back("pipeCapacityBytes",capacity<0?"null":jsonInteger(capacity));fields.emplace_back("pipeCapacityErrno",jsonInteger(capacity<0?errno:0));
#endif
  }
  return descriptorJson(fields);
}
inline std::string descriptorSources() {
  struct rlimit limit{};if(getrlimit(RLIMIT_NOFILE,&limit))return jsonObject({{"error",jsonInteger(errno)}});
  const auto end=std::chrono::steady_clock::now()+std::chrono::milliseconds(100);uint64_t scanned=0,open=0;bool limited=false;std::string rows="[";
  for(;scanned<16384;++scanned){if(open>=512||std::chrono::steady_clock::now()>=end){limited=true;break;}errno=0;const int flags=fcntl((int)scanned,F_GETFD);const int flagError=flags<0?errno:0;if(flags<0&&flagError==EBADF)continue;
    if(open++)rows+=',';std::vector<std::pair<std::string,std::string>> row={{"fd",jsonInteger(scanned)},{"descriptorFlags",flags<0?"null":jsonInteger(flags)},{"descriptorFlagsErrno",jsonInteger(flagError)}};
    // Never duplicate arbitrary app descriptors. Darwin guards can terminate
    // on dup, and closing even a Linux duplicate releases this process's POSIX
    // record locks on the file. Independent read-only lookups accept fd-reuse
    // races rather than changing the resources being observed.
    row.emplace_back("lookupMode",jsonString("direct_nonatomic_no_duplication"));
    row.emplace_back("details",descriptorDetails((int)scanned));
    rows+=descriptorJson(row);
  }rows+=']';return jsonObject({{"descriptors",rows},{"openObserved",jsonInteger(open)},{"scannedExclusive",jsonInteger(scanned)},{"softLimit",jsonInteger(limit.rlim_cur)},{"maximumScanExclusive","16384"},{"boundedScanLimitReached",limited||scanned>=16384?"true":"false"},{"timeOrDescriptorLimitReached",limited?"true":"false"},{"rangeLimitReached",scanned>=16384?"true":"false"},{"scope",jsonString("existing app descriptors; non-atomic read-only lookups without duplication on both platforms; concurrent fd reuse can mix observations")}});
}
inline std::string ownedPipeProbe() {
  int fds[2];if(pipe(fds))return jsonObject({{"error",jsonInteger(errno)}});
  struct Owner{int *v;~Owner(){close(v[0]);close(v[1]);}} owner{fds};
  for(int fd:fds){const int flags=fcntl(fd,F_GETFL);if(flags<0||fcntl(fd,F_SETFL,flags|O_NONBLOCK)<0)return jsonObject({{"error",jsonInteger(errno)}});}
  const auto before=descriptorDetails(fds[0]);unsigned char sent[1024],received[1024];for(size_t i=0;i<sizeof(sent);++i)sent[i]=(unsigned char)i;
  const auto wrote=write(fds[1],sent,sizeof(sent));const int we=wrote<0?errno:0;const auto pending=descriptorDetails(fds[0]);const auto got=read(fds[0],received,sizeof(received));const int re=got<0?errno:0;const auto after=descriptorDetails(fds[0]);
  return jsonObject({{"before",before},{"afterWrite",pending},{"afterRead",after},{"writtenBytes",jsonInteger(wrote)},{"readBytes",jsonInteger(got)},{"writeErrno",jsonInteger(we)},{"readErrno",jsonInteger(re)},{"payloadVerified",wrote==sizeof(sent)&&got==sizeof(sent)&&memcmp(sent,received,sizeof(sent))==0?"true":"false"}});
}
inline std::string ownedSocketQueueProbe() {
  int fds[2];if(socketpair(AF_UNIX,SOCK_STREAM,0,fds))return jsonObject({{"error",jsonInteger(errno)}});
  struct Owner{int *v;~Owner(){close(v[0]);close(v[1]);}} owner{fds};
  for(int fd:fds){const int flags=fcntl(fd,F_GETFL);if(flags<0||fcntl(fd,F_SETFL,flags|O_NONBLOCK)<0)return jsonObject({{"error",jsonInteger(errno)}});}
  const auto snapshot=[&](){return jsonObject({{"sender",descriptorDetails(fds[0])},{"receiver",descriptorDetails(fds[1])}});};
  const auto before=snapshot();unsigned char sent[1024],received[1024];for(size_t i=0;i<sizeof(sent);++i)sent[i]=(unsigned char)i;
  const auto wrote=write(fds[0],sent,sizeof(sent));const int we=wrote<0?errno:0;const auto queued=snapshot();
  const auto got=read(fds[1],received,sizeof(received));const int re=got<0?errno:0;const auto after=snapshot();
  return jsonObject({{"before",before},{"queued",queued},{"afterDrain",after},{"writtenBytes",jsonInteger(wrote)},{"readBytes",jsonInteger(got)},{"writeErrno",jsonInteger(we)},{"readErrno",jsonInteger(re)},{"payloadVerified",wrote==sizeof(sent)&&got==sizeof(sent)&&memcmp(sent,received,sizeof(sent))==0?"true":"false"},{"scope",jsonString("owned local stream pair; native queue accounting can include metadata and differ by protocol")}});
}

}
