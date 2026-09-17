#pragma once
#import <Foundation/Foundation.h>
#import <Metal/Metal.h>
#include <stdexcept>
#include <cstdint>
namespace bench {
// ARC owns the device and buffer. No command queue or GPU workload is submitted.
class AppleMetalProbe {
  id<MTLDevice> device_ = nil;
  id<MTLBuffer> buffer_ = nil;
public:
  static constexpr uint64_t size = 16 * 1024 * 1024;
  AppleMetalProbe() = default;
  AppleMetalProbe(const AppleMetalProbe&) = delete;
  AppleMetalProbe& operator=(const AppleMetalProbe&) = delete;
  void prepare() {
    if (!device_) device_ = MTLCreateSystemDefaultDevice();
    if (!device_) throw std::runtime_error("No Metal device available");
  }
  void create() {
    release(); prepare();
    buffer_ = [device_ newBufferWithLength:size options:MTLResourceStorageModeShared];
    if (!buffer_) throw std::runtime_error("Metal buffer allocation failed");
    if (buffer_.length != size || buffer_.storageMode != MTLStorageModeShared) {
      release(); throw std::runtime_error("Unexpected Metal buffer length or storage mode");
    }
  }
  void write() {
    if (!buffer_) throw std::runtime_error("No Metal buffer held");
    auto data = static_cast<volatile unsigned char*>(buffer_.contents);
    if (!data) throw std::runtime_error("Metal buffer has no CPU-visible contents");
    for (uint64_t i = 0; i < size; ++i) data[i] = static_cast<unsigned char>(i);
  }
  void release() noexcept { buffer_ = nil; }
  uint64_t heldBytes() const { return buffer_ ? buffer_.length : 0; }
  uint64_t allocatedBytes() const { return device_.currentAllocatedSize; }
  uint64_t recommendedWorkingSetBytes() const API_AVAILABLE(ios(16.0)) { return device_.recommendedMaxWorkingSetSize; }
  NSString* deviceName() const { return device_.name ?: @"unavailable"; }
};
}
