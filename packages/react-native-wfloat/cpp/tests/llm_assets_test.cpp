#include "LlmAssets.h"
#include <iostream>
using namespace wfloat_next;
int main() {
  auto check = [](bool ok) { if (!ok) throw std::runtime_error("Shard contract failed"); };
  Json paths = {{"model_shard_00002", "/cache/b"}, {"model_shard_00001", "/cache/a"}, {"model_terms", "/cache/terms"}};
  check(llmModelPaths({{"paths", paths}}) == std::vector<std::string>({"/cache/a", "/cache/b"}));
  check(llmModelPaths({{"paths", {{"model", "/single"}}}}) == std::vector<std::string>({"/single"}));
  // Qwen 1.7B/4B use three/six opaque cache files, not canonical basenames.
  for (const int count : {3, 6}) {
    Json shards = {{"model_license", "/cache/license"}, {"model_notice", "/cache/notice"}};
    std::vector<std::string> expected;
    for (int i = 1; i <= count; ++i) {
      const auto path = "/cache/opaque-" + std::to_string(i);
      shards["model_shard_0000" + std::to_string(i)] = path;
      expected.push_back(path);
    }
    check(llmModelPaths({{"paths", shards}}) == expected);
  }
  auto rejects = [&](Json bad) { bool rejected = false; try { llmModelPaths({{"paths", bad}}); } catch (const std::exception&) { rejected = true; } check(rejected); };
  auto bad = paths; bad.erase("model_shard_00001"); rejects(bad);
  bad = paths; bad.erase("model_shard_00002"); rejects(bad);
  bad = paths; bad["model_shard_00004"] = "/cache/d"; rejects(bad);
  bad = paths; bad["model_shard_1"] = "/cache/d"; rejects(bad);
  bad = paths; bad["model_shard_00002"] = "/cache/a"; rejects(bad);
  bad = paths; bad["model_shard_00002"] = "relative"; rejects(bad);
  bad = paths; bad["model"] = "/single"; rejects(bad);
  std::cout << "PASS ordered opaque shards, gaps, missing, malformed, duplicate, relative, mixed roles\n";
}
