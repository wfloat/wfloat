#pragma once
#include "NativeJson.h"
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>
#include <cerrno>
#include <cstring>
#include <chrono>
#include <mutex>
#include <vector>
// Linux assigned cachestat 451 on all four supported Android architectures.
#ifndef __NR_cachestat
#define __NR_cachestat 451
#endif
namespace bench {
inline int fileChildSignal(int status){return WIFSIGNALED(status)?WTERMSIG(status):(WIFEXITED(status)&&WEXITSTATUS(status)==128+SIGSYS?SIGSYS:0);}
inline uint64_t fileWord(const unsigned char *p,size_t offset,size_t width){uint64_t v=0;memcpy(&v,p+offset,width);return v;}
inline std::string fileNativeHex(const unsigned char *p,size_t length){const char *h="0123456789abcdef";std::string s;for(size_t i=0;i<length;++i){s+=h[p[i]>>4];s+=h[p[i]&15];}return s;}
inline std::string statxResourceFields(const unsigned char *p){
  uint32_t mask=uint32_t(fileWord(p,0,4));std::string rows="[";bool first=true;
  struct Field{const char *name;uint32_t mask;size_t offset,width;};
  const Field fields[]={{"mountId",0x5000,144,8},{"directIoMemoryAlignmentBytes",0x2000,152,4},{"directIoOffsetAlignmentBytes",0x2000,156,4},{"subvolumeId",0x8000,160,8},{"atomicWriteMinimumBytes",0x10000,168,4},{"atomicWriteMaximumBytes",0x10000,172,4},{"atomicWriteMaximumSegments",0x10000,176,4},{"directIoReadOffsetAlignmentBytes",0x20000,180,4},{"atomicWriteOptimalMaximumBytes",0x10000,184,4}};
  for(auto &f:fields){if(!first)rows+=',';first=false;rows+=jsonObject({{"name",jsonString(f.name)},{"supported",mask&f.mask?"true":"false"},{"value",mask&f.mask?jsonInteger(fileWord(p,f.offset,f.width)):"null"}});}rows+=']';
  return jsonObject({{"returnedMask",jsonInteger(mask)},{"attributes",jsonInteger(fileWord(p,8,8))},{"supportedAttributes",jsonInteger(fileWord(p,56,8))},{"resourceFields",rows}});
}
// Independent children isolate each newer syscall's seccomp failure. No dup/close
// of parent descriptors, no data read or cache eviction. Child uses syscall wrappers only.
inline std::string fileResourceSources(bool cache){
  static std::mutex mutex;std::lock_guard<std::mutex> lock(mutex);static pid_t pending[2]{};static int blocked[2]{};const int kind=cache?1:0;auto &prior=pending[kind];
  if(blocked[kind])return jsonObject({{"state",jsonString("syscall child terminated by SIGSYS; cached for this app process")},{"childSignal",jsonInteger(blocked[kind])}});
  if(prior){int status=0;pid_t w;do{w=waitpid(prior,&status,WNOHANG);}while(w<0&&errno==EINTR);if(!w)return jsonObject({{"state",jsonString("prior syscall child still terminating")},{"timedOut","true"}});if(w<0&&errno!=ECHILD)return jsonObject({{"waitErrno",std::to_string(errno)}});if(w>0&&fileChildSignal(status)==SIGSYS){blocked[kind]=SIGSYS;prior=0;return jsonObject({{"childSignal",jsonInteger(SIGSYS)},{"state",jsonString("syscall child terminated by SIGSYS")}});}prior=0;}
  std::vector<int> fds;unsigned scanned=0;for(;scanned<16384&&fds.size()<512;++scanned){if(fcntl(int(scanned),F_GETFD)>=0)fds.push_back(int(scanned));}
  struct Row{int fd,error;uint32_t mode;uint64_t device,inode;alignas(8) unsigned char data[256];};std::vector<unsigned char> bytes((fds.size()+1)*sizeof(Row));int pipes[2];
  if(pipe2(pipes,O_CLOEXEC))return jsonObject({{"stage",jsonString("pipe")},{"errno",jsonInteger(errno)}});
  pid_t child=fork();if(child<0){int e=errno;close(pipes[0]);close(pipes[1]);return jsonObject({{"stage",jsonString("fork")},{"errno",jsonInteger(e)}});}
  if(!child){struct sigaction action{};action.sa_handler=+[](int){_exit(128+SIGSYS);};sigemptyset(&action.sa_mask);sigaction(SIGSYS,&action,nullptr);sigset_t unblocked;sigemptyset(&unblocked);sigaddset(&unblocked,SIGSYS);sigprocmask(SIG_UNBLOCK,&unblocked,nullptr);close(pipes[0]);for(int fd:fds){Row r{};r.fd=fd;struct stat identity{};if(fstat(fd,&identity)){r.error=errno;}else {r.device=identity.st_dev;r.inode=identity.st_ino;r.mode=identity.st_mode;long code=0;
      if(S_ISREG(identity.st_mode)){
      if(cache){uint64_t range[2]={0,0};code=syscall(__NR_cachestat,fd,range,r.data,0U);}else code=syscall(__NR_statx,fd,"",0x1000|0x4000,0x3ffffU,r.data);r.error=code<0?errno:0;}}
      size_t sent=0;while(sent<sizeof(r)){ssize_t n=write(pipes[1],reinterpret_cast<char*>(&r)+sent,sizeof(r)-sent);if(n<0&&errno==EINTR)continue;if(n<=0)_exit(2);sent+=size_t(n);}}
    close(pipes[1]);_exit(0);}
  close(pipes[1]);auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);size_t got=0;bool timeout=false,eof=false;int pe=0;
  while(got<bytes.size()){auto left=std::chrono::duration_cast<std::chrono::milliseconds>(deadline-std::chrono::steady_clock::now()).count();if(left<=0){timeout=true;break;}pollfd p{pipes[0],POLLIN|POLLHUP,0};int c=poll(&p,1,int(left));if(c<0){if(errno==EINTR)continue;pe=errno;break;}if(!c){timeout=true;break;}ssize_t n=read(pipes[0],bytes.data()+got,bytes.size()-got);if(n<0){if(errno==EINTR)continue;pe=errno;break;}if(!n){eof=true;break;}got+=size_t(n);}
  close(pipes[0]);if(timeout||pe)kill(child,SIGKILL);int status=0;pid_t waited;do{waited=waitpid(child,&status,WNOHANG);}while(waited<0&&errno==EINTR);if(!waited)prior=child;int we=waited<0?errno:0;if(waited==child&&fileChildSignal(status)==SIGSYS)blocked[kind]=SIGSYS;
  std::string rows="[";size_t emitted=0;size_t count=got/sizeof(Row);for(size_t i=0;i<count;++i){Row r{};memcpy(&r,bytes.data()+i*sizeof(Row),sizeof(r));if(!r.error&&!S_ISREG(r.mode))continue;std::string fields="null";
    if(!r.error){if(cache){fields=jsonObject({{"cachedPages",jsonInteger(fileWord(r.data,0,8))},{"dirtyPages",jsonInteger(fileWord(r.data,8,8))},{"writebackPages",jsonInteger(fileWord(r.data,16,8))},{"evictedPages",jsonInteger(fileWord(r.data,24,8))},{"recentlyEvictedPages",jsonInteger(fileWord(r.data,32,8))}});}else fields=statxResourceFields(r.data);}
    if(emitted++)rows+=',';rows+=jsonObject({{"fd",jsonInteger(r.fd)},{"device",jsonInteger(r.device)},{"inode",jsonInteger(r.inode)},{"errno",jsonInteger(r.error)},{"nativeBytesHex",r.error?"null":jsonString(fileNativeHex(r.data,cache?40:256))},{"values",fields}});}
  rows+=']';return jsonObject({{"files",rows},{"scannedDescriptorExclusive",jsonInteger(scanned)},{"descriptorScanBound",jsonInteger(16384)},{"candidateDescriptors",jsonInteger(fds.size())},{"descriptorLimitReached",fds.size()==512?"true":"false"},{"complete",eof&&count==fds.size()&&got%sizeof(Row)==0?"true":"false"},{"timedOut",timeout?"true":"false"},{"childSignal",waited==child&&fileChildSignal(status)?jsonInteger(fileChildSignal(status)):"null"},{"pipeErrno",jsonInteger(pe)},{"waitErrno",jsonInteger(we)},{"scope",jsonString(cache?"cachestat over whole existing regular files: current cached/dirty/writeback and surviving eviction-shadow page counts, not cumulative lifetime eviction events. No data read, mapping, cache eviction or elevated identity. Shared file page cache is not app-private RSS; unowned/read-only files can be denied.":"statx on existing regular descriptors with AT_EMPTY_PATH|AT_STATX_DONT_SYNC; requested known mask 0x3ffff. Full 256-byte native ABI retained, returned masks determine validity; no forced filesystem synchronization. Descriptor reuse before fork is possible; child device/inode identifies the actual object.")}});
}
}
