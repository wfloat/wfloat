#pragma once
#include "PageFaultCounters.h"
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdlib>
#include <fcntl.h>
#include <functional>
#include <iomanip>
#include <locale>
#include <numeric>
#include <sstream>
#include <string>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>
#include <vector>

namespace bench {
inline double probeUptimeMs() {
  timespec value = {};
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0)
    throw std::system_error(errno, std::generic_category(), "clock_gettime");
  return value.tv_sec * 1000.0 + value.tv_nsec / 1e6;
}
inline double probeWallMs() {
  return std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();
}
inline std::string probeQuoted(const std::string &text) {
  std::string out = "\"";
  for (unsigned char c : text) {
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else out += c < 0x20 ? ' ' : c;
  }
  return out + '"';
}
struct FaultSnapshot {
  PageFaultCounters counters;
  double beforeMs, afterMs;
};
inline FaultSnapshot fileFaultSnapshot() {
  const double before = probeUptimeMs();
  const auto counters = readPageFaultCounters();
  return {counters, before, probeUptimeMs()};
}
struct FileFaultPass {
  std::string name;
  FaultSnapshot before{}, after{};
  double readStartedMs = 0, readFinishedMs = 0;
  int64_t residentPagesBefore = -1;
  int residencyErrno = 0;
  size_t touchedPages = 0;
  uint64_t checksum = 0;
};
struct FileFaultResult {
  std::string status = "failed", stage = "preparing", error;
  uint64_t runSequence = 0;
  size_t fileBytes = 0, pageSizeBytes = 0;
  double startedAtMs = 0, startedUptimeMs = 0, finishedUptimeMs = 0;
  double budgetMs = 30000;
  std::string cacheOperation;
  int cacheResult = -1, randomAdviceResult = -1;
  std::vector<FileFaultPass> passes;

  std::string json() const {
    std::ostringstream out;
    out.imbue(std::locale::classic());
    out << std::setprecision(17);
#ifdef __APPLE__
    const char *kind = "ios_vm_events", *first = "vmFaults", *second = "pageIns";
    const char *source = "task_info(TASK_EVENTS_INFO):faults,pageins";
#else
    const char *kind = "android_minor_major", *first = "minorFaults", *second = "majorFaults";
    const char *source = "getrusage(RUSAGE_SELF):ru_minflt,ru_majflt";
#endif
    const auto snapshot = [&](const FaultSnapshot &s) {
      out << "{\"counters\":{\"" << first << "\":" << s.counters.first
          << ",\"" << second << "\":" << s.counters.second << "},\"queryStartedUptimeMs\":"
          << s.beforeMs << ",\"queryFinishedUptimeMs\":" << s.afterMs << '}';
    };
    out << "{\"status\":" << probeQuoted(status) << ",\"stage\":" << probeQuoted(stage)
        << ",\"error\":" << probeQuoted(error) << ",\"kind\":" << probeQuoted(kind)
        << ",\"source\":" << probeQuoted(source) << ",\"processId\":" << getpid()
        << ",\"runSequence\":" << runSequence << ",\"fileBytes\":" << fileBytes
        << ",\"pageSizeBytes\":" << pageSizeBytes << ",\"startedAtMs\":" << startedAtMs
        << ",\"clockSource\":\"CLOCK_MONOTONIC\",\"startedUptimeMs\":" << startedUptimeMs
        << ",\"finishedUptimeMs\":" << finishedUptimeMs << ",\"budgetMs\":" << budgetMs
        << ",\"accessPattern\":\"one_verified_byte_per_page_stride_131\""
        << ",\"cacheOperation\":" << probeQuoted(cacheOperation) << ",\"cacheResult\":" << cacheResult
        << ",\"randomAdviceResult\":" << randomAdviceResult << ",\"passes\":[";
    for (size_t i = 0; i < passes.size(); ++i) {
      const auto &p = passes[i];
      if (i) out << ',';
      out << "{\"name\":" << probeQuoted(p.name) << ",\"before\":"; snapshot(p.before);
      out << ",\"after\":"; snapshot(p.after);
      out << ",\"readStartedUptimeMs\":" << p.readStartedMs << ",\"readFinishedUptimeMs\":" << p.readFinishedMs
          << ",\"residentPagesBefore\":" << p.residentPagesBefore << ",\"residencyErrno\":" << p.residencyErrno
          << ",\"touchedPages\":" << p.touchedPages << ",\"checksum\":" << p.checksum << '}';
    }
    return out.str() + "]}";
  }
};

// Owns only a freshly created private file and its mapping. Unlink immediately
// so a crash also leaves no named test file. Never evict system-wide caches.
struct ProbeFile {
  int fd = -1;
  void *mapping = MAP_FAILED;
  size_t bytes = 0;
  explicit ProbeFile(const std::string &directory) {
    std::string pattern = directory + "/wfloat-file-faults-XXXXXX";
    std::vector<char> path(pattern.begin(), pattern.end()); path.push_back(0);
    fd = mkstemp(path.data());
    if (fd < 0) throw std::system_error(errno, std::generic_category(), "Create probe file");
    if (unlink(path.data()) != 0) {
      const int code = errno; close(fd); fd = -1;
      throw std::system_error(code, std::generic_category(), "Unlink probe file");
    }
  }
  ~ProbeFile() { if (mapping != MAP_FAILED) munmap(mapping, bytes); if (fd >= 0) close(fd); }
  ProbeFile(const ProbeFile &) = delete;
  ProbeFile &operator=(const ProbeFile &) = delete;
};

