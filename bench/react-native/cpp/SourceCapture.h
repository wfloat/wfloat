#pragma once
#include <filesystem>
#include <fstream>
#include <chrono>
#include <string>
#include <mutex>
#include <unistd.h>
#include <fcntl.h>
#include <sys/file.h>
#include <stdexcept>

namespace bench {
// Newline-delimited complete source observations; never overwrite old evidence.
// Deliberately bounded. No fsync guarantee; completed records are flushed to OS.
class SourceCapture {
  std::mutex mutex;
  std::ofstream stream;
  std::string path, state = "not_started";
  size_t written = 0;
  const size_t fileLimit, directoryLimit;
  const std::string prefix;
public:
  explicit SourceCapture(size_t fileBytes = 32*1024*1024, size_t directoryBytes = 128*1024*1024, std::string filePrefix = "threads")
    : fileLimit(fileBytes), directoryLimit(directoryBytes), prefix(std::move(filePrefix)) {}
  std::string append(const std::string &directory, const std::string &json) noexcept {
    std::lock_guard<std::mutex> lock(mutex);
    try {
      if (state != "not_started" && state != "recording") return state;
      if (json.find('\n') != std::string::npos || json.empty()) return "invalid_record";
      std::filesystem::create_directories(directory);
      // All writers (including separate Android shared libraries) share the
      // directory quota. Serialize the size-check + append with an OS lock.
      struct DirectoryLock {
        int fd;
        explicit DirectoryLock(const std::string &directory) : fd(open((directory+"/.capture.lock").c_str(),O_CREAT|O_RDWR|O_CLOEXEC,0600)) {
          if(fd<0) throw std::runtime_error("capture lock open failed");
          if(flock(fd,LOCK_EX)!=0) { close(fd);fd=-1;throw std::runtime_error("capture lock failed"); }
        }
        ~DirectoryLock() { if(fd>=0) { flock(fd,LOCK_UN);close(fd); } }
      } directoryLock(directory);
      size_t total = 0;
      for (const auto &entry : std::filesystem::directory_iterator(directory)) {
        if (entry.is_regular_file()) total += entry.file_size();
      }
      if (json.size()+1 > fileLimit-written || total >= directoryLimit || json.size()+1 > directoryLimit-total) {
        state = "size_limit"; stream.close(); return state;
      }
      if (!stream.is_open()) {
        auto tick = std::chrono::steady_clock::now().time_since_epoch().count();
        path = directory + "/" + prefix + "-" + std::to_string(getpid()) + "-" + std::to_string(tick) + ".jsonl";
        if (std::filesystem::exists(path)) { state="name_collision"; return state; }
        stream.open(path, std::ios::out | std::ios::binary);
        if (!stream) { state="open_failed"; return state; }
      }
      stream << json << '\n'; stream.flush();
      if (!stream) { state="write_failed"; stream.close(); return state; }
      written += json.size()+1; state="recording";
    } catch (...) { state="io_failed"; stream.close(); }
    return state;
  }
  std::string filePath() { std::lock_guard<std::mutex> lock(mutex); return path; }
};
}
