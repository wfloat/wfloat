#import "../../ios/WfloatBench/PurgeableQueueProbe.h"
#include <cstdio>
int main() {@autoreleasepool {
  NSDictionary *result=ownedPurgeableQueueProbe();
  NSData *data=[NSJSONSerialization dataWithJSONObject:result options:NSJSONWritingPrettyPrinted error:nil];
  fwrite(data.bytes,1,data.length,stdout);puts("");
  if([result[@"allocationReturnCode"] intValue] || [result[@"stateReturnCode"] intValue] || [result[@"deallocateReturnCode"] intValue])return 1;
  NSArray *phases=result[@"phases"];
  for(NSDictionary *phase in phases)if([phase[@"vmPurgeableReturnCode"] intValue])return 2;
  const auto bytes=strtoull([result[@"bytes"] UTF8String],nullptr,10);
  const auto read=[&](NSUInteger i,NSString *key){return strtoull([phases[i][@"vmPurgeable"][key] UTF8String],nullptr,10);};
  for(NSString *key in @[@"purgeable_volatile_resident",@"purgeable_volatile_virtual"])
    if(read(2,key)<read(1,key)+bytes || read(3,key)+bytes>read(2,key))return 3;
  uint64_t ledgerBalance[4]{};
  for(NSUInteger i=0;i<4;++i){NSDictionary *ledger=phases[i][@"ledger"];
    if(![ledger[@"entryCountValid"] boolValue]||![ledger[@"templateCountValid"] boolValue])return 4;
    bool found=false;for(NSDictionary *label in ledger[@"templates"]){if([label[@"name"] isEqual:@"purgeable_volatile"]){
      const auto index=[label[@"index"] unsignedIntegerValue];if(index>=[ledger[@"entries"] count]||![label[@"units"] isEqual:@"bytes"])return 5;
      ledgerBalance[i]=strtoull([ledger[@"entries"][index][@"lei_balance"] UTF8String],nullptr,10);found=true;break;
    }}if(!found)return 6;
  }
  if(ledgerBalance[2]<ledgerBalance[1]+bytes||ledgerBalance[3]+bytes>ledgerBalance[2])return 7;
  // Match the newly owned object by identity across allocation/state/release.
  // This test host supports the private query; the app records EPERM on iOS.
  for(NSDictionary *phase in phases)if(![phase[@"ownedVMObjects"][@"layoutValid"] boolValue])return 8;
  NSMutableSet *before=[NSMutableSet new],*after=[NSMutableSet new];
  for(NSDictionary *o in phases[0][@"ownedVMObjects"][@"objects"])[before addObject:o[@"object_id"]];
  for(NSDictionary *o in phases[3][@"ownedVMObjects"][@"objects"])[after addObject:o[@"object_id"]];
  NSString *identity=nil;
  for(NSDictionary *o in phases[1][@"ownedVMObjects"][@"objects"])
    if(![before containsObject:o[@"object_id"]] && strtoull([o[@"resident_size"] UTF8String],nullptr,10)==bytes && [o[@"purgable"] intValue]==0)identity=o[@"object_id"];
  if(!identity || [after containsObject:identity])return 9;
  bool volatileMatch=false;
  for(NSDictionary *o in phases[2][@"ownedVMObjects"][@"objects"])
    if([o[@"object_id"] isEqual:identity] && [o[@"purgable"] intValue]==1)volatileMatch=true;
  if(!volatileMatch)return 10;
  return 0;
}}
