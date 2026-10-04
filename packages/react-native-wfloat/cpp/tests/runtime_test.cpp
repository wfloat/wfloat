#include "NextRuntime.h"
#include "Backend.h"
#include <atomic>
#include <chrono>
#include <future>
#include <iostream>
#include <thread>
using namespace wfloat_next;
using namespace std::chrono_literals;
namespace {
void require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
std::atomic<int> alive{0};
std::atomic<bool> entered{false}, releaseWork{false};
struct Fake : Backend {
  int counter = 0;
  Fake() { ++alive; }
  ~Fake() { --alive; }
  Json info() const override { return {{"kind", "fake"}}; }
  Json request(const Json& j, const Emit&, const Cancel& cancel) override {
    if (j.at("op") == "hold") {
      entered = true;
      while (!releaseWork) { checkCancelled(cancel); std::this_thread::yield(); }
    }
    return ++counter;
  }
};
template<class F> void rejects(F f) { bool caught = false; try { f(); } catch (const std::exception&) { caught = true; } require(caught, "Expected rejection"); }
Json cmd(const char* op, const char* id) { return {{"op", op}, {"instanceId", id}}; }
std::string call(Runtime& r, const char* op, const char* id, Cancel cancel = {}) { return r.request(cmd(op,id).dump(), {}, cancel); }
void load(Runtime& r, const char* id) { auto j = cmd("load", id); j["task"] = "stt"; r.request(j.dump()); }
}
namespace wfloat_next {
std::unique_ptr<Backend> makeSpeech(const Json& j, const Cancel&) {
  if (j.at("instanceId") == "fail") throw std::runtime_error("Deliberate load failure");
  return std::make_unique<Fake>();
}
std::unique_ptr<Backend> makeLlm(const Json& j, const Cancel& c) { return makeSpeech(j,c); }
}
int main() {
  try {
    {
      Runtime r;
      rejects([&]{ call(r,"next","unknown"); });
      rejects([&]{ r.request("not JSON"); });
      rejects([&]{ load(r, ""); });
      rejects([&]{ load(r, "fail"); });
      rejects([&]{ load(r, "fail"); }); // failed reservation removed
      load(r,"a"); load(r,"b");
      rejects([&]{ load(r,"a"); });
      require(alive == 2, "Independent handles were not created");
      require(call(r,"next","a") == "1" && call(r,"next","b") == "1", "Models shared mutable state");
      auto busy = std::async(std::launch::async, [&]{ return call(r,"hold","a"); });
      while (!entered) std::this_thread::yield();
      auto independent = std::async(std::launch::async, [&]{ return call(r,"next","b"); });
      require(independent.wait_for(1s) == std::future_status::ready, "Registry mutex serialized independent models");
      require(independent.get() == "2", "Independent counter mismatch");
      std::atomic<bool> cancelled{false};
      auto waiting = std::async(std::launch::async, [&]{ rejects([&]{ call(r,"next","a",[&]{return cancelled.load();}); }); });
      cancelled = true;
      require(waiting.wait_for(1s) == std::future_status::ready, "Queued cancellation blocked on model mutex"); waiting.get();
      auto unload = std::async(std::launch::async, [&]{ return call(r,"unload","a"); });
      require(unload.wait_for(30ms) == std::future_status::timeout, "Unload raced active inference");
      releaseWork = true; busy.get(); require(unload.get() == "null", "Unload return shape");
      require(alive == 1, "Unload did not destroy handle");
      rejects([&]{ call(r,"next","a"); });
      load(r,"a"); require(call(r,"next","a") == "1", "Reload retained old model state");
      // Contended calls on one handle cannot lose increments.
      std::vector<std::future<void>> jobs;
      for (int i=0;i<8;++i) jobs.push_back(std::async(std::launch::async,[&]{ for(int n=0;n<100;++n) call(r,"next","a"); }));
      for(auto& job:jobs) job.get();
      require(call(r,"next","a") == "802", "Same-model requests were not serialized");
    }
    require(alive == 0, "Runtime destructor leaked models");
    std::cout << "PASS independent ownership, per-model serialization, queued cancellation, unload race, rollback, reload, teardown\n";
  } catch(const std::exception& e) { std::cerr << e.what() << '\n'; return 1; }
}
