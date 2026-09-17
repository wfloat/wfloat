#include "../cpp/MachThreadCpu.h"
#include <atomic>
#include <cassert>
#include <chrono>
#include <condition_variable>
#include <iostream>
#include <mutex>
#include <pthread.h>
#include <thread>

double now() { return std::chrono::duration<double,std::milli>(std::chrono::steady_clock::now().time_since_epoch()).count(); }
int main() {
 std::atomic<uint64_t> busyId{0},waitId{0}; std::atomic<bool> stop{false};
 std::mutex mutex;std::condition_variable cv;
 std::thread busy([&]{uint64_t id;pthread_threadid_np(nullptr,&id);busyId=id;while(!stop.load()){};});
 std::thread waiting([&]{std::unique_lock<std::mutex> lock(mutex);uint64_t id;pthread_threadid_np(nullptr,&id);waitId=id;cv.wait(lock,[&]{return stop.load();});});
 auto cleanup=[&]{stop=true;{std::lock_guard<std::mutex> lock(mutex);}cv.notify_one();busy.join();waiting.join();};
 auto state=[&](uint64_t id){for(const auto &t:bench::readMachThreadCpu(now).threads)if(t.id==std::to_string(id))return t.runState;throw std::runtime_error("worker missing");};
 auto expect=[&](uint64_t id,int wanted){for(int i=0;i<200;i++){if(state(id)==wanted)return;std::this_thread::sleep_for(std::chrono::milliseconds(5));}throw std::runtime_error("state not observed: wanted="+std::to_string(wanted)+" observed="+std::to_string(state(id)));};
 auto direct=[](thread_t port){thread_basic_info_data_t info{};mach_msg_type_number_t n=THREAD_BASIC_INFO_COUNT;if(thread_info(port,THREAD_BASIC_INFO,reinterpret_cast<thread_info_t>(&info),&n)!=KERN_SUCCESS)throw std::runtime_error("direct read failed");return info;};
 bool suspended=false;const auto busyPort=pthread_mach_thread_np(busy.native_handle());
 try {
  for(int i=0;i<200 && (!busyId||!waitId);i++)std::this_thread::sleep_for(std::chrono::milliseconds(5));
  if(!busyId||!waitId)throw std::runtime_error("workers not ready");
  expect(busyId,TH_STATE_RUNNING);expect(waitId,TH_STATE_WAITING);
  assert(direct(busyPort).run_state==TH_STATE_RUNNING);
  assert(direct(pthread_mach_thread_np(waiting.native_handle())).run_state==TH_STATE_WAITING);
  // Only suspend our atomic-only worker; it never owns a lock.
  if(thread_suspend(busyPort)!=KERN_SUCCESS)throw std::runtime_error("suspend failed");suspended=true;
  const auto suspendedInfo=direct(busyPort);
  assert(suspendedInfo.suspend_count>0);assert(state(busyId)==suspendedInfo.run_state);
  std::cout<<"suspended_worker_run_state="<<suspendedInfo.run_state<<" suspend_count="<<suspendedInfo.suspend_count<<"\n";
  if(thread_resume(busyPort)!=KERN_SUCCESS)throw std::runtime_error("resume failed");suspended=false;
  expect(busyId,TH_STATE_RUNNING);cleanup();
 } catch(...) {if(suspended)thread_resume(busyPort);cleanup();throw;}
 std::cout<<"running=1 waiting=3 resumed=1 direct_thread_info_agrees=true\n";
}
