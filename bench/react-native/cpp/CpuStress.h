#pragma once

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
#if defined(__aarch64__)
#include <arm_neon.h>
#endif

namespace bench {
using Clock = std::chrono::steady_clock;
inline int64_t monotonicMs() {
  return std::chrono::duration_cast<std::chrono::milliseconds>(
      Clock::now().time_since_epoch()).count();
}

// A small register-resident working set keeps arithmetic units busy. Results
// escape into the run checksum, so an optimizing compiler must retain the work.
inline double arithmeticBlock(double seed) {
#if defined(__aarch64__)
  const auto multiplier = vdupq_n_f32(0.9999f);
  const auto addend = vdupq_n_f32(0.0001f);
  auto a = vdupq_n_f32(static_cast<float>(seed));
  auto b = vdupq_n_f32(static_cast<float>(seed + .1));
  auto c = vdupq_n_f32(static_cast<float>(seed + .2));
  auto d = vdupq_n_f32(static_cast<float>(seed + .3));
  auto e = vdupq_n_f32(static_cast<float>(seed + .4));
  auto f = vdupq_n_f32(static_cast<float>(seed + .5));
  auto g = vdupq_n_f32(static_cast<float>(seed + .6));
  auto h = vdupq_n_f32(static_cast<float>(seed + .7));
  for (int i = 0; i < 4096; ++i) {
    a = vfmaq_f32(addend, a, multiplier);
    b = vfmaq_f32(addend, b, multiplier);
    c = vfmaq_f32(addend, c, multiplier);
    d = vfmaq_f32(addend, d, multiplier);
    e = vfmaq_f32(addend, e, multiplier);
    f = vfmaq_f32(addend, f, multiplier);
    g = vfmaq_f32(addend, g, multiplier);
    h = vfmaq_f32(addend, h, multiplier);
  }
  return vaddvq_f32(vaddq_f32(vaddq_f32(a, b), vaddq_f32(c, d))) +
      vaddvq_f32(vaddq_f32(vaddq_f32(e, f), vaddq_f32(g, h)));
#else
  float values[32];
  for (int j = 0; j < 32; ++j) values[j] = static_cast<float>(seed + j * .01);
  for (int i = 0; i < 4096; ++i)
    for (auto &value : values) value = value * .9999f + .0001f;
  double sum = 0;
  for (auto value : values) sum += value;
  return sum;
#endif
}

struct StressSnapshot {
  bool running = false;
  bool stopping = false;
  int workers = 0;
  int targetWorkers = 0;
  int64_t elapsedMs = 0;
  uint64_t blocks = 0;
  double checksum = 0;
  std::string reason = "Idle";
};

class CpuStress {
  struct alignas(64) Worker {
    std::atomic<uint64_t> blocks{0};
    std::atomic<double> checksum{0};
  };
  struct Run {
    std::atomic<bool> stop{false}, finished{false};
    std::atomic<int> workers{0};
    std::atomic<int64_t> lastObservation{0}, endedAt{0};
    int target;
    int64_t startedAt, durationMs, rampMs, leaseMs;
    std::mutex reasonMutex;
    std::string reason = "Running";
    std::vector<std::unique_ptr<Worker>> stats;
    Run(int count, int64_t duration, int64_t ramp, int64_t lease)
        : target(count), startedAt(monotonicMs()), durationMs(duration),
          rampMs(ramp), leaseMs(lease) {
      lastObservation = startedAt;
      for (int i = 0; i < count; ++i) stats.emplace_back(new Worker());
    }
    void requestStop(const std::string &why) {
      std::lock_guard<std::mutex> lock(reasonMutex);
      if (stop.load()) return;
      reason = why;
      stop.store(true);
    }
  };
  std::mutex mutex_;
  std::shared_ptr<Run> run_;
  std::thread coordinator_;

