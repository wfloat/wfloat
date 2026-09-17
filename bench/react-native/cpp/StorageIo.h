#pragma once
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <fcntl.h>
#include <fstream>
#include <iomanip>
#include <locale>
#include <map>
#include <mutex>
#include <sstream>
#include <stdexcept>
#include <string>
#include <system_error>
#include <sys/resource.h>
#include <sys/utsname.h>
#include <time.h>
#include <unistd.h>
#include <vector>
#ifdef __APPLE__
#if __has_include(<libproc.h>)
#include <libproc.h>
#else
#include <sys/resource.h>
// Declaration follows Apple's WWDC22 "Profile and optimize your game's memory"
// example for iOS SDKs that expose rusage structures but omit libproc.h.
extern "C" int proc_pid_rusage(int pid, int flavor, rusage_info_t *buffer)
  __OSX_AVAILABLE_STARTING(__MAC_10_9, __IPHONE_7_0);
#endif
#endif

namespace bench {
inline uint64_t exactIoBytes(uint64_t value) {
  if (value > 9007199254740991ULL) throw std::runtime_error("I/O counter exceeds exact JavaScript integer range");
  return value;
}
using IoCounters = std::map<std::string, uint64_t>;
inline IoCounters parseStorageIo(std::istream &input) {
  const std::map<std::string, std::string> names = {
    {"read_bytes", "readBytes"}, {"write_bytes", "writeBytes"}, {"cancelled_write_bytes", "cancelledWriteBytes"},
    {"rchar", "logicalReadBytes"}, {"wchar", "logicalWriteBytes"}, {"syscr", "readCalls"}, {"syscw", "writeCalls"}};
  IoCounters counters;
  std::string line;
  while (std::getline(input, line)) {
    const auto colon = line.find(':');
    const auto known = names.find(line.substr(0, colon));
    if (known == names.end()) continue;
    if (colon == std::string::npos) throw std::runtime_error("Malformed process I/O field");
    std::istringstream fields(line.substr(colon + 1));
    std::string digits, extra;
    if (!(fields >> digits) || (fields >> extra) || digits.find_first_not_of("0123456789") != std::string::npos ||
        counters.count(known->second)) throw std::runtime_error("Malformed or duplicate process I/O counter");
    counters[known->second] = exactIoBytes(std::stoull(digits));
  }
  if (input.bad() || counters.size() != names.size()) throw std::runtime_error("Incomplete process I/O counters");
  return counters;
}
inline uint64_t ioBlocksToBytes(int64_t blocks) {
  if (blocks < 0 || static_cast<uint64_t>(blocks) > 9007199254740991ULL / 512)
    throw std::runtime_error("Invalid or inexact storage block counter");
  return static_cast<uint64_t>(blocks) * 512;
}
inline IoCounters readStorageIoCounters() {
#ifdef __APPLE__
  rusage_info_v2 usage{};
  if (proc_pid_rusage(getpid(), RUSAGE_INFO_V2, reinterpret_cast<rusage_info_t *>(&usage)) != 0)
    throw std::system_error(errno, std::generic_category(), "proc_pid_rusage(RUSAGE_INFO_V2)");
  return {{"readBytes", exactIoBytes(usage.ri_diskio_bytesread)}, {"writeBytes", exactIoBytes(usage.ri_diskio_byteswritten)}};
#else
  rusage usage{};
  if (getrusage(RUSAGE_SELF, &usage) != 0) throw std::system_error(errno, std::generic_category(), "getrusage storage I/O");
  // Android/Linux task_io_get_{in,out}block exposes byte accounting >> 9.
  // This is a kernel accounting unit, not an operation count or filesystem block size.
  return {{"readBytes", ioBlocksToBytes(usage.ru_inblock)}, {"writeBytes", ioBlocksToBytes(usage.ru_oublock)},
    {"readBlocks", static_cast<uint64_t>(usage.ru_inblock)}, {"writeBlocks", static_cast<uint64_t>(usage.ru_oublock)}};
#endif
}
inline double ioUptimeMs() {
  timespec value{};
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) throw std::system_error(errno, std::generic_category(), "I/O clock");
  return value.tv_sec * 1000.0 + value.tv_nsec / 1e6;
}
struct StorageIoSnapshot {
  IoCounters counters;
  double beforeMs, afterMs, wallMs;
  uint64_t sequence;
  IoCounters procIo;
  int procIoErrno = 0;
  std::string procIoError;
  std::string kernelRelease;
  std::string json() const {
    std::ostringstream out; out.imbue(std::locale::classic()); out << std::setprecision(17);
#ifdef __APPLE__
    out << "{\"platform\":\"ios\",\"source\":\"proc_pid_rusage(RUSAGE_INFO_V2):ri_diskio_bytesread,ri_diskio_byteswritten\"";
#else
    out << "{\"platform\":\"android\",\"source\":\"getrusage(RUSAGE_SELF):ru_inblock,ru_oublock\",\"accountingUnitBytes\":512";
#endif
    const auto quoted = [](const std::string &text) {
      std::string escaped = "\"";
      for (unsigned char c : text) { if (c == '"' || c == '\\') escaped += '\\'; escaped += c < 32 ? ' ' : c; }
      return escaped + '"';
    };
    out << ",\"kernelRelease\":" << quoted(kernelRelease) << ",\"clockSource\":\"CLOCK_MONOTONIC\",\"processId\":" << getpid() << ",\"sequence\":" << sequence
        << ",\"queryStartedUptimeMs\":" << beforeMs << ",\"queryFinishedUptimeMs\":" << afterMs
        << ",\"sampledAtMs\":" << wallMs << ",\"counters\":{";
    bool first = true;
    for (const auto &[key, value] : counters) { if (!first) out << ','; first = false; out << '"' << key << "\":" << value; }
    out << '}';
#ifndef __APPLE__
    out << ",\"procIo\":{\"source\":\"/proc/self/io\",\"errno\":" << procIoErrno << ",\"error\":"
        << (procIoError.empty() ? "null" : quoted(procIoError)) << ",\"counters\":";
    if (procIo.empty()) out << "null";
    else {
      out << '{'; first = true;
      for (const auto &[key, value] : procIo) { if (!first) out << ','; first = false; out << '"' << key << "\":" << value; }
      out << '}';
    }
    out << '}';
#endif
    return out.str() + "}";
  }
};
inline StorageIoSnapshot storageIoSnapshot() {
  // Serialize queries from polling and the check. Logging stays outside bounds.
  static std::mutex mutex;
  static uint64_t sequence = 0;
  std::lock_guard<std::mutex> lock(mutex);
  const double before = ioUptimeMs();
  const auto counters = readStorageIoCounters();
  IoCounters procIo;
  int procIoErrno = 0;
  std::string procIoError;
#ifndef __APPLE__
  try {
    errno = 0;
    std::ifstream file("/proc/self/io");
    if (!file.is_open()) {
      procIoErrno = errno;
      throw std::runtime_error("Extra /proc/self/io counters are unavailable");
    }
    procIo = parseStorageIo(file);
  } catch (const std::exception &error) { procIoError = error.what(); }
#endif
  utsname system{};
  if (uname(&system) != 0) throw std::system_error(errno, std::generic_category(), "I/O kernel identity");
  const double after = ioUptimeMs();
  const double wall = std::chrono::duration<double, std::milli>(std::chrono::system_clock::now().time_since_epoch()).count();
  return {counters, before, after, wall, exactIoBytes(++sequence), procIo, procIoErrno, procIoError, system.release};
}

