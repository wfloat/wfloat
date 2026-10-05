#pragma once
#include <cstdlib>
#include <stdexcept>
#include <string>
#include <vector>
#include <unistd.h>

namespace wfloat_next {
// ORT's file loader infers its serialized format from the filename, whereas RN
// cache keys intentionally have no suffix. Own an alias, never rename/copy the
// verified cache object. Platform asset leases continue pinning the original.
class OrtAssetPath {
 public:
  explicit OrtAssetPath(const std::string& source) : path_(source) {
    if (source.empty() || source.front() != '/' || source.find('\0') != std::string::npos)
      throw std::invalid_argument("ORT asset must be an absolute local path.");
    if (source.size() >= 4 && source.compare(source.size()-4, 4, ".ort") == 0) return;
    if (access(source.c_str(), R_OK) != 0) throw std::runtime_error("ORT cache asset is unreadable.");
    auto name = source.substr(0, source.find_last_of('/') + 1) + ".wfloat-ort-XXXXXX";
    std::vector<char> writable(name.begin(), name.end()); writable.push_back(0);
    if (!mkdtemp(writable.data())) throw std::runtime_error("Cannot create ORT alias directory.");
    directory_ = writable.data(); path_ = directory_ + "/model.ort";
    // Symlink avoids retaining model bytes after a process crash/cache deletion.
    if (symlink(source.c_str(), path_.c_str()) != 0) {
      rmdir(directory_.c_str()); directory_.clear();
      throw std::runtime_error("Cannot create ORT model alias.");
    }
  }
  OrtAssetPath(const OrtAssetPath&) = delete;
  OrtAssetPath& operator=(const OrtAssetPath&) = delete;
  ~OrtAssetPath() {
    if (!directory_.empty()) { unlink(path_.c_str()); rmdir(directory_.c_str()); }
  }
  const std::string& path() const { return path_; }
 private:
  std::string directory_, path_;
};
}  // namespace wfloat_next
