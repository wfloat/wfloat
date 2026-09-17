#pragma once
#import <Foundation/Foundation.h>
#import <IOSurface/IOSurfaceRef.h>
#include <stdexcept>
#include <cstdint>
#include <string>
namespace bench {
// Public IOSurface allocation only: no private ledger tagging or global pressure.
class AppleGraphicsProbe {
  IOSurfaceRef surface_ = nullptr;
public:
  AppleGraphicsProbe() = default;
  AppleGraphicsProbe(const AppleGraphicsProbe&) = delete;
  AppleGraphicsProbe& operator=(const AppleGraphicsProbe&) = delete;
  ~AppleGraphicsProbe() { release(); }
  uint64_t heldBytes() const { return surface_ ? IOSurfaceGetAllocSize(surface_) : 0; }
  void create() {
    release();
    NSDictionary *properties = @{(__bridge id)kIOSurfaceWidth:@2048, (__bridge id)kIOSurfaceHeight:@2048,
      (__bridge id)kIOSurfaceBytesPerElement:@4, (__bridge id)kIOSurfaceBytesPerRow:@8192,
      (__bridge id)kIOSurfacePixelFormat:@(0x42475241)};
    surface_ = IOSurfaceCreate((__bridge CFDictionaryRef)properties);
    if (!surface_) throw std::runtime_error("IOSurfaceCreate returned no surface");
    if (heldBytes() < 16 * 1024 * 1024 || heldBytes() > 17 * 1024 * 1024) {
      release(); throw std::runtime_error("IOSurface allocation outside diagnostic size bound");
    }
  }
  void write() {
    if (!surface_) throw std::runtime_error("No graphics surface held");
    auto status = IOSurfaceLock(surface_, (IOSurfaceLockOptions)0, nullptr);
    if (status != KERN_SUCCESS) throw std::runtime_error("IOSurfaceLock failed: " + std::to_string(status));
    auto data = static_cast<volatile unsigned char*>(IOSurfaceGetBaseAddress(surface_));
    if (!data) {
      IOSurfaceUnlock(surface_, (IOSurfaceLockOptions)0, nullptr);
      throw std::runtime_error("IOSurface returned no writable address");
    }
    const auto size = heldBytes();
    for (size_t i = 0; i < size; ++i) data[i] = static_cast<unsigned char>(i);
    status = IOSurfaceUnlock(surface_, (IOSurfaceLockOptions)0, nullptr);
    if (status != KERN_SUCCESS) throw std::runtime_error("IOSurfaceUnlock failed: " + std::to_string(status));
  }
  void release() noexcept { if (surface_) { CFRelease(surface_); surface_ = nullptr; } }
};
}
