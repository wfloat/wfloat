#pragma once
#include <cstdint>
struct BenchProcFdInfo {int32_t fd;uint32_t type;};
struct BenchProcFileInfo {uint32_t flags,status;int64_t offset;int32_t type;uint32_t guardFlags;};
struct BenchVInfoStat {
  uint32_t dev;uint16_t mode,nlink;uint64_t ino;uint32_t uid,gid;
  int64_t atime,atimensec,mtime,mtimensec,ctime,ctimensec,birthtime,birthtimensec,size,blocks;
  int32_t blksize;uint32_t flags,gen,rdev;int64_t reserved[2];
};
struct BenchQueueFdInfo {BenchProcFileInfo file;BenchVInfoStat stat;uint32_t state,reserved;};
static_assert(sizeof(BenchProcFdInfo)==8);static_assert(sizeof(BenchProcFileInfo)==24);
static_assert(sizeof(BenchVInfoStat)==136);static_assert(sizeof(BenchQueueFdInfo)==168);
struct BenchDynamicQueueInfo {
  BenchVInfoStat stat;uint32_t state,reserved;
  uint64_t servicer,owner;uint32_t syncWaiters;uint8_t syncWaiterQos,asyncQos;uint16_t requestState;
  uint8_t eventsQos,priority,policy,cpuPercent,reserved0[4];uint64_t reserved1[4];
};
static_assert(sizeof(BenchDynamicQueueInfo)==208);
