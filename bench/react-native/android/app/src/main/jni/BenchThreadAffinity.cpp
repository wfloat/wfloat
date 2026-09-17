#include <jni.h>
#include <sched.h>
#include <cerrno>

// errno followed by CPU IDs. Linux rejects undersized buffers; never truncate
// a successful mask or substitute the stored status mask on failure.
extern "C" JNIEXPORT jintArray JNICALL
Java_com_wfloat_bench_BenchThreadAffinityNative_read(JNIEnv *env, jobject, jint tid) {
  constexpr int capacity = 1024;
  const size_t bytes = CPU_ALLOC_SIZE(capacity);
  jint fields[capacity + 1]; int count = 1;
  if (tid <= 0) fields[0] = EINVAL;
  else {
    // Bionic's default cpu_set_t is smaller on 32-bit ABIs. Explicit allocation
    // keeps the declared 1024-bit capacity identical on all supported ABIs.
    cpu_set_t *mask = CPU_ALLOC(capacity);
    if (!mask) fields[0] = ENOMEM;
    else {
      CPU_ZERO_S(bytes, mask);
      if (sched_getaffinity(tid, bytes, mask) != 0) fields[0] = errno;
      else {
        fields[0] = 0;
        for (int cpu = 0; cpu < capacity; ++cpu)
          if (CPU_ISSET_S(cpu, bytes, mask)) fields[count++] = cpu;
      }
      CPU_FREE(mask);
    }
  }
  auto result = env->NewIntArray(count);
  if (result) env->SetIntArrayRegion(result, 0, count, fields);
  return result;
}

#include "../../../../../cpp/SourceCapture.h"
extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_wfloat_bench_BenchThreadCaptureNative_append(JNIEnv *env, jobject, jstring directory, jbyteArray json) {
  static bench::SourceCapture capture;
  const char *dir = env->GetStringUTFChars(directory, nullptr);
  if (!dir) return nullptr;
  auto *record = env->GetByteArrayElements(json, nullptr);
  if (!record) { env->ReleaseStringUTFChars(directory, dir); return nullptr; }
  struct Release {
    JNIEnv *env; jstring directory; const char *dir; jbyteArray json; jbyte *record;
    ~Release() { env->ReleaseStringUTFChars(directory, dir); env->ReleaseByteArrayElements(json, record, JNI_ABORT); }
  } release{env, directory, dir, json, record};
  try {
    const auto status = capture.append(dir, std::string(reinterpret_cast<const char *>(record), env->GetArrayLength(json))), path = capture.filePath();
    auto result = env->NewObjectArray(2, env->FindClass("java/lang/String"), nullptr);
    if (!result) return nullptr;
    for (int i = 0; i < 2; ++i) {
      auto value = env->NewStringUTF((i == 0 ? status : path).c_str());
      if (!value) return nullptr;
      env->SetObjectArrayElement(result, i, value); env->DeleteLocalRef(value);
    }
    return result;
  } catch (const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
    return nullptr;
  }
}