struct StorageIoFile {
  int fd = -1;
  explicit StorageIoFile(const std::string &directory) {
    const std::string pattern = directory + "/wfloat-storage-XXXXXX";
    std::vector<char> path(pattern.begin(), pattern.end()); path.push_back(0);
    fd = mkstemp(path.data());
    if (fd < 0) throw std::system_error(errno, std::generic_category(), "Create storage check file");
    if (unlink(path.data()) != 0) {
      const int code = errno; close(fd); fd = -1;
      throw std::system_error(code, std::generic_category(), "Unlink storage check file");
    }
  }
  ~StorageIoFile() { if (fd >= 0) close(fd); }
  StorageIoFile(const StorageIoFile &) = delete;
  StorageIoFile &operator=(const StorageIoFile &) = delete;
};
struct StorageIoCheckResult {
  uint64_t runSequence;
  size_t fileBytes;
  std::vector<StorageIoSnapshot> snapshots;
  bool reduceCaching = false;
  int cacheControlErrno = 0;
  std::string json() const {
    std::ostringstream out;
    out << "{\"status\":\"completed\",\"runSequence\":" << runSequence << ",\"fileBytes\":" << fileBytes
        << ",\"readPasses\":2,\"cachePolicy\":\"" << (reduceCaching ? "file_cache_control" : "buffered_no_eviction")
        << "\",\"sync\":\"fsync\",\"cacheControl\":";
    if (!reduceCaching) out << "null";
    else {
#ifdef __APPLE__
      out << "{\"operation\":\"fcntl(F_NOCACHE,1) before write and both reads\"";
#else
      out << "{\"operation\":\"posix_fadvise(POSIX_FADV_DONTNEED) after fsync, before first read\"";
#endif
      out << ",\"errno\":" << cacheControlErrno << '}';
    }
    out << ",\"snapshots\":[";
    for (size_t i = 0; i < snapshots.size(); ++i) { if (i) out << ','; out << snapshots[i].json(); }
    return out.str() + "]}";
  }
};
class StorageIoCheck {
  std::atomic<uint64_t> epoch_{0}, sequence_{0};
  std::mutex runMutex_;
 public:
  static constexpr size_t capacity = 32 * 1024 * 1024;
  uint64_t token() const { return epoch_.load(); }
  void cancel() { ++epoch_; }
  StorageIoCheckResult run(const std::string &directory, uint64_t token, bool reduceCaching = false) {
    std::unique_lock<std::mutex> lock(runMutex_, std::try_to_lock);
    if (!lock.owns_lock()) throw std::runtime_error("Storage check is already running");
    const double started = ioUptimeMs();
    const auto check = [&] {
      if (epoch_.load() != token) throw std::runtime_error("Storage check cancelled");
      if (ioUptimeMs() - started > 30000) throw std::runtime_error("Storage check exceeded 30-second cooperative deadline");
    };
    check();
    StorageIoFile file(directory);
    std::vector<unsigned char> expected(256 * 1024), buffer(expected.size());
    uint32_t state = 0x12345678;
    for (auto &byte : expected) { state ^= state << 13; state ^= state >> 17; state ^= state << 5; byte = state & 255; }
    StorageIoCheckResult result{++sequence_, capacity, {storageIoSnapshot()}, reduceCaching};
#ifdef __APPLE__
    if (reduceCaching && fcntl(file.fd, F_NOCACHE, 1) != 0) result.cacheControlErrno = errno;
#endif
    for (size_t offset = 0; offset < capacity;) {
      check();
      const auto count = pwrite(file.fd, expected.data(), expected.size(), offset);
      if (count < 0 && errno == EINTR) continue;
      if (count != static_cast<ssize_t>(expected.size())) throw std::runtime_error("Storage check write was incomplete");
      offset += count;
    }
    check();
    int syncResult;
    do { check(); syncResult = fsync(file.fd); } while (syncResult < 0 && errno == EINTR);
    if (syncResult != 0) throw std::system_error(errno, std::generic_category(), "Storage check fsync");
    #ifndef __APPLE__
    if (reduceCaching) result.cacheControlErrno = posix_fadvise(file.fd, 0, capacity, POSIX_FADV_DONTNEED);
#endif
    check(); result.snapshots.push_back(storageIoSnapshot());
    for (int pass = 0; pass < 2; ++pass) {
      for (size_t offset = 0; offset < capacity;) {
        check();
        const auto count = pread(file.fd, buffer.data(), buffer.size(), offset);
        if (count < 0 && errno == EINTR) continue;
        if (count != static_cast<ssize_t>(buffer.size()) || std::memcmp(buffer.data(), expected.data(), buffer.size()) != 0)
          throw std::runtime_error("Storage check read or content verification failed");
        offset += count;
      }
      check(); result.snapshots.push_back(storageIoSnapshot());
    }
    return result; // File closes even on exceptions; no named file survives a crash.
  }
};
} // namespace bench
