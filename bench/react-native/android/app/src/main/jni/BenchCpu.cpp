#include <jni.h>
#include <sstream>
#include "CpuStress.h"
#include "GpuStress.h"

static bench::GpuStress gpu;
static bench::CpuStress stress;

static std::string quoted(const std::string &value) {
  std::string out = "\"";
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if (c >= 0x20) out += c;
    else out += ' ';
  }
  return out + '"';
}

extern "C" JNIEXPORT jboolean JNICALL
Java_com_wfloat_bench_BenchCpuNative_start(JNIEnv *env, jobject, jint workers, jlong duration, jboolean withGpu) {
  try {
    if (stress.snapshot().running) return false;
    gpu.reset(withGpu);
    return stress.start(workers, duration, 10000, 5000, withGpu ?
        std::function<void(const std::atomic<bool>&)>([](const auto &stop) { gpu.run(stop); }) : nullptr);
  }
  catch (const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
    return false;
  }
}
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchCpuNative_stop(JNIEnv *, jobject, jint reason) {
  stress.stop(reason == 1 ? "App moved to the background" :
      reason == 2 ? "Module closed" : reason == 3 ? "Thermal state changed" :
      reason == 4 ? "Thermal read failed" : "Stopped by you");
}
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchCpuNative_observe(JNIEnv *, jobject, jint thermal, jboolean foreground) {
  stress.observe(thermal, foreground);
}
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_bench_BenchCpuNative_snapshot(JNIEnv *env, jobject) {
  const auto s = stress.snapshot();
  const auto g = gpu.snapshot();
  std::ostringstream json;
  json << "{\"running\":" << (s.running ? "true" : "false")
       << ",\"stopping\":" << (s.stopping ? "true" : "false")
       << ",\"workers\":" << s.workers << ",\"targetWorkers\":" << s.targetWorkers
       << ",\"elapsedMs\":" << s.elapsedMs << ",\"blocks\":" << s.blocks
       << ",\"checksum\":" << s.checksum << ",\"reason\":" << quoted(s.reason)
       << ",\"gpuEnabled\":" << (g.enabled ? "true" : "false")
       << ",\"gpuActive\":" << (g.active ? "true" : "false")
       << ",\"gpuBatches\":" << g.batches << ",\"gpuChecksum\":" << g.checksum
       << ",\"gpuLastBatchMs\":" << g.lastBatchMs
       << ",\"gpuRenderer\":" << quoted(g.renderer) << ",\"gpuError\":" << quoted(g.error) << "}";
  return env->NewStringUTF(json.str().c_str());
}
