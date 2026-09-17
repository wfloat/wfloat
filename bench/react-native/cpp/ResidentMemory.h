#pragma once

#include <cerrno>
#include <array>
#include <cstdint>
#include <fstream>
#include <fcntl.h>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <system_error>
#include <sys/mman.h>
#include <sys/resource.h>
#include <unistd.h>
#include <vector>
#ifdef __ANDROID__
#include <dlfcn.h>
#endif
#ifdef __APPLE__
#include <mach/mach.h>
#endif

namespace bench {

struct MemoryCounter {
  std::optional<uint64_t> bytes;
  std::string source;
  std::string error;
};

struct DecompressionCounter {
  std::optional<uint32_t> count;
  std::optional<int32_t> rawCount;
  std::string source;
  std::string error;
  bool saturated = false;
};

struct PeakFootprintCounter {
  std::optional<uint64_t> bytes;
  std::optional<int64_t> rawBytes;
  std::string source;
  std::string error;
};

struct SignedMemoryCounter {
  std::optional<uint64_t> bytes;
  std::optional<int64_t> rawBytes;
  std::string source;
  std::string error;
};

struct MemoryRegionCounter {
  std::optional<uint32_t> count;
  std::optional<int32_t> rawCount;
  std::string source;
  std::string error;
};

struct ResidentMemory {
  uint64_t bytes;
  std::string source;
  MemoryCounter pss;
  MemoryCounter physicalFootprint;
  MemoryCounter peakRss;
  MemoryCounter privateDirty;
  MemoryCounter privateClean;
  MemoryCounter sharedClean;
  MemoryCounter sharedDirty;
  MemoryCounter compressed;
  DecompressionCounter decompressions;
  MemoryCounter swapPss;
  MemoryCounter anonymous;
  MemoryCounter pageTables;
  MemoryCounter virtualSize;
  MemoryCounter locked;
  MemoryCounter peakVirtual;
  PeakFootprintCounter peakPhysicalFootprint;
  MemoryRegionCounter regions;
  MemoryRegionCounter vmas;
  MemoryCounter anonymousPss;
  MemoryCounter filePss;
  MemoryCounter shmemPss;
  MemoryCounter dirtyPss;
  MemoryCounter referenced;
  MemoryCounter swap;
  MemoryCounter lazyFree;
  MemoryCounter anonHugePages;
  MemoryCounter filePmdMapped;
  MemoryCounter shmemPmdMapped;
  MemoryCounter privateHugetlb;
  MemoryCounter sharedHugetlb;
  MemoryCounter ksm;
  MemoryCounter lockedResident;
  MemoryCounter reusable;
  MemoryCounter internal;
  MemoryCounter external;
  MemoryCounter peakCompressed;
  MemoryCounter peakReusable;
  MemoryCounter peakInternal;
  MemoryCounter peakExternal;
  MemoryCounter cumulativeCompressed;
  SignedMemoryCounter purgeableNonvolatile;
  SignedMemoryCounter purgeableVolatile;
  SignedMemoryCounter purgeableNonvolatileCompressed;
  SignedMemoryCounter purgeableVolatileCompressed;
  SignedMemoryCounter graphicsFootprint;
};

#ifdef __APPLE__
// XNU returns the number of entries in the task's top-level VM map.
inline MemoryRegionCounter regionsFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  MemoryRegionCounter counter{std::nullopt, std::nullopt, "task_info(TASK_VM_INFO).region_count", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV0_COUNT)
    counter.error = "TASK_VM_INFO response does not include memory-region count";
  else {
    counter.rawCount = info.region_count;
    if (*counter.rawCount < 0) counter.error = "Negative Mach memory-region count";
    else counter.count = static_cast<uint32_t>(*counter.rawCount);
  }
  return counter;
}

// XNU exports the lifetime maximum of its physical-footprint ledger in rev3.
inline PeakFootprintCounter peakFootprintFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  PeakFootprintCounter counter{std::nullopt, std::nullopt,
    "task_info(TASK_VM_INFO).ledger_phys_footprint_peak", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV3_COUNT)
    counter.error = "TASK_VM_INFO response does not include peak physical footprint";
  else {
    counter.rawBytes = info.ledger_phys_footprint_peak;
    if (*counter.rawBytes < 0) counter.error = "Negative Mach peak physical footprint";
    else counter.bytes = static_cast<uint64_t>(*counter.rawBytes);
  }
  return counter;
}

// TASK_VM_INFO.compressed is the internal_compressed ledger, measured in
// original page bytes. It is not the compressor's physical storage size.
inline MemoryCounter compressedFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  MemoryCounter counter{std::nullopt, "task_info(TASK_VM_INFO).compressed", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV0_COUNT)
    counter.error = "TASK_VM_INFO response does not include compressed memory";
  else counter.bytes = info.compressed;
  return counter;
}

// TASK_VM_INFO.compressed_peak is the lifetime maximum of internal_compressed, measured in
// original page bytes. It is not the compressor's physical storage size.
inline MemoryCounter peakCompressedFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  MemoryCounter counter{std::nullopt, "task_info(TASK_VM_INFO).compressed_peak", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV0_COUNT)
    counter.error = "TASK_VM_INFO response does not include peak compressed memory";
  else counter.bytes = info.compressed_peak;
  return counter;
}

// Cumulative credits to internal_compressed in original page bytes, not a peak.
inline MemoryCounter cumulativeCompressedFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  MemoryCounter counter{std::nullopt, "task_info(TASK_VM_INFO).compressed_lifetime", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV0_COUNT)
    counter.error = "TASK_VM_INFO response does not include cumulative compressed memory";
  else counter.bytes = info.compressed_lifetime;
  return counter;
}

// TASK_VM_INFO.reusable_peak is the lifetime maximum of reusable ledger, measured in
// reusable page bytes. It is not current free memory.
inline MemoryCounter peakReusableFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  MemoryCounter counter{std::nullopt, "task_info(TASK_VM_INFO).reusable_peak", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV0_COUNT)
    counter.error = "TASK_VM_INFO response does not include peak reusable memory";
  else counter.bytes = info.reusable_peak;
  return counter;
}

// Lifetime maximum of the internal ledger, excluding separately accounted compressed/reusable pages.
inline MemoryCounter peakInternalFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  MemoryCounter counter{std::nullopt, "task_info(TASK_VM_INFO).internal_peak", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV0_COUNT)
    counter.error = "TASK_VM_INFO response does not include peak internal memory";
  else counter.bytes = info.internal_peak;
  return counter;
}

