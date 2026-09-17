#include <jni.h>
#include "FileDescriptors.h"

extern "C" JNIEXPORT jintArray JNICALL
Java_com_wfloat_bench_BenchFileDescriptorsNative_read(JNIEnv *env, jobject) {
  try {
    const auto reading = bench::readFileDescriptors();
    const jint fields[] = {reading.count, reading.collectorDescriptor};
    auto values = env->NewIntArray(2);
    if (values) env->SetIntArrayRegion(values, 0, 2, fields);
    return values;
  } catch (const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
    return nullptr;
  }
}
