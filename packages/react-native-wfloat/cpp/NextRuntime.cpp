#include "NextRuntime.h"
#include "Backend.h"
#include <chrono>
#include <mutex>
#include <unordered_map>

namespace wfloat_next {
struct Runtime::Impl {
  struct Slot {
    std::timed_mutex mutex;
    std::unique_ptr<Backend> backend;
    bool unloaded = false;
  };
  std::mutex mutex;
  std::unordered_map<std::string, std::shared_ptr<Slot>> models;
};
Runtime::Runtime() : impl_(new Impl) {}
Runtime::~Runtime() = default;
std::string Runtime::request(const std::string& command, Emit emit, Cancel cancelled) {
  const auto j = Json::parse(command);
  const auto op = j.at("op").get<std::string>();
  const auto id = j.at("instanceId").get<std::string>();
  if (id.empty()) throw std::invalid_argument("instanceId must not be empty.");
  checkCancelled(cancelled);
  std::shared_ptr<Impl::Slot> slot;
  if (op == "load") {
    slot = std::make_shared<Impl::Slot>();
    std::unique_lock<std::timed_mutex> work(slot->mutex);
    {
      std::lock_guard<std::mutex> lock(impl_->mutex);
      if (!impl_->models.emplace(id, slot).second) throw std::invalid_argument("instanceId is already loaded or loading.");
    }
    try {
      auto task = j.at("task").get<std::string>();
      if (task == "llm") slot->backend = makeLlm(j, cancelled);
      else if (task == "tts" || task == "stt" || task == "vad") slot->backend = makeSpeech(j, cancelled);
      else throw std::invalid_argument("Unknown inference task: " + task);
      checkCancelled(cancelled);
      return slot->backend->info().dump();
    } catch (...) {
      slot->unloaded = true;
      slot->backend.reset();
      std::lock_guard<std::mutex> lock(impl_->mutex);
      impl_->models.erase(id);
      throw;
    }
  }
  {
    std::lock_guard<std::mutex> lock(impl_->mutex);
    auto it = impl_->models.find(id);
    if (it == impl_->models.end()) throw std::invalid_argument("Unknown instanceId: " + id);
    slot = it->second;
  }
  std::unique_lock<std::timed_mutex> work(slot->mutex, std::defer_lock);
  while (!work.try_lock_for(std::chrono::milliseconds(10))) checkCancelled(cancelled);
  checkCancelled(cancelled);
  if (slot->unloaded || !slot->backend) throw std::invalid_argument("Instance has been unloaded: " + id);
  if (op == "unload") {
    slot->unloaded = true;
    slot->backend.reset();
    std::lock_guard<std::mutex> lock(impl_->mutex);
    impl_->models.erase(id);
    return "null";
  }
  return slot->backend->request(j, emit, cancelled).dump();
}
}