// Lifetime maximum of the external ledger, including resident file-backed mappings; not disk usage.
inline MemoryCounter peakExternalFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  MemoryCounter counter{std::nullopt, "task_info(TASK_VM_INFO).external_peak", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV0_COUNT)
    counter.error = "TASK_VM_INFO response does not include peak external memory";
  else counter.bytes = info.external_peak;
  return counter;
}

// The graphics-tagged uncompressed footprint ledger. Compressed and
// no-footprint graphics charges are separate; this is not total GPU memory.
inline SignedMemoryCounter graphicsFootprintFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  SignedMemoryCounter counter{std::nullopt, std::nullopt,
    "task_info(TASK_VM_INFO).ledger_tag_graphics_footprint", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV3_COUNT)
    counter.error = "TASK_VM_INFO response does not include graphics footprint memory";
  else {
    counter.rawBytes = info.ledger_tag_graphics_footprint;
    if (*counter.rawBytes < 0) counter.error = "Negative Mach graphics footprint memory";
    else counter.bytes = static_cast<uint64_t>(*counter.rawBytes);
  }
  return counter;
}

// Resident bytes charged to the task's nonvolatile purgeable ledger. Compressed
// bytes have a separate ledger; wired purgeable pages remain nonvolatile.
inline SignedMemoryCounter purgeableNonvolatileFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  SignedMemoryCounter counter{std::nullopt, std::nullopt,
    "task_info(TASK_VM_INFO).ledger_purgeable_nonvolatile", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV3_COUNT)
    counter.error = "TASK_VM_INFO response does not include nonvolatile purgeable memory";
  else {
    counter.rawBytes = info.ledger_purgeable_nonvolatile;
    if (*counter.rawBytes < 0) counter.error = "Negative Mach nonvolatile purgeable memory";
    else counter.bytes = static_cast<uint64_t>(*counter.rawBytes);
  }
  return counter;
}

// Compressed nonvolatile purgeable ledger, in original page bytes rather than
// compressor storage bytes. The public field intentionally spells "novolatile".
inline SignedMemoryCounter purgeableNonvolatileCompressedFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  SignedMemoryCounter counter{std::nullopt, std::nullopt,
    "task_info(TASK_VM_INFO).ledger_purgeable_novolatile_compressed", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV3_COUNT)
    counter.error = "TASK_VM_INFO response does not include compressed nonvolatile purgeable memory";
  else {
    counter.rawBytes = info.ledger_purgeable_novolatile_compressed;
    if (*counter.rawBytes < 0) counter.error = "Negative Mach compressed nonvolatile purgeable memory";
    else counter.bytes = static_cast<uint64_t>(*counter.rawBytes);
  }
  return counter;
}

// Compressed volatile purgeable ledger, in original page bytes. Discard may
// remove this charge at any time; it does not measure compressor storage size.
inline SignedMemoryCounter purgeableVolatileCompressedFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  SignedMemoryCounter counter{std::nullopt, std::nullopt,
    "task_info(TASK_VM_INFO).ledger_purgeable_volatile_compressed", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV3_COUNT)
    counter.error = "TASK_VM_INFO response does not include compressed volatile purgeable memory";
  else {
    counter.rawBytes = info.ledger_purgeable_volatile_compressed;
    if (*counter.rawBytes < 0) counter.error = "Negative Mach compressed volatile purgeable memory";
    else counter.bytes = static_cast<uint64_t>(*counter.rawBytes);
  }
  return counter;
}

// Resident bytes charged to the owning task's ordinary volatile purgeable ledger.
// Excludes compressed bytes and wired pages. Contents may be discarded at any time.
inline SignedMemoryCounter purgeableVolatileFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  SignedMemoryCounter counter{std::nullopt, std::nullopt,
    "task_info(TASK_VM_INFO).ledger_purgeable_volatile", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV3_COUNT)
    counter.error = "TASK_VM_INFO response does not include volatile purgeable memory";
  else {
    counter.rawBytes = info.ledger_purgeable_volatile;
    if (*counter.rawBytes < 0) counter.error = "Negative Mach volatile purgeable memory";
    else counter.bytes = static_cast<uint64_t>(*counter.rawBytes);
  }
  return counter;
}

// Current reusable-page ledger, not a peak or free-memory estimate.
inline MemoryCounter reusableFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  MemoryCounter counter{std::nullopt, "task_info(TASK_VM_INFO).reusable", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV0_COUNT)
    counter.error = "TASK_VM_INFO response does not include reusable memory";
  else counter.bytes = info.reusable;
  return counter;
}

// Current internal ledger; compressed and reusable pages are accounted separately.
inline MemoryCounter internalFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  MemoryCounter counter{std::nullopt, "task_info(TASK_VM_INFO).internal", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV0_COUNT)
    counter.error = "TASK_VM_INFO response does not include internal memory";
  else counter.bytes = info.internal;
  return counter;
}

// Current external ledger, not file length or cumulative storage I/O.
inline MemoryCounter externalFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  MemoryCounter counter{std::nullopt, "task_info(TASK_VM_INFO).external", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV0_COUNT)
    counter.error = "TASK_VM_INFO response does not include external memory";
  else counter.bytes = info.external;
  return counter;
}

// XNU sums task/live-thread page decompressions and caps the export at INT32_MAX.
inline DecompressionCounter decompressionsFromTaskVmInfo(kern_return_t status,
    mach_msg_type_number_t count, const task_vm_info_data_t &info) {
  DecompressionCounter counter{std::nullopt, std::nullopt, "task_info(TASK_VM_INFO).decompressions", ""};
  if (status != KERN_SUCCESS)
    counter.error = "TASK_VM_INFO failed with Mach status " + std::to_string(status);
  else if (count < TASK_VM_INFO_REV5_COUNT)
    counter.error = "TASK_VM_INFO response does not include decompressions";
  else {
    counter.rawCount = info.decompressions;
    if (info.decompressions < 0) counter.error = "Negative Mach decompression counter";
    else {
      counter.count = static_cast<uint32_t>(info.decompressions);
      counter.saturated = info.decompressions == INT32_MAX;
    }
  }
  return counter;
}
#endif

// Android getrusage reports KiB; Darwin's Mach peak field already reports bytes.
// Check before multiplication so the bridge can preserve an exact JS integer.
inline uint64_t peakRssBytes(int64_t value, uint64_t scale) {
  constexpr uint64_t maxExact = 9007199254740991ULL;
  if (value < 0 || (scale != 1 && scale != 1024) || static_cast<uint64_t>(value) > maxExact / scale)
    throw std::runtime_error("Invalid or inexact peak RSS counter");
  return static_cast<uint64_t>(value) * scale;
}