 public:
  ~CpuStress() {
    stop("Module closed");
    if (coordinator_.joinable()) coordinator_.join();
  }
  // Shorter ramp/lease values are used only by native lifecycle tests.
  bool start(int count, int64_t durationMs, int64_t rampMs = 10000,
             int64_t leaseMs = 5000,
             std::function<void(const std::atomic<bool>&)> companion = {}) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (run_ && !run_->finished.load()) return false;
    if (count < 1 || count > 64 || durationMs < 1 || durationMs > 600000 ||
        rampMs < 1 || leaseMs < 1) throw std::invalid_argument("Invalid CPU stress limits");
    if (coordinator_.joinable()) coordinator_.join();
    auto run = std::make_shared<Run>(count, durationMs, rampMs, leaseMs);
    run_ = run;
    try {
      coordinator_ = std::thread([run, companion] {
        std::vector<std::thread> threads;
        std::thread companionThread;
        try {
          threads.reserve(run->target);
          if (companion) companionThread = std::thread([run, companion] {
            try {
              companion(run->stop);
              if (!run->stop.load()) run->requestStop("GPU workload ended unexpectedly");
            } catch (...) { run->requestStop("GPU workload failed"); }
          });
          while (!run->stop.load()) {
            const auto now = monotonicMs();
            const auto elapsed = now - run->startedAt;
            if (elapsed >= run->durationMs) { run->requestStop("Time limit reached"); break; }
            if (now - run->lastObservation.load() >= run->leaseMs) {
              run->requestStop("Native thermal monitor stopped responding"); break;
            }
            const int wanted = elapsed < run->rampMs ? std::min(2, run->target) :
                elapsed < 2 * run->rampMs ? std::max(2, (run->target + 1) / 2) : run->target;
            while (static_cast<int>(threads.size()) < std::min(wanted, run->target) && !run->stop.load()) {
              const int index = static_cast<int>(threads.size());
              threads.emplace_back([run, index] {
                auto &stat = *run->stats[index];
                uint64_t blocks = 0;
                while (!run->stop.load()) {
                  const double result = arithmeticBlock(.2 + index * .01 + (blocks % 127) * .001);
                  stat.checksum.store(result, std::memory_order_relaxed);
                  stat.blocks.store(++blocks, std::memory_order_relaxed);
                }
              });
              run->workers.store(static_cast<int>(threads.size()));
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
          }
        } catch (...) { run->requestStop("Could not start CPU workers"); }
        for (auto &thread : threads) if (thread.joinable()) thread.join();
        run->workers.store(0);
        // A run is finished only after both CPU and optional GPU work drains.
        if (companionThread.joinable()) companionThread.join();
        run->endedAt.store(monotonicMs());
        run->finished.store(true);
      });
    } catch (...) {
      run->requestStop("Could not start CPU workers");
      run->endedAt.store(monotonicMs());
      run->finished.store(true);
      throw;
    }
    return true;
  }
  void stop(const std::string &reason) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (run_) run_->requestStop(reason);
  }
  // Called by an independent native monitor, never by the JS rendering loop.
  void observe(int thermalStatus, bool foreground) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!run_ || run_->finished.load()) return;
    run_->lastObservation.store(monotonicMs());
    if (!foreground) run_->requestStop("App moved to the background");
    else if (thermalStatus < 0) run_->requestStop("Thermal reading unavailable");
    else if (thermalStatus > 0)
      run_->requestStop("Thermal state reached native value " + std::to_string(thermalStatus));
  }
  StressSnapshot snapshot() {
    std::lock_guard<std::mutex> lock(mutex_);
    StressSnapshot out;
    if (!run_) return out;
    const bool finished = run_->finished.load();
    out.running = !finished;
    out.stopping = run_->stop.load() && !finished;
    out.workers = run_->workers.load();
    out.targetWorkers = run_->target;
    out.elapsedMs = (finished ? run_->endedAt.load() : monotonicMs()) - run_->startedAt;
    for (const auto &stat : run_->stats) {
      out.blocks += stat->blocks.load(std::memory_order_relaxed);
      out.checksum += stat->checksum.load(std::memory_order_relaxed);
    }
    std::lock_guard<std::mutex> reasonLock(run_->reasonMutex);
    out.reason = run_->reason;
    return out;
  }
};
} // namespace bench
