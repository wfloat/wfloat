#pragma once
#include <atomic>
#include <chrono>
#include <cstdint>
#include <mutex>
#include <stdexcept>
#include <thread>

namespace bench {
struct WaitWakeSnapshot { bool running; uint64_t wakes, runSequence; double elapsedMs; };
class WaitWakeProbe {
  std::atomic<uint64_t> generation_{0}, wakes_{0}, runSequence_{0};
  std::atomic<bool> running_{false};
  std::atomic<double> elapsedMs_{0};
  std::mutex mutex_;
  std::thread worker_;
public:
  uint64_t token() const { return generation_.load(); }
  void cancel() { generation_.fetch_add(1); }
  void start(uint64_t token, int budgetMs = 10000) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (budgetMs < 1 || budgetMs > 10000) throw std::runtime_error("Invalid wait/wake budget");
    if (token != generation_.load()) throw std::runtime_error("Wait/wake check was cancelled");
    if (running_.load()) throw std::runtime_error("Wait/wake check is already running");
    if (worker_.joinable()) worker_.join();
    wakes_.store(0); elapsedMs_.store(0); runSequence_.fetch_add(1); running_.store(true);
    try {
      worker_ = std::thread([this, token, budgetMs] {
        const auto started = std::chrono::steady_clock::now();
        while (token == generation_.load()) {
          const double elapsed = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count();
          elapsedMs_.store(elapsed);
          if (elapsed >= budgetMs) break;
          std::this_thread::sleep_for(std::chrono::milliseconds(1));
          wakes_.fetch_add(1);
        }
        elapsedMs_.store(std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - started).count());
        running_.store(false);
      });
    } catch (...) { running_.store(false); throw; }
  }
  WaitWakeSnapshot snapshot() const {
    return {running_.load(), wakes_.load(), runSequence_.load(), elapsedMs_.load()};
  }
  ~WaitWakeProbe() { cancel(); if (worker_.joinable()) worker_.join(); }
};
} // namespace bench
