#include "../ios/WfloatBench/DarwinQueueABI.h"
#include <sys/proc_info.h>
#include <libproc.h>
#include <sys/event.h>
#include <unistd.h>
#include <cassert>
#include <cstddef>
#include <iostream>
static_assert(sizeof(BenchQueueFdInfo)==sizeof(kqueue_fdinfo));
static_assert(offsetof(BenchQueueFdInfo,stat)==offsetof(kqueue_fdinfo,kqueueinfo));
static_assert(offsetof(BenchQueueFdInfo,state)==offsetof(kqueue_fdinfo,kqueueinfo)+offsetof(kqueue_info,kq_state));
static_assert(offsetof(BenchVInfoStat,size)==offsetof(vinfo_stat,vst_size));
static_assert(offsetof(BenchVInfoStat,blksize)==offsetof(vinfo_stat,vst_blksize));
static_assert(offsetof(BenchProcFileInfo,guardFlags)==offsetof(proc_fileinfo,fi_guardflags));
static_assert(sizeof(BenchDynamicQueueInfo)==sizeof(kqueue_dyninfo));
static_assert(offsetof(BenchDynamicQueueInfo,servicer)==offsetof(kqueue_dyninfo,kqdi_servicer));
static_assert(offsetof(BenchDynamicQueueInfo,requestState)==offsetof(kqueue_dyninfo,kqdi_request_state));
static_assert(offsetof(BenchDynamicQueueInfo,cpuPercent)==offsetof(kqueue_dyninfo,kqdi_cpupercent));
int main(){
 int fd=kqueue();assert(fd>=0);
 auto read=[&](){BenchQueueFdInfo v{};int n=proc_pidfdinfo(getpid(),fd,PROC_PIDFDKQUEUEINFO,&v,sizeof(v));assert(n==sizeof(v));return v.stat.size;};
 assert(read()==0);
 struct kevent change{},event{};EV_SET(&change,42,EVFILT_USER,EV_ADD|EV_CLEAR,NOTE_TRIGGER,0,nullptr);
 assert(kevent(fd,&change,1,nullptr,0,nullptr)==0);assert(read()==1);
 struct timespec timeout{};assert(kevent(fd,nullptr,0,&event,1,&timeout)==1);assert(event.ident==42);assert(read()==0);
 assert(close(fd)==0);std::cout<<"kqueue pending event count 0 -> 1 -> 0; 168-byte ABI matched native SDK\n";
}
