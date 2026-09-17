#pragma once
#import <Foundation/Foundation.h>
#include <mach/mach.h>
#include <sys/sysctl.h>
#include <vector>
#include <cstring>
#include <cerrno>
// XNU kern_sysctl.h ABI: seven native uint64 words per object.
inline NSDictionary *ownedVMObjectSources() {
  mach_port_name_t own=mach_task_self();size_t required=0;errno=0;
  int sizing=sysctlbyname("vm.get_owned_vmobjects",nullptr,&required,&own,sizeof(own)),sizingError=sizing?errno:0;
  NSMutableDictionary *result=[@{@"sizingReturnCode":@(sizing),@"sizingErrno":@(sizingError),@"requiredBytesAtSizing":@(required).stringValue,@"recordBytes":@56,@"scope":@"task-owned VM objects, not all virtual mappings; may include unmapped purgeable objects. Sizes in bytes; object ID is a kernel hash, external virtual size may be zero. Task port is an input selector, not a mutation; non-atomic sizing/query."} mutableCopy];
  if(sizing)return result;
  if(!required){result[@"objects"]=@[];result[@"layoutValid"]=@YES;result[@"reportedCount"]=@"0";return result;}
  constexpr size_t cap=8+4096*56;const size_t requested=std::min(cap,std::max(required,size_t(64)));
  std::vector<uint64_t> buffer((requested+7)/8);size_t size=requested;errno=0;
  const int rc=sysctlbyname("vm.get_owned_vmobjects",buffer.data(),&size,&own,sizeof(own)),error=rc?errno:0;
  const uint64_t count=!rc&&size>=8?buffer[0]:0;const bool valid=!rc&&size<=requested&&size>=8&&count<=(size-8)/56&&size==8+count*56;
  result[@"returnCode"]=@(rc);result[@"errno"]=@(error);result[@"returnedBytes"]=@(size);result[@"layoutValid"]=@(valid);result[@"possiblyTruncated"]=@(required>cap||size==cap||error==ENOMEM);
  NSMutableArray *objects=[NSMutableArray new];
  if(valid)for(uint64_t i=0;i<count;++i){const uint64_t*v=buffer.data()+1+i*7;[objects addObject:@{@"object_id":@(v[0]).stringValue,@"virtual_size":@(v[1]).stringValue,@"resident_size":@(v[2]).stringValue,@"wired_size":@(v[3]).stringValue,@"reusable_size":@(v[4]).stringValue,@"compressed_size":@(v[5]).stringValue,@"flagsRaw":@(v[6]).stringValue,@"vo_no_footprint":@(v[6]&1),@"vo_ledger_tag":@((v[6]>>1)&7),@"purgable":@((v[6]>>4)&3)}];}
  result[@"reportedCount"]=valid?@(count).stringValue:(id)NSNull.null;result[@"objects"]=objects;return result;
}
