#include "../cpp/AppleMetalProbe.h"
#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>
int main() {
 std::cout << std::unitbuf; alarm(30);
 @autoreleasepool {
  bench::AppleMetalProbe probe; assert(probe.heldBytes()==0);
  bool refused=false;try{probe.write();}catch(const std::exception&){refused=true;}assert(refused);
  try {probe.prepare();}catch(const std::exception&e){std::cout<<e.what()<<"\n";return 77;}
  const auto sample=[&](const char*stage){const auto r=bench::readResidentMemory();std::cout<<stage<<" held="<<probe.heldBytes()<<" metalAllocated="<<probe.allocatedBytes()<<" graphics="<<*r.graphicsFootprint.rawBytes<<"\n";};
  std::cout<<"device="<<probe.deviceName().UTF8String<<"\n";
  sample("baseline");probe.create();assert(probe.heldBytes()==16777216);sample("created");
  probe.write();sample("written");probe.release();assert(probe.heldBytes()==0);sample("released");
  probe.create();probe.write();probe.create();assert(probe.heldBytes()==16777216);probe.release();probe.release();assert(probe.heldBytes()==0);
  std::cout<<"PASS: bounded shared buffer, write, replacement and idempotent release; ledger response not asserted\n";
 }
}
