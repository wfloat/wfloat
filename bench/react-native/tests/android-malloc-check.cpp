#include "../cpp/AndroidMallocCheck.h"
#include <cassert>
#include <iostream>
struct TrackedAllocator : bench::NativeMallocAllocator {
  inline static int blocks=0, mappings=0, failAfter=-1;
  inline static bool failMapping=false;
  static void *allocate(size_t size) {
    if(failAfter==0) return nullptr;
    if(failAfter>0) --failAfter;
    auto p=malloc(size);if(p) ++blocks;return p;
  }
  static void deallocate(void *p) { assert(blocks>0);--blocks;free(p); }
  static void *map(size_t size) { if(failMapping) return MAP_FAILED;auto p=bench::NativeMallocAllocator::map(size);if(p!=MAP_FAILED) ++mappings;return p; }
  static void unmap(void *p,size_t size) { assert(mappings==1);--mappings;bench::NativeMallocAllocator::unmap(p,size); }
};
using Storage=bench::AndroidMallocStorage<TrackedAllocator>;
void clean() { assert(TrackedAllocator::blocks==0 && TrackedAllocator::mappings==0); }
int main() {
  auto yes=[]{return true;};
  {
    Storage s;
    s.step(1,yes);assert(s.heldBytes()==16777216);assert(TrackedAllocator::blocks==4096);
    s.step(0,yes);clean();s.step(1,yes);s.step(2,yes);assert(s.heldBytes()==8388608);
    s.step(0,yes);clean();s.step(3,yes);assert(s.heldBytes()==16777216 && TrackedAllocator::blocks==16);
    s.step(0,yes);clean();s.step(4,yes);assert(s.heldBytes()==16777216 && TrackedAllocator::mappings==1);
  } clean();
  int interruptions=0;
  for(int operation : {1,3,4}) for(int cutoff : {1,2,3,10,100,1000,4000}) {
    int calls=0;bool failed=false;
    try { Storage s;s.step(operation,[&]{return ++calls<cutoff;}); }
    catch(const std::runtime_error&) { failed=true;++interruptions; }
    assert(failed);clean();
  }
  for(int limit : {0,1,8}) {
    TrackedAllocator::failAfter=limit;bool failed=false;
    try {Storage s;s.step(3,yes);}catch(const std::runtime_error&){failed=true;}
    assert(failed);clean();
  }
  TrackedAllocator::failAfter=-1;
  TrackedAllocator::failMapping=true;
  {bool failed=false;try{Storage s;s.step(4,yes);}catch(const std::runtime_error&){failed=true;}assert(failed);clean();}
  TrackedAllocator::failMapping=false;
  {Storage s;s.step(1,yes);bool failed=false;try{s.step(3,yes);}catch(const std::runtime_error&){failed=true;}assert(failed);assert(s.heldBytes()==16777216);}
  clean();std::cout << "PASS: all phases, " << interruptions << " interruption points, three allocation failures, mapping failure and double-allocation rejection; no leaked blocks/mappings\n";
}
