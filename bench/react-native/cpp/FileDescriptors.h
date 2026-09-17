#pragma once

#include <cerrno>
#include <climits>
#include <dirent.h>
#include <memory>
#include <stdexcept>
#include <system_error>

namespace bench {
struct FileDescriptorReading {
  int count;
  int collectorDescriptor;
};

inline bool parseDescriptorName(const char *name, int &value) {
  if (!name || !*name) return false;
  value = 0;
  for (const char *p = name; *p; ++p) {
    if (*p < '0' || *p > '9' || value > (INT_MAX - (*p - '0')) / 10) return false;
    value = value * 10 + (*p - '0');
  }
  return true;
}

// A traversal, not an atomic snapshot: other threads can open or close handles.
// Exclude only this traversal's own descriptor. Duplicates count individually.
inline FileDescriptorReading readFileDescriptors(const char *path = "/proc/self/fd") {
  DIR *raw = opendir(path);
  if (!raw) throw std::system_error(errno, std::generic_category(), "opendir /proc/self/fd");
  const auto closeDirectory = [](DIR *directory) { closedir(directory); };
  std::unique_ptr<DIR, decltype(closeDirectory)> directory(raw, closeDirectory);
  const int collector = dirfd(raw);
  if (collector < 0) throw std::system_error(errno, std::generic_category(), "dirfd /proc/self/fd");
  int count = 0;
  bool foundCollector = false;
  while (true) {
    errno = 0;
    const auto *entry = readdir(raw);
    if (!entry) {
      if (errno) throw std::system_error(errno, std::generic_category(), "readdir /proc/self/fd");
      break;
    }
    int descriptor;
    if (!parseDescriptorName(entry->d_name, descriptor)) continue;
    if (descriptor == collector) { foundCollector = true; continue; }
    if (count == INT_MAX) throw std::overflow_error("File-descriptor count overflow");
    ++count;
  }
  if (!foundCollector) throw std::runtime_error("Collector descriptor missing from /proc/self/fd");
  return {count, collector};
}
} // namespace bench
