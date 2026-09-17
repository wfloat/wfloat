#pragma once
#include "NativeJson.h"
#include <linux/bpf.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>
#include <fcntl.h>
#include <cerrno>
#include <cstdint>
#include <time.h>
namespace bench {
// Read AOSP's existing pinned gpu_mem_total map, never load/attach BPF programs.
// A same-identity child contains seccomp SIGSYS. Only syscalls after fork.
inline std::string bpfGpuMemorySource() {
  struct Row {uint64_t key,value;int error;};
  struct Report {int openError,infoError,nextError;uint32_t type,keySize,valueSize,maxEntries,scanned,count;bool limited;Row rows[64];};
  int pipes[2];if(pipe2(pipes,O_CLOEXEC))return jsonObject({{"error",jsonString("pipe")},{"errno",std::to_string(errno)}});
  const uint32_t owner=getpid();const pid_t child=fork();
  if(child<0){const int e=errno;close(pipes[0]);close(pipes[1]);return jsonObject({{"error",jsonString("fork")},{"errno",std::to_string(e)}});}
  if(!child){
    close(pipes[0]);Report r{};const char path[]="/sys/fs/bpf/map_gpuMem_gpu_mem_total_map";
    union bpf_attr attr{};attr.pathname=(uint64_t)(uintptr_t)path;attr.file_flags=BPF_F_RDONLY;
    const int fd=(int)syscall(__NR_bpf,BPF_OBJ_GET,&attr,sizeof(attr));
    if(fd<0)r.openError=errno;
    else {
      bpf_map_info info{};attr={};attr.info.bpf_fd=fd;attr.info.info_len=sizeof(info);attr.info.info=(uint64_t)(uintptr_t)&info;
      if(syscall(__NR_bpf,BPF_OBJ_GET_INFO_BY_FD,&attr,sizeof(attr)))r.infoError=errno;
      else {
        r.type=info.type;r.keySize=info.key_size;r.valueSize=info.value_size;r.maxEntries=info.max_entries;
        // Never read per-CPU maps into scalar storage, even if value_size is 8.
        if((info.type!=BPF_MAP_TYPE_HASH&&info.type!=BPF_MAP_TYPE_LRU_HASH)||info.key_size!=8||info.value_size!=8)r.infoError=EPROTO;
        else {
          uint64_t key=0,nextKey=0;bool first=true;
          while(r.scanned<4096){
            attr={};attr.map_fd=fd;attr.key=first?0:(uint64_t)(uintptr_t)&key;attr.next_key=(uint64_t)(uintptr_t)&nextKey;
            if(syscall(__NR_bpf,BPF_MAP_GET_NEXT_KEY,&attr,sizeof(attr))){r.nextError=errno==ENOENT?0:errno;break;}
            first=false;key=nextKey;++r.scanned;
            if((uint32_t)key!=0&&(uint32_t)key!=owner)continue;
            if(r.count>=64){r.limited=true;break;}
            Row &row=r.rows[r.count++];row.key=key;attr={};attr.map_fd=fd;attr.key=(uint64_t)(uintptr_t)&row.key;attr.value=(uint64_t)(uintptr_t)&row.value;
            if(syscall(__NR_bpf,BPF_MAP_LOOKUP_ELEM,&attr,sizeof(attr)))row.error=errno;
          }
          if(r.scanned>=4096)r.limited=true;
        }
      }
      close(fd);
    }
    const ssize_t sent=write(pipes[1],&r,sizeof(r));close(pipes[1]);_exit(sent==sizeof(r)?0:2);
  }
  close(pipes[1]);Report r{};size_t received=0;bool timeout=false;int pipeError=0;
  auto now=[](){timespec t{};clock_gettime(CLOCK_MONOTONIC,&t);return int64_t(t.tv_sec)*1000+t.tv_nsec/1000000;};const auto deadline=now()+3000;
  while(received<sizeof(r)){
    const auto remaining=deadline-now();if(remaining<=0){timeout=true;break;}pollfd p{pipes[0],POLLIN|POLLHUP,0};const int rc=poll(&p,1,(int)remaining);
    if(rc==0){timeout=true;break;}if(rc<0){if(errno==EINTR)continue;pipeError=errno;break;}
    const auto n=read(pipes[0],(char*)&r+received,sizeof(r)-received);if(n<0){if(errno==EINTR)continue;pipeError=errno;break;}if(!n)break;received+=n;
  }
  close(pipes[0]);if(timeout||pipeError)kill(child,SIGKILL);int status=0;pid_t waited;do{waited=waitpid(child,&status,0);}while(waited<0&&errno==EINTR);const int waitError=waited<0?errno:0;
  const bool complete=received==sizeof(r)&&!waitError&&WIFEXITED(status)&&WEXITSTATUS(status)==0;
  std::string rows="[";if(complete)for(uint32_t i=0;i<r.count;++i){if(i)rows+=',';const auto &v=r.rows[i];rows+=jsonObject({{"gpuId",jsonInteger(v.key>>32)},{"pid",jsonInteger((uint32_t)v.key)},{"bytes",v.error?"null":jsonInteger(v.value)},{"errno",std::to_string(v.error)}});}rows+=']';
  return jsonObject({{"scope",jsonString("AOSP pinned gpu_mem_total; own parent PID and PID 0 global totals only; bytes, non-atomic map iteration, no program load/attach or map writes")},{"reportComplete",complete?"true":"false"},{"mapReadable",complete&&!r.openError&&!r.infoError?"true":"false"},{"openErrno",complete?std::to_string(r.openError):"null"},{"infoErrno",complete?std::to_string(r.infoError):"null"},{"nextErrno",complete?std::to_string(r.nextError):"null"},{"mapType",std::to_string(r.type)},{"keyBytes",std::to_string(r.keySize)},{"valueBytes",std::to_string(r.valueSize)},{"maxEntries",std::to_string(r.maxEntries)},{"scannedKeys",std::to_string(r.scanned)},{"limitReached",r.limited?"true":"false"},{"entries",rows},{"timedOut",timeout?"true":"false"},{"pipeErrno",std::to_string(pipeError)},{"waitErrno",std::to_string(waitError)},{"childSignal",!waitError&&WIFSIGNALED(status)?std::to_string(WTERMSIG(status)):"null"}});
}
}
