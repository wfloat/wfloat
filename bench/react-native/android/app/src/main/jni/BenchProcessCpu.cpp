#include <jni.h>
#include "ProcessCpuCounters.h"

extern "C" JNIEXPORT jlongArray JNICALL
Java_com_wfloat_bench_BenchProcessCpuNative_read(JNIEnv *env, jobject) {
  try {
    const auto usage = bench::readProcessCpuCounters();
    const jlong values[] = {usage.userUs, usage.systemUs};
    auto result = env->NewLongArray(2);
    if (result) env->SetLongArrayRegion(result, 0, 2, values);
    return result;
  } catch (const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
    return nullptr;
  }
}