inline void addSmapsKb(const std::string &value, uint64_t &totalKb) {
  std::istringstream fields(value);
  std::string digits, unit, extra;
  if (!(fields >> digits >> unit) || unit != "kB" || (fields >> extra) ||
      digits.find_first_not_of("0123456789") != std::string::npos)
    throw std::runtime_error("Malformed smaps counter");
  const auto kb = std::stoull(digits);
  if (kb > std::numeric_limits<uint64_t>::max() / 1024 - totalKb)
    throw std::runtime_error("Smaps counter overflow");
  totalKb += kb;
}

// Count complete VMA records without retaining addresses or file paths.
inline MemoryRegionCounter vmasFromMaps(std::istream &input) {
  MemoryRegionCounter result{std::nullopt, std::nullopt, "/proc/self/maps:count(VMA)", ""};
  try {
    uint32_t total = 0;
    uint64_t previousEnd = 0;
    std::string line;
    const auto hex = [](const std::string &value) -> uint64_t {
      if (value.empty() || value.find_first_not_of("0123456789abcdefABCDEF") != std::string::npos)
        throw std::runtime_error("Malformed memory-map hexadecimal field");
      return std::stoull(value, nullptr, 16);
    };
    while (std::getline(input, line)) {
      if (input.eof()) throw std::runtime_error("Incomplete memory-map record");
      std::istringstream fields(line);
      std::string range, permissions, offset, device, inode;
      if (!(fields >> range >> permissions >> offset >> device >> inode))
        throw std::runtime_error("Incomplete memory-map fields");
      const auto dash = range.find('-'), colon = device.find(':');
      if (dash == std::string::npos || colon == std::string::npos)
        throw std::runtime_error("Malformed memory-map range or device");
      const uint64_t start = hex(range.substr(0, dash)), end = hex(range.substr(dash + 1));
      if (start >= end || (total && start < previousEnd))
        throw std::runtime_error("Unordered or overlapping memory-map records");
      if (permissions.size() != 4 || (permissions[0] != 'r' && permissions[0] != '-') ||
          (permissions[1] != 'w' && permissions[1] != '-') || (permissions[2] != 'x' && permissions[2] != '-') ||
          (permissions[3] != 'p' && permissions[3] != 's'))
        throw std::runtime_error("Malformed memory-map permissions");
      hex(offset); hex(device.substr(0, colon)); hex(device.substr(colon + 1));
      if (inode.empty() || inode.find_first_not_of("0123456789") != std::string::npos)
        throw std::runtime_error("Malformed memory-map inode");
      std::stoull(inode);
      if (total == INT32_MAX) throw std::runtime_error("VMA count exceeds collector integer range");
      ++total; previousEnd = end;
    }
    if (input.bad() || (input.fail() && !input.eof())) throw std::runtime_error("Could not finish reading memory map");
    if (!total) throw std::runtime_error("Empty process memory map");
    result.count = total; result.rawCount = static_cast<int32_t>(total);
  } catch (const std::exception &error) { result.error = error.what(); }
  return result;
}

inline MemoryRegionCounter readVmas() {
  std::ifstream input("/proc/self/maps");
  if (!input.is_open()) return {std::nullopt, std::nullopt, "/proc/self/maps:count(VMA)", "Could not open process memory map"};
  return vmasFromMaps(input);
}

struct StatusMemory {
  MemoryCounter pageTables{std::nullopt, "/proc/self/status:VmPTE", "Missing VmPTE entry in status"};
  MemoryCounter virtualSize{std::nullopt, "/proc/self/status:VmSize", "Missing VmSize entry in status"};
  MemoryCounter locked{std::nullopt, "/proc/self/status:VmLck", "Missing VmLck entry in status"};
  MemoryCounter peakVirtual{std::nullopt, "/proc/self/status:VmPeak", "Missing VmPeak entry in status"};
};

// Share one status read, with independent field validation and failures.
inline StatusMemory memoryFromStatus(std::istream &input) {
  StatusMemory result;
  bool foundPte = false, foundSize = false, foundLocked = false, foundPeak = false;
  const auto parse = [](const std::string &text, const char *name, bool &found, MemoryCounter &counter) {
    try {
      if (found) throw std::runtime_error(std::string("Duplicate ") + name + " entry in status");
      found = true;
      std::istringstream fields(text);
      std::string digits, unit, extra;
      if (!(fields >> digits >> unit) || unit != "kB" || (fields >> extra) ||
          digits.find_first_not_of("0123456789") != std::string::npos)
        throw std::runtime_error(std::string("Malformed ") + name + " entry in status");
      const auto kb = std::stoull(digits);
      if (kb > std::numeric_limits<uint64_t>::max() / 1024)
        throw std::runtime_error(std::string(name) + " counter overflow");
      counter.bytes = kb * 1024;
      counter.error.clear();
    } catch (const std::exception &error) { counter.bytes.reset(); counter.error = error.what(); }
  };
  try {
    std::string line;
    while (std::getline(input, line)) {
      if (line.rfind("VmPTE:", 0) == 0) parse(line.substr(6), "VmPTE", foundPte, result.pageTables);
      else if (line.rfind("VmSize:", 0) == 0) parse(line.substr(7), "VmSize", foundSize, result.virtualSize);
      else if (line.rfind("VmLck:", 0) == 0) parse(line.substr(6), "VmLck", foundLocked, result.locked);
      else if (line.rfind("VmPeak:", 0) == 0) parse(line.substr(7), "VmPeak", foundPeak, result.peakVirtual);
    }
    if (input.bad() || (input.fail() && !input.eof()))
      throw std::runtime_error("Could not finish reading process memory status");
  } catch (const std::exception &error) {
    for (auto *counter : {&result.pageTables, &result.virtualSize, &result.locked, &result.peakVirtual}) {
      counter->bytes.reset(); counter->error = error.what();
    }
  }
  return result;
}

inline MemoryCounter pageTablesFromStatus(std::istream &input) {
  return memoryFromStatus(input).pageTables;
}

inline StatusMemory readStatusMemory() {
  std::ifstream status("/proc/self/status");
  if (!status.is_open()) {
    StatusMemory result;
    result.pageTables.error = result.virtualSize.error = result.locked.error = result.peakVirtual.error = "Could not open process memory status";
    return result;
  }
  return memoryFromStatus(status);
}

