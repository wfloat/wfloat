#pragma once
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
// Small independent breadcrumb file survives a crash or a stalled probe queue.
static void metalProbeProgress(NSString *phase) {
  NSString *directory=[NSHomeDirectory() stringByAppendingPathComponent:@"Documents/source-captures"];
  [NSFileManager.defaultManager createDirectoryAtPath:directory withIntermediateDirectories:YES attributes:nil error:nil];
  NSData *data=[NSJSONSerialization dataWithJSONObject:@{@"phase":phase,@"receivedAtMs":@(NSDate.date.timeIntervalSince1970*1000.),@"uptimeSeconds":@(NSProcessInfo.processInfo.systemUptime)} options:0 error:nil];
  int fd=open([[directory stringByAppendingPathComponent:@"metal-probe-progress.jsonl"] fileSystemRepresentation],O_WRONLY|O_CREAT|O_APPEND|O_CLOEXEC,0600);
  if(fd<0)return;struct stat info{};if(fstat(fd,&info)==0&&info.st_size<65536&&data){write(fd,data.bytes,data.length);write(fd,"\n",1);}close(fd);
}
