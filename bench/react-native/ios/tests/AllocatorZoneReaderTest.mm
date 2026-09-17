#import <Foundation/Foundation.h>
#include "../WfloatBench/AllocatorZoneSources.h"
#include <cassert>
int main(){@autoreleasepool{
 {benchAllocator::Reads reads;benchAllocator::active=&reads;uint64_t original=0xfedcba9876543210ULL;void *copy=nullptr;
  assert(benchAllocator::reader(mach_task_self(),(vm_address_t)&original,sizeof(original),&copy)==KERN_SUCCESS);assert(copy!=&original&&memcmp(copy,&original,sizeof(original))==0);assert(reads.bytes==sizeof(original));
  assert(benchAllocator::reader(mach_task_self(),1,8,&copy)!=KERN_SUCCESS);
  assert(benchAllocator::reader(mach_task_self(),(vm_address_t)&original,4*1024*1024+1,&copy)==KERN_RESOURCE_SHORTAGE);
  assert(reads.lastRequestedBytes==4*1024*1024+1);benchAllocator::active=nullptr;}
 auto result=benchAllocator::capture();assert(result[@"enumerationCode"]);auto data=[NSJSONSerialization dataWithJSONObject:result options:0 error:nil];fwrite(data.bytes,1,data.length,stdout);puts("\nPASS: copied bytes, invalid memory errors, copy bound, request diagnostics and zone enumeration");
}}
