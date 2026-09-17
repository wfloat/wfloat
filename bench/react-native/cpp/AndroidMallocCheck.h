#pragma once
#include <array>
#include <cstdint>
#include <cstdlib>
#include <stdexcept>
#include <sys/mman.h>

namespace bench {
struct NativeMallocAllocator {
  static void *allocate(size_t size) { return malloc(size); }
  static void deallocate(void *p) { free(p); }
  static void *map(size_t size) { return mmap(nullptr,size,PROT_READ|PROT_WRITE,MAP_PRIVATE|MAP_ANONYMOUS,-1,0); }
  static void unmap(void *p,size_t size) { munmap(p,size); }
};
// Owned only by the memory worker. The lifecycle guard may be read from any
// allocation/touch boundary; destruction always releases partial allocations.
template<class Allocator = NativeMallocAllocator>
class AndroidMallocStorage {
  static constexpr size_t MiB = 1024*1024;
  std::array<void *,4096> small{};
  std::array<void *,16> large{};
  void *mapping = MAP_FAILED;
public:
  AndroidMallocStorage() = default;
  AndroidMallocStorage(const AndroidMallocStorage&) = delete;
  ~AndroidMallocStorage() { release(); }
  void release() noexcept {
    for(auto &p:small) { if(p) Allocator::deallocate(p); p=nullptr; }
    for(auto &p:large) { if(p) Allocator::deallocate(p); p=nullptr; }
    if(mapping!=MAP_FAILED) { Allocator::unmap(mapping,16*MiB);mapping=MAP_FAILED; }
  }
  uint64_t heldBytes() const {
    uint64_t bytes=mapping==MAP_FAILED ? 0 : 16*MiB;
    for(auto p:small) if(p) bytes+=4096;
    for(auto p:large) if(p) bytes+=MiB;
    return bytes;
  }
  template<class IsActive> void step(int operation,IsActive active) {
    auto check=[&] { if(!active()) throw std::runtime_error("Native allocation check interrupted or timed out"); };
    auto touch=[&](void *p,size_t size) {
      for(size_t offset=0;offset<size;offset+=4096) {
        check();static_cast<volatile unsigned char *>(p)[offset]=0x5a;
      }
      static_cast<volatile unsigned char *>(p)[size-1]=0x5a;
    };
    check();
    if(operation==0) { release();return; }
    if(operation==2) { for(size_t i=0;i<small.size()/2;++i) { if(small[i]) Allocator::deallocate(small[i]);small[i]=nullptr; } return; }
    if(heldBytes()!=0) throw std::runtime_error("Native allocation check already holds memory");
    if(operation==1 || operation==3) {
      auto blocks=operation==1 ? small.data() : large.data();
      const size_t count=operation==1 ? small.size() : large.size();
      const size_t size=operation==1 ? 4096 : MiB;
      for(size_t i=0;i<count;++i) {
        check();blocks[i]=Allocator::allocate(size);
        if(!blocks[i]) throw std::runtime_error("Native allocation check malloc failed");
        touch(blocks[i],size);
      }
    } else if(operation==4) {
      mapping=Allocator::map(16*MiB);
      if(mapping==MAP_FAILED) throw std::runtime_error("Native allocation check mmap failed");
      touch(mapping,16*MiB);
    } else throw std::runtime_error("Unknown native allocation check operation");
  }
};
}
