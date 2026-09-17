#pragma once
#import <Foundation/Foundation.h>
#include <mach/mach.h>
#include <mach/vm_purgable.h>
#include <cstring>
#include "LedgerSources.h"
#include "OwnedVMObjectSources.h"
inline NSDictionary *purgeableQueueValues(const task_purgable_info_t &v) {
  NSMutableDictionary *values=[NSMutableDictionary new];
  for(int i=0;i<8;++i){values[[NSString stringWithFormat:@"fifo_data[%d].count",i]]=@(v.fifo_data[i].count).stringValue;values[[NSString stringWithFormat:@"fifo_data[%d].size",i]]=@(v.fifo_data[i].size).stringValue;values[[NSString stringWithFormat:@"lifo_data[%d].count",i]]=@(v.lifo_data[i].count).stringValue;values[[NSString stringWithFormat:@"lifo_data[%d].size",i]]=@(v.lifo_data[i].size).stringValue;}
  values[@"obsolete_data.count"]=@(v.obsolete_data.count).stringValue;values[@"obsolete_data.size"]=@(v.obsolete_data.size).stringValue;return values;
}
inline NSDictionary *ownedPurgeableQueueProbe() {
  NSMutableArray *phases=[NSMutableArray new];
  const auto snapshot=[&](NSString *phase){
    task_purgable_info_t v{};const auto code=task_purgable_info(mach_task_self(),&v);
    task_vm_info_data_t vm{};mach_msg_type_number_t count=TASK_VM_INFO_COUNT;
    const auto vmCode=task_info(mach_task_self(),TASK_VM_INFO_PURGEABLE,(task_info_t)&vm,&count);
    NSDictionary *queried=vmCode==KERN_SUCCESS&&count>=TASK_VM_INFO_REV0_COUNT?@{@"purgeable_volatile_pmap":@(vm.purgeable_volatile_pmap).stringValue,@"purgeable_volatile_resident":@(vm.purgeable_volatile_resident).stringValue,@"purgeable_volatile_virtual":@(vm.purgeable_volatile_virtual).stringValue}:(id)NSNull.null;
    [phases addObject:@{@"phase":phase,@"returnCode":@(code),@"values":code==KERN_SUCCESS?purgeableQueueValues(v):(id)NSNull.null,@"ledger":appleLedgerSources(),@"ownedVMObjects":ownedVMObjectSources(),@"vmPurgeable":queried,@"vmPurgeableReturnCode":@(vmCode),@"vmPurgeableReturnedNaturalWords":@(count),@"receivedAtMs":@(NSDate.date.timeIntervalSince1970*1000.)}];
  };
  struct Mapping {vm_address_t address=0;vm_size_t size=0;~Mapping(){if(address)vm_deallocate(mach_task_self(),address,size);}} m;m.size=16*vm_page_size;
  snapshot(@"before");const auto allocated=vm_allocate(mach_task_self(),&m.address,m.size,VM_FLAGS_ANYWHERE|VM_FLAGS_PURGABLE);
  NSMutableDictionary *result=[@{@"scope":@"one owned purgeable object, FIFO group 7",@"allocationReturnCode":@(allocated),@"bytes":@(m.size).stringValue,@"phases":phases} mutableCopy];
  if(allocated!=KERN_SUCCESS)return result;
  memset((void *)m.address,0x5a,m.size);snapshot(@"resident_nonvolatile");
  const int requested=VM_PURGABLE_VOLATILE|VM_PURGABLE_BEHAVIOR_FIFO|VM_VOLATILE_GROUP_7;int state=requested;const auto code=vm_purgable_control(mach_task_self(),m.address,VM_PURGABLE_SET_STATE,&state);
  result[@"requestedState"]=@(requested);result[@"stateReturnCode"]=@(code);result[@"previousState"]=code==KERN_SUCCESS?@(state):(id)NSNull.null;snapshot(@"after_volatile");
  const auto released=vm_deallocate(mach_task_self(),m.address,m.size);result[@"deallocateReturnCode"]=@(released);if(released==KERN_SUCCESS)m.address=0;snapshot(@"after_release");return result;
}
