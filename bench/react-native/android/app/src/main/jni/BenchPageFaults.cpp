#include <jni.h>
#include <sys/resource.h>
#include <unistd.h>
#include <cerrno>
#include <cstdint>
#include <stdexcept>
#include <system_error>
#include "FileFaultProbe.h"

static bench::FileFaultProbe fileProbe;

extern "C" JNIEXPORT jlongArray JNICALL
Java_com_wfloat_bench_BenchPageFaultsNative_read(JNIEnv *env, jobject) {
  try {
    const auto usage = bench::readPageFaultCounters();
    const auto pageBytes = sysconf(_SC_PAGESIZE);
    if (pageBytes <= 0) throw std::runtime_error("Invalid system page size");
    const jlong fields[] = {usage.first, usage.second, pageBytes};
    auto result = env->NewLongArray(3);
    if (result) env->SetLongArrayRegion(result, 0, 3, fields);
    return result;
  } catch (const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
    return nullptr;
  }
}

extern "C" JNIEXPORT jlong JNICALL
Java_com_wfloat_bench_BenchFileFaultProbeNative_token(JNIEnv *, jobject) { return fileProbe.token(); }
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchFileFaultProbeNative_cancel(JNIEnv *, jobject) { fileProbe.cancel(); }
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_bench_BenchFileFaultProbeNative_run(JNIEnv *env, jobject, jstring directory, jlong token) {
  const char *path = env->GetStringUTFChars(directory, nullptr);
  if (!path) return nullptr;
  try {
    const std::string cacheDirectory(path);
    env->ReleaseStringUTFChars(directory, path);
    path = nullptr;
    const auto result = fileProbe.run(cacheDirectory, token);
    return env->NewStringUTF(result.json().c_str());
  } catch (const std::exception &error) {
    if (path) env->ReleaseStringUTFChars(directory, path);
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
    return nullptr;
  }
}
