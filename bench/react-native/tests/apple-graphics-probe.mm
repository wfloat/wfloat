#include "../cpp/AppleGraphicsProbe.h"
#include "../cpp/ResidentMemory.h"
#include <cassert>
#include <iostream>
int main() {
  std::cout << std::unitbuf; alarm(30);
  @autoreleasepool {
    bench::AppleGraphicsProbe probe;
    assert(probe.heldBytes()==0);
    bool refused=false; try { probe.write(); } catch(const std::exception&) {refused=true;}
    assert(refused);
    const auto baseline=bench::readResidentMemory().graphicsFootprint;
    probe.create(); assert(probe.heldBytes()==16777216); probe.write();
    const auto held=bench::readResidentMemory().graphicsFootprint;
    probe.create(); assert(probe.heldBytes()==16777216); probe.write();
    probe.release(); probe.release(); assert(probe.heldBytes()==0);
    const auto released=bench::readResidentMemory().graphicsFootprint;
    std::cout << "PASS: bounded surface create/write/replace/release, empty write refused\n";
    std::cout << "OS graphics footprint baseline=" << *baseline.rawBytes << " held=" << *held.rawBytes
      << " released=" << *released.rawBytes << " (response not asserted)\n";
  }
}
