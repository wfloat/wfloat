#pragma once
#import <Foundation/Foundation.h>
#include <dlfcn.h>
#include <unistd.h>
#include <cstdint>
#include <cerrno>
#include <cstring>
#include <vector>

// XNU osfmk/kern/ledger.h private userspace ABI. Never issue LEDGER_LIMIT (3).
inline NSDictionary *appleLedgerSources() {
  using Query=int(*)(int,uintptr_t,uintptr_t,uintptr_t);
  static auto query=(Query)dlsym(RTLD_DEFAULT,"ledger");
  if(!query)return @{@"error":@"ledger symbol unavailable"};
  struct Info {char name[32];int64_t id,entries;};
  struct Template {char name[32],group[32],units[32];};
  struct Entry {int64_t balance,credit,debit;uint64_t limit,refillPeriod,lastRefill;};
  struct EntryV2 {Entry base;int64_t lifetimeMax;uint64_t reserved[4];};
  static_assert(sizeof(Info)==48&&sizeof(Template)==96&&sizeof(Entry)==48&&sizeof(EntryV2)==88,"XNU ledger ABI");
  const auto str=[](const char *v){return [[NSString alloc] initWithBytes:v length:strnlen(v,32) encoding:NSUTF8StringEncoding]?: (id)NSNull.null;};
  const auto invoke=[&](int command,uintptr_t a,uintptr_t b,uintptr_t c,int &code){
    const double start=NSProcessInfo.processInfo.systemUptime*1000.;errno=0;code=query(command,a,b,c);const int error=code<0?errno:0;
    return @{@"command":@(command),@"returnCode":@(code),@"errno":@(error),@"startedUptimeMs":@(start),@"finishedUptimeMs":@(NSProcessInfo.processInfo.systemUptime*1000.)};
  };
  Info info{};int infoCode=0;NSDictionary *infoCall=invoke(0,(uintptr_t)getpid(),(uintptr_t)&info,0,infoCode);
  constexpr int capacity=512;std::vector<Template> labels(capacity);int labelCount=capacity,labelCode=0;
  NSDictionary *labelCall=invoke(2,(uintptr_t)labels.data(),(uintptr_t)&labelCount,0,labelCode);
  std::vector<EntryV2> v2(capacity);std::vector<Entry> v1;int entryCount=capacity,entryCode=0,version=2;
  NSMutableArray *entryCalls=[NSMutableArray arrayWithObject:invoke(4,(uintptr_t)getpid(),(uintptr_t)v2.data(),(uintptr_t)&entryCount,entryCode)];
  const int firstError=[entryCalls[0][@"errno"] intValue];
  if(entryCode<0&&(firstError==EINVAL||firstError==ENOSYS)){version=1;entryCount=capacity;v1.resize(capacity);[entryCalls addObject:invoke(1,(uintptr_t)getpid(),(uintptr_t)v1.data(),(uintptr_t)&entryCount,entryCode)];}
  const bool labelsValid=labelCode==0&&labelCount>=0&&labelCount<=capacity,entriesValid=entryCode==0&&entryCount>=0&&entryCount<=capacity;
  NSMutableArray *templates=[NSMutableArray new],*entries=[NSMutableArray new];
  if(labelsValid)for(int i=0;i<labelCount;++i)[templates addObject:@{@"index":@(i),@"name":str(labels[i].name),@"group":str(labels[i].group),@"units":str(labels[i].units)}];
  if(entriesValid)for(int i=0;i<entryCount;++i){const Entry &e=version==2?v2[i].base:v1[i];NSMutableDictionary *v=[@{@"index":@(i),@"lei_balance":@(e.balance).stringValue,@"lei_credit":@(e.credit).stringValue,@"lei_debit":@(e.debit).stringValue,@"lei_limit":@(e.limit).stringValue,@"lei_refill_period":@(e.refillPeriod).stringValue,@"lei_last_refill":@(e.lastRefill).stringValue} mutableCopy];if(version==2)v[@"lei_lifetime_max"]=@(v2[i].lifetimeMax).stringValue;[entries addObject:v];}
  return @{@"infoCall":infoCall,@"info":infoCode==0?@{@"name":str(info.name),@"id":@(info.id).stringValue,@"entries":@(info.entries).stringValue}:(id)NSNull.null,@"templateCall":labelCall,@"templates":templates,@"templateCount":@(labelCount),@"templateCountValid":@(labelsValid),@"entryCalls":entryCalls,@"entryVersion":@(version),@"entries":entries,@"entryCount":@(entryCount),@"entryCountValid":@(entriesValid),@"capacity":@(capacity),@"possiblyTruncated":@((labelsValid&&labelCount==capacity)||(entriesValid&&entryCount==capacity)),@"semantics":@"Own task ledger entries indexed against the OS template: native names/groups/units, credits/debits/balances/limits. No sum across ledgers or conversion to physical memory. Query settles dirty-time accounting; no limit changes or counter resets. Credits/debits are not necessarily cumulative: compact ledgers return balance as credit and zero debit. Refill fields are native nanoseconds; compact entries return uptime for lei_last_refill, not useful refill age. V2 lifetime maximum -1 means unsupported."};
}