class FileFaultProbe {
  std::atomic<uint64_t> epoch_{0}, sequence_{0};
  std::atomic<bool> running_{false};
 public:
  static constexpr size_t capacity = 32 * 1024 * 1024;
  uint64_t token() const { return epoch_.load(); }
  void cancel() { epoch_.fetch_add(1); }
  bool running() const { return running_.load(); }

  // Smaller sizes / budgets are only for native lifecycle tests. App callers
  // use the fixed defaults. Cancellation cannot interrupt a blocked syscall.
  FileFaultResult run(const std::string &directory, uint64_t token,
                      size_t bytes = capacity, double budgetMs = 30000) {
    if (running_.exchange(true)) throw std::runtime_error("A file probe is already running");
    struct Reset { std::atomic<bool> &flag; ~Reset() { flag.store(false); } } reset{running_};
    FileFaultResult result;
    result.runSequence = ++sequence_;
    result.fileBytes = bytes;
    result.budgetMs = budgetMs;
    result.startedAtMs = probeWallMs();
    result.startedUptimeMs = probeUptimeMs();
    struct Stopped { std::string status; };
    const auto check = [&] {
      if (epoch_.load() != token) throw Stopped{"cancelled"};
      if (probeUptimeMs() - result.startedUptimeMs >= budgetMs) throw Stopped{"deadline"};
    };
    try {
      check();
      const long pageSize = sysconf(_SC_PAGESIZE);
      if (pageSize <= 0 || bytes == 0 || bytes > capacity || bytes % pageSize != 0)
        throw std::runtime_error("Invalid file-probe size or system page size");
      result.pageSizeBytes = pageSize;
      const size_t pages = bytes / pageSize;
      if (std::gcd(size_t{131}, pages) != 1) throw std::runtime_error("Invalid page traversal");
      ProbeFile file(directory);
#ifdef __APPLE__
      result.cacheOperation = "fcntl(F_NOCACHE,1) before writing + fsync";
      result.cacheResult = fcntl(file.fd, F_NOCACHE, 1) == 0 ? 0 : errno;
#else
      result.cacheOperation = "fsync + posix_fadvise(POSIX_FADV_DONTNEED)";
#endif
      std::vector<unsigned char> buffer(64 * 1024), expected(pages);
      uint32_t random = 0x6d2b79f5U;
      for (size_t offset = 0; offset < bytes; offset += buffer.size()) {
        check();
        const size_t size = std::min(buffer.size(), bytes - offset);
        for (size_t i = 0; i < size; ++i) {
          random ^= random << 13; random ^= random >> 17; random ^= random << 5;
          buffer[i] = static_cast<unsigned char>(random);
          if ((offset + i) % pageSize == 0) expected[(offset + i) / pageSize] = buffer[i];
        }
        for (size_t written = 0; written < size;) {
          check();
          const auto n = write(file.fd, buffer.data() + written, size - written);
          if (n < 0 && errno == EINTR) continue;
          if (n <= 0) throw std::system_error(n == 0 ? EIO : errno, std::generic_category(), "Write probe file");
          written += static_cast<size_t>(n);
        }
      }
      check();
      if (fsync(file.fd) != 0) throw std::system_error(errno, std::generic_category(), "Sync probe file");
      check();
#ifndef __APPLE__
      result.cacheResult = posix_fadvise(file.fd, 0, bytes, POSIX_FADV_DONTNEED);
#endif
      file.bytes = bytes;
      file.mapping = mmap(nullptr, bytes, PROT_READ, MAP_PRIVATE, file.fd, 0);
      if (file.mapping == MAP_FAILED) throw std::system_error(errno, std::generic_category(), "Map probe file");
      result.randomAdviceResult = madvise(file.mapping, bytes, MADV_RANDOM) == 0 ? 0 : errno;
      std::vector<unsigned char> residency(pages);
      result.passes.reserve(2);
      for (const auto *name : {"first_read", "reread"}) {
        check();
        result.stage = name;
        FileFaultPass pass;
        pass.name = name;
#ifdef __APPLE__
        const auto residentResult = mincore(static_cast<char *>(file.mapping), bytes, reinterpret_cast<char *>(residency.data()));
#else
        const auto residentResult = mincore(file.mapping, bytes, residency.data());
#endif
        if (residentResult == 0) {
          pass.residentPagesBefore = 0;
          for (auto value : residency) pass.residentPagesBefore += value & 1;
        } else pass.residencyErrno = errno;
        pass.before = fileFaultSnapshot();
        pass.readStartedMs = probeUptimeMs();
        const auto *mapped = static_cast<volatile const unsigned char *>(file.mapping);
        for (size_t i = 0; i < pages; ++i) {
          check();
          const size_t index = (i * 131) % pages;
          const auto value = mapped[index * pageSize];
          if (value != expected[index]) throw std::runtime_error("Probe file verification failed");
          pass.checksum += value;
          ++pass.touchedPages;
        }
        pass.readFinishedMs = probeUptimeMs();
        pass.after = fileFaultSnapshot();
        if (pass.after.counters.first < pass.before.counters.first || pass.after.counters.second < pass.before.counters.second)
          throw std::runtime_error("Page-fault counter decreased during a pass");
        result.passes.push_back(pass);
      }
      check();
      result.status = "completed";
      result.stage = "finished";
    } catch (const Stopped &stop) { result.status = stop.status; }
      catch (const std::exception &error) { result.error = error.what(); }
    result.finishedUptimeMs = probeUptimeMs();
    return result;
  }
};
} // namespace bench
