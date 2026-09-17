#pragma once
#include "DarwinQueueABI.h"
#include <dlfcn.h>
#include <chrono>
// XNU/libproc compatibility ABI, self PID only. No descriptor duplication or
// event consumption; a fd can close/reuse between enumeration and its query.
static NSDictionary *darwinQueueSources() {
  using List=int(*)(int,int,uint64_t,void *,int);using Info=int(*)(int,int,int,void *,int);
  static List list=(List)dlsym(RTLD_DEFAULT,"proc_pidinfo");static Info info=(Info)dlsym(RTLD_DEFAULT,"proc_pidfdinfo");
  if(!list||!info)return @{@"error":@"libproc descriptor symbols unavailable"};
  BenchProcFdInfo fds[512]{};errno=0;const int bytes=list(getpid(),1,0,fds,sizeof(fds)),saved=errno;
  if(bytes<=0||bytes>sizeof(fds)||bytes%sizeof(fds[0]))return @{@"returnedBytes":@(bytes),@"errno":@(saved),@"error":@"descriptor enumeration unavailable or invalid reply"};
  NSMutableArray *rows=[NSMutableArray new],*types=[NSMutableArray new];bool limited=false;
  const auto end=std::chrono::steady_clock::now()+std::chrono::milliseconds(100);
  for(unsigned i=0;i<bytes/sizeof(fds[0]);++i){
    [types addObject:@{@"fd":@(fds[i].fd),@"nativeType":@(fds[i].type)}];
    if(fds[i].type!=5)continue;
    if(std::chrono::steady_clock::now()>=end){limited=true;break;}
    BenchQueueFdInfo v{};errno=0;const int count=info(getpid(),fds[i].fd,7,&v,sizeof(v)),error=errno;
    NSMutableDictionary *values=[NSMutableDictionary new];
    if(count==sizeof(v)){
      values[@"fileOpenFlags"]=exact(v.file.flags);values[@"fileStatus"]=exact(v.file.status);values[@"fileOffsetNative"]=signedExact(v.file.offset);values[@"fileType"]=signedExact(v.file.type);values[@"fileGuardFlags"]=exact(v.file.guardFlags);
      values[@"pendingEventCount"]=signedExact(v.stat.size);values[@"nativeEventStructBytes"]=signedExact(v.stat.blksize);values[@"queueState"]=exact(v.state);values[@"nativeInodeOrDynamicId"]=exact(v.stat.ino);values[@"nativeMode"]=exact(v.stat.mode);
    }
    [rows addObject:@{@"fd":@(fds[i].fd),@"returnedBytes":@(count),@"expectedBytes":@(sizeof(v)),@"errno":@(error),@"values":count==sizeof(v)?values:(id)NSNull.null}];
  }
  return @{@"descriptorTypes":types,@"queues":rows,@"enumerationBytes":@(bytes),@"descriptorLimitReached":@(bytes==sizeof(fds)),@"timeLimitReached":@(limited),@"scope":@"self FD-backed kqueues only; excludes non-FD dynamic workloops; native event count is not bytes or application work-item count; non-atomic descriptor reuse remains possible",@"error":NSNull.null};
}
static NSDictionary *darwinDynamicQueueSources() {
  using List=int(*)(int,uint64_t *,uint32_t);using Info=int(*)(int,int,uint64_t,void *,int);
  static List list=(List)dlsym(RTLD_DEFAULT,"proc_list_dynkqueueids");static Info info=(Info)dlsym(RTLD_DEFAULT,"proc_piddynkqueueinfo");
  if(!list||!info)return @{@"error":@"dynamic kqueue ABI symbols unavailable"};
  uint64_t ids[512]{};errno=0;const int count=list(getpid(),ids,sizeof(ids)),saved=errno;
  if(count<0)return @{@"reportedCount":@(count),@"errno":@(saved),@"error":@"dynamic queue enumeration failed"};
  NSMutableArray *rows=[NSMutableArray new];bool limited=false;
  const auto end=std::chrono::steady_clock::now()+std::chrono::milliseconds(100);
  for(int i=0;i<std::min(count,512);++i){if(std::chrono::steady_clock::now()>=end){limited=true;break;}
    BenchDynamicQueueInfo v{};errno=0;const int bytes=info(getpid(),0,ids[i],&v,sizeof(v)),error=errno;NSMutableDictionary *values=[NSMutableDictionary new];
    if(bytes==sizeof(v)){
      values[@"pendingEventCount"]=signedExact(v.stat.size);values[@"nativeEventStructBytes"]=signedExact(v.stat.blksize);values[@"queueState"]=exact(v.state);values[@"servicerThreadId"]=exact(v.servicer);values[@"ownerThreadId"]=exact(v.owner);values[@"syncWaiters"]=exact(v.syncWaiters);values[@"syncWaiterQos"]=exact(v.syncWaiterQos);values[@"asyncQos"]=exact(v.asyncQos);values[@"requestState"]=exact(v.requestState);values[@"eventsQos"]=exact(v.eventsQos);values[@"priority"]=exact(v.priority);values[@"policy"]=exact(v.policy);values[@"cpuPercentPolicy"]=exact(v.cpuPercent);
    }
    [rows addObject:@{@"queueId":exact(ids[i]),@"returnedBytes":@(bytes),@"expectedBytes":@(sizeof(v)),@"errno":@(error),@"values":bytes==sizeof(v)?values:(id)NSNull.null}];
  }
  return @{@"reportedCount":@(count),@"queues":rows,@"queueLimitReached":@(count>512),@"timeLimitReached":@(limited),@"scope":@"self dynamic workloops, exported Darwin ABI; non-atomic kernel enumeration; native QoS/policy fields, not interval CPU utilization or dispatch work-item counts",@"error":NSNull.null};
}
#include <sys/event.h>
static NSDictionary *ownedKqueueProbe() {
  using Info=int(*)(int,int,int,void *,int);auto info=(Info)dlsym(RTLD_DEFAULT,"proc_pidfdinfo");
  if(!info)return @{@"error":@"proc_pidfdinfo unavailable"};
  const int fd=kqueue();if(fd<0)return @{@"error":@"kqueue creation failed",@"errno":@(errno)};
  struct Owner{int fd;~Owner(){close(fd);}} owner{fd};
  auto snapshot=[&]()->NSDictionary * {BenchQueueFdInfo v{};errno=0;const int bytes=info(getpid(),fd,7,&v,sizeof(v)),error=errno;
    return @{@"returnedBytes":@(bytes),@"expectedBytes":@(sizeof(v)),@"errno":@(error),@"pendingEventCount":bytes==sizeof(v)?signedExact(v.stat.size):(id)NSNull.null};};
  NSDictionary *before=snapshot();struct kevent change{},event{};
  EV_SET(&change,42,EVFILT_USER,EV_ADD|EV_CLEAR,NOTE_TRIGGER,0,nullptr);
  const int submitted=kevent(fd,&change,1,nullptr,0,nullptr),submitError=submitted<0?errno:0;
  NSDictionary *triggered=snapshot();timespec timeout{};const int received=kevent(fd,nullptr,0,&event,1,&timeout),receiveError=received<0?errno:0;
  NSDictionary *consumed=snapshot();
  return @{@"before":before,@"afterTrigger":triggered,@"afterConsume":consumed,@"submitReturn":@(submitted),@"submitErrno":@(submitError),@"receiveReturn":@(received),@"receiveErrno":@(receiveError),@"eventVerified":@(received==1&&event.ident==42&&event.filter==EVFILT_USER),@"scope":@"one app-owned user event; only this probe consumes its own event",@"error":NSNull.null};
}
