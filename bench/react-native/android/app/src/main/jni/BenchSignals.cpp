#include <jni.h>
#include <sys/resource.h>
#include <cerrno>
#include "../../../../../cpp/SourceCapture.h"
extern "C" JNIEXPORT jobjectArray JNICALL
Java_com_wfloat_bench_BenchSignalsNative_append(JNIEnv *env, jobject, jstring directory, jbyteArray json) {
  static bench::SourceCapture capture(64*1024*1024, 128*1024*1024, "signals");
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

extern "C" JNIEXPORT jlongArray JNICALL
Java_com_wfloat_bench_BenchSignalsNative_rusage(JNIEnv *env, jobject) {
  struct rusage r{};
  const int code = getrusage(RUSAGE_SELF, &r) == 0 ? 0 : errno;
  const jlong fields[] = {code, r.ru_utime.tv_sec, r.ru_utime.tv_usec,
    r.ru_stime.tv_sec, r.ru_stime.tv_usec, r.ru_maxrss, r.ru_ixrss, r.ru_idrss,
    r.ru_isrss, r.ru_minflt, r.ru_majflt, r.ru_nswap, r.ru_inblock,
    r.ru_oublock, r.ru_msgsnd, r.ru_msgrcv, r.ru_nsignals, r.ru_nvcsw, r.ru_nivcsw};
  auto result = env->NewLongArray(sizeof(fields)/sizeof(fields[0]));
  if (result) env->SetLongArrayRegion(result, 0, sizeof(fields)/sizeof(fields[0]), fields);
  return result;
}

#include "../../../../../cpp/PageStateProbe.h"
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_bench_BenchSignalsNative_pageProbe(JNIEnv *env,jobject) {
  try {return env->NewStringUTF(bench::pageStateProbe().c_str());}
  catch(const std::exception &e){env->ThrowNew(env->FindClass("java/lang/IllegalStateException"),e.what());return nullptr;}
}

#include "../../../../../cpp/AndroidResourceSources.h"
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_bench_BenchSignalsNative_resources(JNIEnv *env,jobject) {
  try {return env->NewStringUTF(bench::androidResourceSources().c_str());}
  catch(const std::exception &e){env->ThrowNew(env->FindClass("java/lang/IllegalStateException"),e.what());return nullptr;}
}

#include "../../../../../cpp/VulkanSignalProbe.h"
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_bench_BenchSignalsNative_gpuProbe(JNIEnv *env,jobject) {
  try {return env->NewStringUTF(bench::vulkanSignalProbe().c_str());}
  catch(const std::exception &e){env->ThrowNew(env->FindClass("java/lang/IllegalStateException"),e.what());return nullptr;}
}

#include "../../../../../cpp/SocketSignalProbe.h"
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_bench_BenchSignalsNative_socketProbe(JNIEnv *env,jobject) {
  try {return env->NewStringUTF(bench::socketSignalProbe().c_str());}
  catch(const std::exception &e){env->ThrowNew(env->FindClass("java/lang/IllegalStateException"),e.what());return nullptr;}
}

#include "../../../../../cpp/PerfEventProbe.h"
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_bench_BenchSignalsNative_perfProbe(JNIEnv *env,jobject) {
  try {return env->NewStringUTF(bench::perfEventProbe().c_str());}
  catch(const std::exception &e){env->ThrowNew(env->FindClass("java/lang/IllegalStateException"),e.what());return nullptr;}
}

#include "../../../../../cpp/SchedulerAttributes.h"
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_bench_BenchSignalsNative_schedulerAttributes(JNIEnv *env,jobject,jint tid) {
  try {return env->NewStringUTF(bench::schedulerAttributes(tid).c_str());}
  catch(const std::exception &e){env->ThrowNew(env->FindClass("java/lang/IllegalStateException"),e.what());return nullptr;}
}

#include "../../../../../cpp/GlesSignalProbe.h"
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_bench_BenchSignalsNative_glesProbe(JNIEnv *env,jobject) {
  try {return env->NewStringUTF(bench::glesSignalProbe().c_str());}
  catch(const std::exception &e){env->ThrowNew(env->FindClass("java/lang/IllegalStateException"),e.what());return nullptr;}
}

#include "../../../../../cpp/DescriptorSources.h"
extern "C" JNIEXPORT jstring JNICALL Java_com_wfloat_bench_BenchSignalsNative_descriptors(JNIEnv *env,jobject) {return env->NewStringUTF(bench::descriptorSources().c_str());}

#include "../../../../../cpp/BpfGpuMemorySource.h"
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_bench_BenchSignalsNative_bpfGpuMemory(JNIEnv *env,jobject) {
  try {return env->NewStringUTF(bench::bpfGpuMemorySource().c_str());}
  catch(const std::exception &e){env->ThrowNew(env->FindClass("java/lang/IllegalStateException"),e.what());return nullptr;}
}

#include "../../../../../cpp/NetlinkSources.h"
extern "C" JNIEXPORT jstring JNICALL Java_com_wfloat_bench_BenchSignalsNative_netlinkInterfaces(JNIEnv *env,jobject,jboolean stats,jboolean extended) {return env->NewStringUTF(bench::netlinkInterfaceSources(stats,extended).c_str());}

#include "../../../../../cpp/EthtoolSources.h"
extern "C" JNIEXPORT jstring JNICALL Java_com_wfloat_bench_BenchSignalsNative_networkDriver(JNIEnv *env,jobject,jstring name) {
  const char *chars=env->GetStringUTFChars(name,nullptr);if(!chars)return nullptr;std::string interfaceName(chars);env->ReleaseStringUTFChars(name,chars);return env->NewStringUTF(bench::ethtoolSources(interfaceName).c_str());
}

#include "../../../../../cpp/KgslCounterSource.h"
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_bench_BenchSignalsNative_kgslCounters(JNIEnv *env,jobject) {
  const auto value=bench::kgslCounterSource();return env->NewStringUTF(value.c_str());
}