// RSS, PSS and clean/dirty counters share one page-table walk. Preserve independent
// failures. Resident categories and proportional swap retain separate totals.
inline ResidentMemory memoryFromSmaps(std::istream &input, bool rollup) {
  uint64_t rssKb = 0, pssKb = 0, privateDirtyKb = 0, privateCleanKb = 0, sharedCleanKb = 0, sharedDirtyKb = 0, swapPssKb = 0, anonymousKb = 0;
  uint64_t anonymousPssKb = 0;
  bool hasAnonymousPss = false;
  std::string anonymousPssError = rollup ? "" : "Pss_Anon requires smaps_rollup; no fallback estimate";
  uint64_t filePssKb = 0;
  bool hasFilePss = false;
  std::string filePssError = rollup ? "" : "Pss_File requires smaps_rollup; no fallback estimate";
  uint64_t shmemPssKb = 0;
  bool hasShmemPss = false;
  std::string shmemPssError = rollup ? "" : "Pss_Shmem requires smaps_rollup; no fallback estimate";
  uint64_t dirtyPssKb = 0;
  bool regionHasDirtyPss = false;
  std::string dirtyPssError;
  uint64_t anonHugePagesKb = 0;
  bool regionHasAnonHugePages = false;
  std::string anonHugePagesError;
  uint64_t filePmdMappedKb = 0;
  bool regionHasFilePmdMapped = false;
  std::string filePmdMappedError;
  uint64_t shmemPmdMappedKb = 0;
  bool regionHasShmemPmdMapped = false;
  std::string shmemPmdMappedError;
  uint64_t privateHugetlbKb = 0;
  bool regionHasPrivateHugetlb = false;
  std::string privateHugetlbError;
  uint64_t sharedHugetlbKb = 0;
  bool regionHasSharedHugetlb = false;
  std::string sharedHugetlbError;
  uint64_t lockedResidentKb = 0;
  bool regionHasLockedResident = false;
  std::string lockedResidentError;
  uint64_t ksmKb = 0;
  bool regionHasKsm = false;
  std::string ksmError;
  uint64_t lazyFreeKb = 0;
  bool regionHasLazyFree = false;
  std::string lazyFreeError;
  uint64_t swapKb = 0;
  bool regionHasSwap = false;
  std::string swapError;
  uint64_t referencedKb = 0;
  bool regionHasReferenced = false;
  std::string referencedError;
  unsigned rssEntries = 0;
  bool regionHasPss = false;
  std::string pssError;
  bool regionHasPrivateDirty = false;
  std::string privateDirtyError;
  bool regionHasPrivateClean = false;
  std::string privateCleanError;
  bool regionHasSharedClean = false;
  std::string sharedCleanError;
  bool regionHasSharedDirty = false;
  std::string sharedDirtyError;
  bool regionHasSwapPss = false;
  std::string swapPssError;
  bool regionHasAnonymous = false;
  std::string anonymousError;
  std::string line;
  while (std::getline(input, line)) {
    if (line.rfind("Rss:", 0) == 0) {
      if (rssEntries && !regionHasAnonHugePages) anonHugePagesError = "Missing AnonHugePages entry in smaps";
      regionHasAnonHugePages = false;
      if (rssEntries && !regionHasFilePmdMapped) filePmdMappedError = "Missing FilePmdMapped entry in smaps";
      regionHasFilePmdMapped = false;
      if (rssEntries && !regionHasShmemPmdMapped) shmemPmdMappedError = "Missing ShmemPmdMapped entry in smaps";
      regionHasShmemPmdMapped = false;
      if (rssEntries && !regionHasPrivateHugetlb) privateHugetlbError = "Missing Private_Hugetlb entry in smaps";
      regionHasPrivateHugetlb = false;
      if (rssEntries && !regionHasSharedHugetlb) sharedHugetlbError = "Missing Shared_Hugetlb entry in smaps";
      regionHasSharedHugetlb = false;
      if (rssEntries && !regionHasLockedResident) lockedResidentError = "Missing Locked entry in smaps";
      regionHasLockedResident = false;
      if (rssEntries && !regionHasKsm) ksmError = "Missing KSM entry in smaps";
      regionHasKsm = false;
      if (rssEntries && !regionHasLazyFree) lazyFreeError = "Missing LazyFree entry in smaps";
      regionHasLazyFree = false;
      if (rssEntries && !regionHasSwap) swapError = "Missing Swap entry in smaps";
      regionHasSwap = false;
      if (rssEntries && !regionHasReferenced) referencedError = "Missing Referenced entry in smaps";
      regionHasReferenced = false;
      if (rssEntries && !regionHasDirtyPss) dirtyPssError = "Missing Pss_Dirty entry in smaps";
      regionHasDirtyPss = false;
      if (rssEntries && !regionHasPss) pssError = "Missing PSS entry in smaps";
      if (rssEntries && !regionHasPrivateDirty) privateDirtyError = "Missing Private_Dirty entry in smaps";
      if (rssEntries && !regionHasPrivateClean) privateCleanError = "Missing Private_Clean entry in smaps";
      if (rssEntries && !regionHasSharedClean) sharedCleanError = "Missing Shared_Clean entry in smaps";
      if (rssEntries && !regionHasSharedDirty) sharedDirtyError = "Missing Shared_Dirty entry in smaps";
      if (rssEntries && !regionHasSwapPss) swapPssError = "Missing SwapPss entry in smaps";
      if (rssEntries && !regionHasAnonymous) anonymousError = "Missing Anonymous entry in smaps";
      regionHasAnonymous = false;
      regionHasSwapPss = false;
      regionHasPss = false;
      regionHasPrivateDirty = false;
      regionHasPrivateClean = false;
      regionHasSharedClean = false;
      regionHasSharedDirty = false;
      addSmapsKb(line.substr(4), rssKb);
      ++rssEntries;
    } else if (line.rfind("Pss:", 0) == 0) {
      if (!rssEntries || regionHasPss) pssError = "Unexpected or duplicate PSS entry in smaps";
      regionHasPss = true;
      try { addSmapsKb(line.substr(4), pssKb); }
      catch (const std::exception &error) { pssError = error.what(); }
    } else if (line.rfind("AnonHugePages:", 0) == 0) {
      if (!rssEntries || regionHasAnonHugePages) anonHugePagesError = "Unexpected or duplicate AnonHugePages entry in smaps";
      regionHasAnonHugePages = true;
      try { addSmapsKb(line.substr(14), anonHugePagesKb); }
      catch (const std::exception &error) { anonHugePagesError = error.what(); }
    } else if (line.rfind("FilePmdMapped:", 0) == 0) {
      if (!rssEntries || regionHasFilePmdMapped) filePmdMappedError = "Unexpected or duplicate FilePmdMapped entry in smaps";
      regionHasFilePmdMapped = true;
      try { addSmapsKb(line.substr(14), filePmdMappedKb); }
      catch (const std::exception &error) { filePmdMappedError = error.what(); }
    } else if (line.rfind("ShmemPmdMapped:", 0) == 0) {
      if (!rssEntries || regionHasShmemPmdMapped) shmemPmdMappedError = "Unexpected or duplicate ShmemPmdMapped entry in smaps";
      regionHasShmemPmdMapped = true;
      try { addSmapsKb(line.substr(15), shmemPmdMappedKb); }
      catch (const std::exception &error) { shmemPmdMappedError = error.what(); }
    } else if (line.rfind("Private_Hugetlb:", 0) == 0) {
      if (!rssEntries || regionHasPrivateHugetlb) privateHugetlbError = "Unexpected or duplicate Private_Hugetlb entry in smaps";
      regionHasPrivateHugetlb = true;
      try { addSmapsKb(line.substr(16), privateHugetlbKb); }
      catch (const std::exception &error) { privateHugetlbError = error.what(); }
    } else if (line.rfind("Shared_Hugetlb:", 0) == 0) {
      if (!rssEntries || regionHasSharedHugetlb) sharedHugetlbError = "Unexpected or duplicate Shared_Hugetlb entry in smaps";
      regionHasSharedHugetlb = true;
      try { addSmapsKb(line.substr(15), sharedHugetlbKb); }
      catch (const std::exception &error) { sharedHugetlbError = error.what(); }
    } else if (line.rfind("Locked:", 0) == 0) {
      if (!rssEntries || regionHasLockedResident) lockedResidentError = "Unexpected or duplicate Locked entry in smaps";
      regionHasLockedResident = true;
      try { addSmapsKb(line.substr(7), lockedResidentKb); }
      catch (const std::exception &error) { lockedResidentError = error.what(); }
    } else if (line.rfind("KSM:", 0) == 0) {
      if (!rssEntries || regionHasKsm) ksmError = "Unexpected or duplicate KSM entry in smaps";
      regionHasKsm = true;
      try { addSmapsKb(line.substr(4), ksmKb); }
      catch (const std::exception &error) { ksmError = error.what(); }
    } else if (line.rfind("LazyFree:", 0) == 0) {
      if (!rssEntries || regionHasLazyFree) lazyFreeError = "Unexpected or duplicate LazyFree entry in smaps";
      regionHasLazyFree = true;
      try { addSmapsKb(line.substr(9), lazyFreeKb); }
      catch (const std::exception &error) { lazyFreeError = error.what(); }
    } else if (line.rfind("Swap:", 0) == 0) {
      if (!rssEntries || regionHasSwap) swapError = "Unexpected or duplicate Swap entry in smaps";
      regionHasSwap = true;
      try { addSmapsKb(line.substr(5), swapKb); }
      catch (const std::exception &error) { swapError = error.what(); }
    } else if (line.rfind("Referenced:", 0) == 0) {
      if (!rssEntries || regionHasReferenced) referencedError = "Unexpected or duplicate Referenced entry in smaps";
      regionHasReferenced = true;
      try { addSmapsKb(line.substr(11), referencedKb); }
      catch (const std::exception &error) { referencedError = error.what(); }
    } else if (line.rfind("Pss_Dirty:", 0) == 0) {
      if (!rssEntries || regionHasDirtyPss) dirtyPssError = "Unexpected or duplicate Pss_Dirty entry in smaps";
      regionHasDirtyPss = true;
      try { addSmapsKb(line.substr(10), dirtyPssKb); }
      catch (const std::exception &error) { dirtyPssError = error.what(); }
    } else if (line.rfind("Private_Dirty:", 0) == 0) {
      if (!rssEntries || regionHasPrivateDirty) privateDirtyError = "Unexpected or duplicate Private_Dirty entry in smaps";
      regionHasPrivateDirty = true;
      try { addSmapsKb(line.substr(14), privateDirtyKb); }
      catch (const std::exception &error) { privateDirtyError = error.what(); }
    } else if (line.rfind("Private_Clean:", 0) == 0) {
      if (!rssEntries || regionHasPrivateClean) privateCleanError = "Unexpected or duplicate Private_Clean entry in smaps";
      regionHasPrivateClean = true;
      try { addSmapsKb(line.substr(14), privateCleanKb); }
      catch (const std::exception &error) { privateCleanError = error.what(); }
    } else if (line.rfind("Shared_Clean:", 0) == 0) {
      if (!rssEntries || regionHasSharedClean) sharedCleanError = "Unexpected or duplicate Shared_Clean entry in smaps";
      regionHasSharedClean = true;
      try { addSmapsKb(line.substr(13), sharedCleanKb); }
      catch (const std::exception &error) { sharedCleanError = error.what(); }
    } else if (rollup && line.rfind("Pss_Shmem:", 0) == 0) {
      if (!rssEntries || hasShmemPss) shmemPssError = "Unexpected or duplicate Pss_Shmem entry in smaps_rollup";
      hasShmemPss = true;
      try { addSmapsKb(line.substr(10), shmemPssKb); }
      catch (const std::exception &error) { shmemPssError = error.what(); }
    } else if (rollup && line.rfind("Pss_File:", 0) == 0) {
      if (!rssEntries || hasFilePss) filePssError = "Unexpected or duplicate Pss_File entry in smaps_rollup";
      hasFilePss = true;
      try { addSmapsKb(line.substr(9), filePssKb); }
      catch (const std::exception &error) { filePssError = error.what(); }
    } else if (rollup && line.rfind("Pss_Anon:", 0) == 0) {
      if (!rssEntries || hasAnonymousPss) anonymousPssError = "Unexpected or duplicate Pss_Anon entry in smaps_rollup";
      hasAnonymousPss = true;
      try { addSmapsKb(line.substr(9), anonymousPssKb); }
      catch (const std::exception &error) { anonymousPssError = error.what(); }
    } else if (line.rfind("Anonymous:", 0) == 0) {
      if (!rssEntries || regionHasAnonymous) anonymousError = "Unexpected or duplicate Anonymous entry in smaps";
      regionHasAnonymous = true;
      try { addSmapsKb(line.substr(10), anonymousKb); }
      catch (const std::exception &error) { anonymousError = error.what(); }
    } else if (line.rfind("SwapPss:", 0) == 0) {
      if (!rssEntries || regionHasSwapPss) swapPssError = "Unexpected or duplicate SwapPss entry in smaps";
      regionHasSwapPss = true;
      try { addSmapsKb(line.substr(8), swapPssKb); }
      catch (const std::exception &error) { swapPssError = error.what(); }
    } else if (line.rfind("Shared_Dirty:", 0) == 0) {
      if (!rssEntries || regionHasSharedDirty) sharedDirtyError = "Unexpected or duplicate Shared_Dirty entry in smaps";
      regionHasSharedDirty = true;
      try { addSmapsKb(line.substr(13), sharedDirtyKb); }
      catch (const std::exception &error) { sharedDirtyError = error.what(); }
    }
  }
  if (input.bad() || !rssEntries || (rollup && rssEntries != 1))
    throw std::runtime_error("Incomplete RSS data in smaps");
  if (!regionHasAnonHugePages) anonHugePagesError = "Missing AnonHugePages entry in smaps";
  if (!regionHasFilePmdMapped) filePmdMappedError = "Missing FilePmdMapped entry in smaps";
  if (!regionHasShmemPmdMapped) shmemPmdMappedError = "Missing ShmemPmdMapped entry in smaps";
  if (!regionHasPrivateHugetlb) privateHugetlbError = "Missing Private_Hugetlb entry in smaps";
  if (!regionHasSharedHugetlb) sharedHugetlbError = "Missing Shared_Hugetlb entry in smaps";
  if (!regionHasLockedResident) lockedResidentError = "Missing Locked entry in smaps";
  if (!regionHasKsm) ksmError = "Missing KSM entry in smaps";
  if (!regionHasLazyFree) lazyFreeError = "Missing LazyFree entry in smaps";
  if (!regionHasSwap) swapError = "Missing Swap entry in smaps";
  if (!regionHasReferenced) referencedError = "Missing Referenced entry in smaps";
  if (!regionHasDirtyPss) dirtyPssError = "Missing Pss_Dirty entry in smaps";
  if (!regionHasPss) pssError = "Missing PSS entry in smaps";
  if (!regionHasPrivateDirty) privateDirtyError = "Missing Private_Dirty entry in smaps";
  if (!regionHasPrivateClean) privateCleanError = "Missing Private_Clean entry in smaps";
  if (!regionHasSharedClean) sharedCleanError = "Missing Shared_Clean entry in smaps";
  if (!regionHasSharedDirty) sharedDirtyError = "Missing Shared_Dirty entry in smaps";
  if (!regionHasSwapPss) swapPssError = "Missing SwapPss entry in smaps";
  if (!regionHasAnonymous) anonymousError = "Missing Anonymous entry in smaps";
  if (rollup && !hasShmemPss) shmemPssError = "Missing Pss_Shmem entry in smaps_rollup";
  if (rollup && !hasFilePss) filePssError = "Missing Pss_File entry in smaps_rollup";
  if (rollup && !hasAnonymousPss) anonymousPssError = "Missing Pss_Anon entry in smaps_rollup";
  return {rssKb * 1024, rollup ? "/proc/self/smaps_rollup:Rss" : "/proc/self/smaps:sum(Rss)",
    {pssError.empty() ? std::optional<uint64_t>(pssKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:Pss" : "/proc/self/smaps:sum(Pss)", pssError}, {}, {},
    {privateDirtyError.empty() ? std::optional<uint64_t>(privateDirtyKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:Private_Dirty" : "/proc/self/smaps:sum(Private_Dirty)", privateDirtyError},
    {privateCleanError.empty() ? std::optional<uint64_t>(privateCleanKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:Private_Clean" : "/proc/self/smaps:sum(Private_Clean)", privateCleanError},
    {sharedCleanError.empty() ? std::optional<uint64_t>(sharedCleanKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:Shared_Clean" : "/proc/self/smaps:sum(Shared_Clean)", sharedCleanError},
    {sharedDirtyError.empty() ? std::optional<uint64_t>(sharedDirtyKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:Shared_Dirty" : "/proc/self/smaps:sum(Shared_Dirty)", sharedDirtyError}, {}, {},
    {swapPssError.empty() ? std::optional<uint64_t>(swapPssKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:SwapPss" : "/proc/self/smaps:sum(SwapPss)", swapPssError},
    {anonymousError.empty() ? std::optional<uint64_t>(anonymousKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:Anonymous" : "/proc/self/smaps:sum(Anonymous)", anonymousError}, {}, {}, {}, {}, {}, {}, {},
    {anonymousPssError.empty() ? std::optional<uint64_t>(anonymousPssKb * 1024) : std::nullopt,
      "/proc/self/smaps_rollup:Pss_Anon", anonymousPssError},
    {filePssError.empty() ? std::optional<uint64_t>(filePssKb * 1024) : std::nullopt,
      "/proc/self/smaps_rollup:Pss_File", filePssError},
    {shmemPssError.empty() ? std::optional<uint64_t>(shmemPssKb * 1024) : std::nullopt,
      "/proc/self/smaps_rollup:Pss_Shmem", shmemPssError},
    {dirtyPssError.empty() ? std::optional<uint64_t>(dirtyPssKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:Pss_Dirty" : "/proc/self/smaps:sum(Pss_Dirty)", dirtyPssError},
    {referencedError.empty() ? std::optional<uint64_t>(referencedKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:Referenced" : "/proc/self/smaps:sum(Referenced)", referencedError},
    {swapError.empty() ? std::optional<uint64_t>(swapKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:Swap" : "/proc/self/smaps:sum(Swap)", swapError},
    {lazyFreeError.empty() ? std::optional<uint64_t>(lazyFreeKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:LazyFree" : "/proc/self/smaps:sum(LazyFree)", lazyFreeError},
    {anonHugePagesError.empty() ? std::optional<uint64_t>(anonHugePagesKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:AnonHugePages" : "/proc/self/smaps:sum(AnonHugePages)", anonHugePagesError},
    {filePmdMappedError.empty() ? std::optional<uint64_t>(filePmdMappedKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:FilePmdMapped" : "/proc/self/smaps:sum(FilePmdMapped)", filePmdMappedError},
    {shmemPmdMappedError.empty() ? std::optional<uint64_t>(shmemPmdMappedKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:ShmemPmdMapped" : "/proc/self/smaps:sum(ShmemPmdMapped)", shmemPmdMappedError},
    {privateHugetlbError.empty() ? std::optional<uint64_t>(privateHugetlbKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:Private_Hugetlb" : "/proc/self/smaps:sum(Private_Hugetlb)", privateHugetlbError},
    {sharedHugetlbError.empty() ? std::optional<uint64_t>(sharedHugetlbKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:Shared_Hugetlb" : "/proc/self/smaps:sum(Shared_Hugetlb)", sharedHugetlbError},
    {ksmError.empty() ? std::optional<uint64_t>(ksmKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:KSM" : "/proc/self/smaps:sum(KSM)", ksmError},
    {lockedResidentError.empty() ? std::optional<uint64_t>(lockedResidentKb * 1024) : std::nullopt,
      rollup ? "/proc/self/smaps_rollup:Locked" : "/proc/self/smaps:sum(Locked)", lockedResidentError}};
}

inline uint64_t rssFromSmaps(std::istream &input, bool rollup) {
  return memoryFromSmaps(input, rollup).bytes;
}

inline ResidentMemory readResidentMemory() {
#ifdef __APPLE__
  mach_task_basic_info_data_t info = {};
  mach_msg_type_number_t count = MACH_TASK_BASIC_INFO_COUNT;
  const auto status = task_info(mach_task_self(), MACH_TASK_BASIC_INFO,
      reinterpret_cast<task_info_t>(&info), &count);
  if (status != KERN_SUCCESS || count < MACH_TASK_BASIC_INFO_COUNT)
    throw std::runtime_error("Could not read MACH_TASK_BASIC_INFO resident_size");
  MemoryCounter footprint{std::nullopt, "task_info(TASK_VM_INFO).phys_footprint", ""};
  MemoryCounter peak{std::nullopt, "task_info(TASK_VM_INFO).resident_size_peak", ""};
  task_vm_info_data_t vm = {};
  mach_msg_type_number_t vmCount = TASK_VM_INFO_COUNT;
  const auto vmStatus = task_info(mach_task_self(), TASK_VM_INFO,
      reinterpret_cast<task_info_t>(&vm), &vmCount);
  if (vmStatus != KERN_SUCCESS)
    footprint.error = "TASK_VM_INFO failed with Mach status " + std::to_string(vmStatus);
  else if (vmCount < TASK_VM_INFO_REV1_COUNT)
    footprint.error = "TASK_VM_INFO response does not include phys_footprint";
  else footprint.bytes = vm.phys_footprint;
  if (vmStatus != KERN_SUCCESS)
    peak.error = "TASK_VM_INFO failed with Mach status " + std::to_string(vmStatus);
  else if (vmCount < TASK_VM_INFO_REV0_COUNT)
    peak.error = "TASK_VM_INFO response does not include resident_size_peak";
  else {
    try {
      if (vm.resident_size_peak > 9007199254740991ULL) throw std::runtime_error("Inexact Mach peak RSS counter");
      peak.bytes = peakRssBytes(static_cast<int64_t>(vm.resident_size_peak), 1);
    } catch (const std::exception &error) { peak.error = error.what(); }
  }
  return {info.resident_size, "task_info(MACH_TASK_BASIC_INFO).resident_size", {}, footprint, peak, {}, {}, {}, {},
    compressedFromTaskVmInfo(vmStatus, vmCount, vm), decompressionsFromTaskVmInfo(vmStatus, vmCount, vm), {}, {}, {},
    {info.virtual_size, "task_info(MACH_TASK_BASIC_INFO).virtual_size", ""}, {}, {},
    peakFootprintFromTaskVmInfo(vmStatus, vmCount, vm), regionsFromTaskVmInfo(vmStatus, vmCount, vm), {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, reusableFromTaskVmInfo(vmStatus, vmCount, vm), internalFromTaskVmInfo(vmStatus, vmCount, vm), externalFromTaskVmInfo(vmStatus, vmCount, vm), peakCompressedFromTaskVmInfo(vmStatus, vmCount, vm), peakReusableFromTaskVmInfo(vmStatus, vmCount, vm), peakInternalFromTaskVmInfo(vmStatus, vmCount, vm), peakExternalFromTaskVmInfo(vmStatus, vmCount, vm), cumulativeCompressedFromTaskVmInfo(vmStatus, vmCount, vm), purgeableNonvolatileFromTaskVmInfo(vmStatus, vmCount, vm), purgeableVolatileFromTaskVmInfo(vmStatus, vmCount, vm), purgeableNonvolatileCompressedFromTaskVmInfo(vmStatus, vmCount, vm), purgeableVolatileCompressedFromTaskVmInfo(vmStatus, vmCount, vm), graphicsFootprintFromTaskVmInfo(vmStatus, vmCount, vm)};
#else
  // Page-table accounting avoids the approximate/asynchronously updated fast
  // counters in statm/status. Preserve the source and measure query duration.
  std::ifstream rollup("/proc/self/smaps_rollup");
  ResidentMemory reading{};
  if (rollup.is_open()) reading = memoryFromSmaps(rollup, true);
  else {
    std::ifstream mappings("/proc/self/smaps");
    if (!mappings.is_open()) throw std::runtime_error("Process RSS is unavailable");
    reading = memoryFromSmaps(mappings, false);
  }
  reading.peakRss = {std::nullopt, "getrusage(RUSAGE_SELF).ru_maxrss", ""};
  try {
    rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage) != 0)
      throw std::system_error(errno, std::generic_category(), "getrusage peak RSS");
    reading.peakRss.bytes = peakRssBytes(usage.ru_maxrss, 1024);
  } catch (const std::exception &error) { reading.peakRss.error = error.what(); }
  // Separate read within the caller's measured query interval; not atomic with smaps.
  const auto statusMemory = readStatusMemory();
  reading.pageTables = statusMemory.pageTables;
  reading.virtualSize = statusMemory.virtualSize;
  reading.locked = statusMemory.locked;
  reading.peakVirtual = statusMemory.peakVirtual;
  reading.vmas = readVmas();
  return reading;
#endif
}

// A bounded validation allocation. Each page is written so virtual address
// reservation alone cannot be mistaken for an RSS increase. munmap releases
// the mapping directly, independent of a malloc allocator's retention policy.
class MemoryProbe {
 public:
  static constexpr size_t capacity = 64 * 1024 * 1024;
  MemoryProbe() = default;
  MemoryProbe(const MemoryProbe &) = delete;
  MemoryProbe &operator=(const MemoryProbe &) = delete;
  ~MemoryProbe() { release(); }

  void hold() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (memory_) throw std::runtime_error("Memory check is already holding 64 MiB");
    const long page = sysconf(_SC_PAGESIZE);
    if (page <= 0) throw std::runtime_error("Could not determine the system page size");
    void *mapped = mmap(nullptr, capacity, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANON, -1, 0);
    if (mapped == MAP_FAILED) throw std::system_error(errno, std::generic_category(), "Memory check allocation failed");
    memory_ = mapped;
    auto bytes = static_cast<volatile unsigned char *>(memory_);
    for (size_t offset = 0; offset < capacity; offset += static_cast<size_t>(page))
      bytes[offset] = static_cast<unsigned char>((offset / page) % 251 + 1);
  }

  void release() noexcept {
    std::lock_guard<std::mutex> lock(mutex_);
    if (memory_) { munmap(memory_, capacity); memory_ = nullptr; }
    if (second_) { munmap(second_, capacity); second_ = nullptr; }
    clean_ = false;
    sharedDirty_ = false;
  }

  // A distinct check: sync file writes before mapping read-only, then verify a
  // byte on every page. The optional second mapping aliases the same file pages.
  // MAP_PRIVATE does not itself determine the kernel's private/shared accounting.
  void holdClean(const std::string &directory, bool twice = false) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (memory_) throw std::runtime_error("Memory check is already holding 64 MiB");
    const long page = sysconf(_SC_PAGESIZE);
    if (page <= 0 || capacity % static_cast<size_t>(page))
      throw std::runtime_error("Invalid memory check page size");
    struct File {
      int fd = -1;
      void *mapping = MAP_FAILED;
      void *second = MAP_FAILED;
      ~File() {
        if (mapping != MAP_FAILED) munmap(mapping, capacity);
        if (second != MAP_FAILED) munmap(second, capacity);
        if (fd >= 0) close(fd);
      }
    } file;
    const std::string pattern = directory + "/wfloat-clean-memory-XXXXXX";
    std::vector<char> path(pattern.begin(), pattern.end()); path.push_back(0);
    file.fd = mkstemp(path.data());
    if (file.fd < 0) throw std::system_error(errno, std::generic_category(), "Create clean-memory probe file");
    if (unlink(path.data()) != 0)
      throw std::system_error(errno, std::generic_category(), "Unlink clean-memory probe file");
    // The unlinked file remains alive only through our descriptor/mapping.
    std::array<unsigned char, 64 * 1024> block;
    for (size_t i = 0; i < block.size(); ++i) block[i] = static_cast<unsigned char>(i % 251 + 1);
    for (size_t offset = 0; offset < capacity;) {
      const size_t blockOffset = offset % block.size();
      const auto written = write(file.fd, block.data() + blockOffset, block.size() - blockOffset);
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) throw std::system_error(written == 0 ? EIO : errno, std::generic_category(), "Write clean-memory probe file");
      offset += static_cast<size_t>(written);
    }
    if (fsync(file.fd) != 0) throw std::system_error(errno, std::generic_category(), "Sync clean-memory probe file");
    file.mapping = mmap(nullptr, capacity, PROT_READ, MAP_PRIVATE, file.fd, 0);
    if (file.mapping == MAP_FAILED) throw std::system_error(errno, std::generic_category(), "Map clean-memory probe file");
    if (twice) {
      file.second = mmap(nullptr, capacity, PROT_READ, MAP_PRIVATE, file.fd, 0);
      if (file.second == MAP_FAILED) throw std::system_error(errno, std::generic_category(), "Map clean-memory probe file again");
    }
    for (void *mapping : {file.mapping, file.second}) {
      if (mapping == MAP_FAILED) continue;
      const auto *mapped = static_cast<volatile const unsigned char *>(mapping);
      for (size_t offset = 0; offset < capacity; offset += static_cast<size_t>(page))
        if (mapped[offset] != block[offset % block.size()]) throw std::runtime_error("Clean-memory probe content mismatch");
    }
    memory_ = file.mapping;
    second_ = twice ? file.second : nullptr;
    file.mapping = MAP_FAILED;
    file.second = MAP_FAILED;
    clean_ = true;
  }

  // ASharedMemory is a public API from Android 26. Resolve it only when this
  // optional check is requested so the collector still loads on API 24/25.
  void holdSharedDirty() {
#ifdef __ANDROID__
    std::lock_guard<std::mutex> lock(mutex_);
    if (memory_) throw std::runtime_error("A memory check is already active");
    const long page = sysconf(_SC_PAGESIZE);
    if (page <= 0 || capacity % static_cast<size_t>(page))
      throw std::runtime_error("Invalid shared-memory check page size");
    struct Region {
      void *library = nullptr;
      int fd = -1;
      void *first = MAP_FAILED;
      void *second = MAP_FAILED;
      ~Region() {
        if (first != MAP_FAILED) munmap(first, capacity);
        if (second != MAP_FAILED) munmap(second, capacity);
        if (fd >= 0) close(fd);
        if (library) dlclose(library);
      }
    } region;
    region.library = dlopen("libandroid.so", RTLD_NOW | RTLD_LOCAL);
    if (!region.library) throw std::runtime_error("Could not load Android shared-memory API");
    using Create = int (*)(const char *, size_t);
    const auto create = reinterpret_cast<Create>(dlsym(region.library, "ASharedMemory_create"));
    if (!create) throw std::runtime_error("Shared-memory check requires Android API 26 or later");
    region.fd = create("wfloat-shared-dirty-check", capacity);
    if (region.fd < 0) throw std::system_error(errno, std::generic_category(), "Create shared-memory check");
    region.first = mmap(nullptr, capacity, PROT_READ | PROT_WRITE, MAP_SHARED, region.fd, 0);
    if (region.first == MAP_FAILED) throw std::system_error(errno, std::generic_category(), "Map shared-memory check");
    region.second = mmap(nullptr, capacity, PROT_READ, MAP_SHARED, region.fd, 0);
    if (region.second == MAP_FAILED) throw std::system_error(errno, std::generic_category(), "Map shared-memory check again");
    auto *written = static_cast<volatile unsigned char *>(region.first);
    const auto *alias = static_cast<volatile const unsigned char *>(region.second);
    for (size_t offset = 0; offset < capacity; offset += static_cast<size_t>(page)) {
      const auto expected = static_cast<unsigned char>((offset / page) % 251 + 1);
      written[offset] = expected;
      if (alias[offset] != expected) throw std::runtime_error("Shared-memory alias verification failed");
    }
    memory_ = region.first;
    second_ = region.second;
    sharedDirty_ = true;
    region.first = region.second = MAP_FAILED;
#else
    throw std::runtime_error("Shared-memory check requires Android API 26 or later");
#endif
  }

  size_t heldSharedRegionBytes() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return memory_ && sharedDirty_ ? capacity : 0;
  }

  const char *kind() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return !memory_ ? "none" : sharedDirty_ ? (second_ ? "shared_dirty_twice" : "shared_dirty_once")
      : second_ ? "file_clean_twice" : clean_ ? "file_clean" : "anonymous_dirty";
  }

  size_t heldBytes() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return (memory_ ? capacity : 0) + (second_ ? capacity : 0);
  }

  size_t heldFileBytes() const {
    std::lock_guard<std::mutex> lock(mutex_);
    return memory_ && clean_ ? capacity : 0;
  }

  void releaseSecondMapping() {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!second_) throw std::runtime_error("No second mapping is held");
    if (munmap(second_, capacity) != 0)
      throw std::system_error(errno, std::generic_category(), "Unmap second memory-check mapping");
    second_ = nullptr;
  }

 private:
  mutable std::mutex mutex_;
  void *memory_ = nullptr;
  void *second_ = nullptr;
  bool clean_ = false;
  bool sharedDirty_ = false;
};
} // namespace bench
