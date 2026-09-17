#include <jni.h>
#include "ContextSwitchCounters.h"
#include "WaitWakeProbe.h"

namespace { bench::WaitWakeProbe probe; }
extern "C" JNIEXPORT jlongArray JNICALL
Java_com_wfloat_bench_BenchContextSwitchesNative_read(JNIEnv *env, jobject) {
  try {
    const auto counters = bench::readContextSwitchCounters();
    const jlong values[] = {counters.total, counters.voluntary, counters.involuntary};
    auto result = env->NewLongArray(3);
    if (result) env->SetLongArrayRegion(result, 0, 3, values);
    return result;
  } catch (const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what()); return nullptr;
  }
}
extern "C" JNIEXPORT jdoubleArray JNICALL
Java_com_wfloat_bench_BenchContextSwitchesNative_probeState(JNIEnv *env, jobject) {
  const auto s = probe.snapshot();
  const jdouble values[] = {s.running ? 1.0 : 0.0, static_cast<double>(s.wakes), s.elapsedMs, static_cast<double>(s.runSequence)};
  auto result = env->NewDoubleArray(4);
  if (result) env->SetDoubleArrayRegion(result, 0, 4, values);
  return result;
}
extern "C" JNIEXPORT jlong JNICALL
Java_com_wfloat_bench_BenchContextSwitchesNative_token(JNIEnv *, jobject) { return probe.token(); }
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchContextSwitchesNative_start(JNIEnv *env, jobject, jlong token) {
  try { probe.start(token); }
  catch (const std::exception &error) { env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what()); }
}
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchContextSwitchesNative_cancel(JNIEnv *, jobject) { probe.cancel(); }
