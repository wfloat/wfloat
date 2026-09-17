#include <jni.h>
#include "ResidentMemory.h"

extern "C" JNIEXPORT jlong JNICALL
Java_com_wfloat_bench_BenchMemoryNative_create(JNIEnv *env, jobject) {
  try { return reinterpret_cast<jlong>(new bench::MemoryProbe()); }
  catch (const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
    return 0;
  }
}
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchMemoryNative_destroy(JNIEnv *, jobject, jlong handle) {
  delete reinterpret_cast<bench::MemoryProbe *>(handle);
}
extern "C" JNIEXPORT jlong JNICALL
Java_com_wfloat_bench_BenchMemoryNative_heldBytes(JNIEnv *, jobject, jlong handle) {
  return reinterpret_cast<bench::MemoryProbe *>(handle)->heldBytes();
}
extern "C" JNIEXPORT jlong JNICALL
Java_com_wfloat_bench_BenchMemoryNative_heldFileBytes(JNIEnv *, jobject, jlong handle) {
  return reinterpret_cast<bench::MemoryProbe *>(handle)->heldFileBytes();
}
extern "C" JNIEXPORT jlong JNICALL
Java_com_wfloat_bench_BenchMemoryNative_heldSharedRegionBytes(JNIEnv *, jobject, jlong handle) {
  return reinterpret_cast<bench::MemoryProbe *>(handle)->heldSharedRegionBytes();
}
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchMemoryNative_releaseSecondMapping(JNIEnv *env, jobject, jlong handle) {
  try { reinterpret_cast<bench::MemoryProbe *>(handle)->releaseSecondMapping(); }
  catch (const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
  }
}
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchMemoryNative_hold(JNIEnv *env, jobject, jlong handle) {
  try { reinterpret_cast<bench::MemoryProbe *>(handle)->hold(); }
  catch (const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
  }
}
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchMemoryNative_holdSharedDirty(JNIEnv *env, jobject, jlong handle) {
  try { reinterpret_cast<bench::MemoryProbe *>(handle)->holdSharedDirty(); }
  catch (const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
  }
}
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchMemoryNative_release(JNIEnv *, jobject, jlong handle) {
  reinterpret_cast<bench::MemoryProbe *>(handle)->release();
}
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_bench_BenchMemoryNative_kind(JNIEnv *env, jobject, jlong handle) {
  return env->NewStringUTF(reinterpret_cast<bench::MemoryProbe *>(handle)->kind());
}
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchMemoryNative_holdClean(JNIEnv *env, jobject, jlong handle, jstring directory) {
  const char *path = env->GetStringUTFChars(directory, nullptr);
  if (!path) return;
  try { reinterpret_cast<bench::MemoryProbe *>(handle)->holdClean(path); }
  catch (const std::exception &error) {
    env->ReleaseStringUTFChars(directory, path);
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
    return;
  }
  env->ReleaseStringUTFChars(directory, path);
}
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchMemoryNative_holdSharedClean(JNIEnv *env, jobject, jlong handle, jstring directory) {
  const char *path = env->GetStringUTFChars(directory, nullptr);
  if (!path) return;
  try { reinterpret_cast<bench::MemoryProbe *>(handle)->holdClean(path, true); }
  catch (const std::exception &error) {
    env->ReleaseStringUTFChars(directory, path);
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
    return;
  }
  env->ReleaseStringUTFChars(directory, path);
}
extern "C" JNIEXPORT jobject JNICALL
Java_com_wfloat_bench_BenchMemoryNative_read(JNIEnv *env, jobject) {
  try {
    const auto reading = bench::readResidentMemory();
    auto type = env->FindClass("java/util/HashMap");
    if (!type) return nullptr;
    auto ctor = env->GetMethodID(type, "<init>", "()V");
    auto put = env->GetMethodID(type, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");
    if (!ctor || !put) return nullptr;
    auto values = env->NewObject(type, ctor);
    if (!values) return nullptr;
    auto field = [&](const char *key, const std::string &value) {
      if (env->ExceptionCheck()) return;
      auto k = env->NewStringUTF(key), v = env->NewStringUTF(value.c_str());
      if (k && v) { auto previous = env->CallObjectMethod(values, put, k, v); if (previous) env->DeleteLocalRef(previous); }
      if (k) env->DeleteLocalRef(k);
      if (v) env->DeleteLocalRef(v);
    };
    field("rss.bytes", std::to_string(reading.bytes));
    field("rss.source", reading.source);
    field("pss.raw", reading.pss.bytes ? std::to_string(*reading.pss.bytes) : "");
    field("pss.source", reading.pss.source);
    field("pss.error", reading.pss.error);
    field("peakRss.raw", reading.peakRss.bytes ? std::to_string(*reading.peakRss.bytes) : "");
    field("peakRss.source", reading.peakRss.source);
    field("peakRss.error", reading.peakRss.error);
    field("privateDirty.raw", reading.privateDirty.bytes ? std::to_string(*reading.privateDirty.bytes) : "");
    field("privateDirty.source", reading.privateDirty.source);
    field("privateDirty.error", reading.privateDirty.error);
    field("privateClean.raw", reading.privateClean.bytes ? std::to_string(*reading.privateClean.bytes) : "");
    field("privateClean.source", reading.privateClean.source);
    field("privateClean.error", reading.privateClean.error);
    field("sharedClean.raw", reading.sharedClean.bytes ? std::to_string(*reading.sharedClean.bytes) : "");
    field("sharedClean.source", reading.sharedClean.source);
    field("sharedClean.error", reading.sharedClean.error);
    field("sharedDirty.raw", reading.sharedDirty.bytes ? std::to_string(*reading.sharedDirty.bytes) : "");
    field("sharedDirty.source", reading.sharedDirty.source);
    field("sharedDirty.error", reading.sharedDirty.error);
    field("swapPss.raw", reading.swapPss.bytes ? std::to_string(*reading.swapPss.bytes) : "");
    field("swapPss.source", reading.swapPss.source);
    field("swapPss.error", reading.swapPss.error);
    field("anonymous.raw", reading.anonymous.bytes ? std::to_string(*reading.anonymous.bytes) : "");
    field("anonymous.source", reading.anonymous.source);
    field("anonymous.error", reading.anonymous.error);
    field("pageTables.raw", reading.pageTables.bytes ? std::to_string(*reading.pageTables.bytes) : "");
    field("pageTables.source", reading.pageTables.source);
    field("pageTables.error", reading.pageTables.error);
    field("virtualSize.raw", reading.virtualSize.bytes ? std::to_string(*reading.virtualSize.bytes) : "");
    field("virtualSize.source", reading.virtualSize.source);
    field("virtualSize.error", reading.virtualSize.error);
    field("locked.raw", reading.locked.bytes ? std::to_string(*reading.locked.bytes) : "");
    field("locked.source", reading.locked.source);
    field("locked.error", reading.locked.error);
    field("peakVirtual.raw", reading.peakVirtual.bytes ? std::to_string(*reading.peakVirtual.bytes) : "");
    field("peakVirtual.source", reading.peakVirtual.source);
    field("peakVirtual.error", reading.peakVirtual.error);
    field("vmas.raw", reading.vmas.count ? std::to_string(*reading.vmas.count) : "");
    field("vmas.source", reading.vmas.source);
    field("vmas.error", reading.vmas.error);
    field("anonymousPss.raw", reading.anonymousPss.bytes ? std::to_string(*reading.anonymousPss.bytes) : "");
    field("anonymousPss.source", reading.anonymousPss.source);
    field("anonymousPss.error", reading.anonymousPss.error);
    field("filePss.raw", reading.filePss.bytes ? std::to_string(*reading.filePss.bytes) : "");
    field("filePss.source", reading.filePss.source);
    field("filePss.error", reading.filePss.error);
    field("shmemPss.raw", reading.shmemPss.bytes ? std::to_string(*reading.shmemPss.bytes) : "");
    field("shmemPss.source", reading.shmemPss.source);
    field("shmemPss.error", reading.shmemPss.error);
    field("dirtyPss.raw", reading.dirtyPss.bytes ? std::to_string(*reading.dirtyPss.bytes) : "");
    field("dirtyPss.source", reading.dirtyPss.source);
    field("dirtyPss.error", reading.dirtyPss.error);
    field("referenced.raw", reading.referenced.bytes ? std::to_string(*reading.referenced.bytes) : "");
    field("referenced.source", reading.referenced.source);
    field("referenced.error", reading.referenced.error);
    field("swap.raw", reading.swap.bytes ? std::to_string(*reading.swap.bytes) : "");
    field("swap.source", reading.swap.source);
    field("swap.error", reading.swap.error);
    field("lazyFree.raw", reading.lazyFree.bytes ? std::to_string(*reading.lazyFree.bytes) : "");
    field("lazyFree.source", reading.lazyFree.source);
    field("lazyFree.error", reading.lazyFree.error);
    field("anonHugePages.raw", reading.anonHugePages.bytes ? std::to_string(*reading.anonHugePages.bytes) : "");
    field("anonHugePages.source", reading.anonHugePages.source);
    field("anonHugePages.error", reading.anonHugePages.error);
    field("filePmdMapped.raw", reading.filePmdMapped.bytes ? std::to_string(*reading.filePmdMapped.bytes) : "");
    field("filePmdMapped.source", reading.filePmdMapped.source);
    field("filePmdMapped.error", reading.filePmdMapped.error);
    field("shmemPmdMapped.raw", reading.shmemPmdMapped.bytes ? std::to_string(*reading.shmemPmdMapped.bytes) : "");
    field("shmemPmdMapped.source", reading.shmemPmdMapped.source);
    field("shmemPmdMapped.error", reading.shmemPmdMapped.error);
    field("privateHugetlb.raw", reading.privateHugetlb.bytes ? std::to_string(*reading.privateHugetlb.bytes) : "");
    field("privateHugetlb.source", reading.privateHugetlb.source);
    field("privateHugetlb.error", reading.privateHugetlb.error);
    field("sharedHugetlb.raw", reading.sharedHugetlb.bytes ? std::to_string(*reading.sharedHugetlb.bytes) : "");
    field("sharedHugetlb.source", reading.sharedHugetlb.source);
    field("sharedHugetlb.error", reading.sharedHugetlb.error);
    field("ksm.raw", reading.ksm.bytes ? std::to_string(*reading.ksm.bytes) : "");
    field("ksm.source", reading.ksm.source);
    field("ksm.error", reading.ksm.error);
    field("lockedResident.raw", reading.lockedResident.bytes ? std::to_string(*reading.lockedResident.bytes) : "");
    field("lockedResident.source", reading.lockedResident.source);
    field("lockedResident.error", reading.lockedResident.error);
    return env->ExceptionCheck() ? nullptr : values;
  } catch (const std::exception &error) {
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what());
    return nullptr;
  }
}

#include "AndroidMallocCheck.h"
using NativeMallocStorage = bench::AndroidMallocStorage<>;
extern "C" JNIEXPORT jlong JNICALL
Java_com_wfloat_bench_BenchMemoryNative_mallocCreate(JNIEnv *env, jobject) {
  try { return reinterpret_cast<jlong>(new NativeMallocStorage()); }
  catch(const std::exception &e) { env->ThrowNew(env->FindClass("java/lang/IllegalStateException"),e.what());return 0; }
}
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchMemoryNative_mallocDestroy(JNIEnv *, jobject, jlong handle) {
  delete reinterpret_cast<NativeMallocStorage *>(handle);
}
extern "C" JNIEXPORT jlong JNICALL
Java_com_wfloat_bench_BenchMemoryNative_mallocHeldBytes(JNIEnv *, jobject, jlong handle) {
  return reinterpret_cast<NativeMallocStorage *>(handle)->heldBytes();
}
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchMemoryNative_mallocStep(JNIEnv *env, jobject, jlong handle, jint op, jobject guard) {
  jclass type=env->GetObjectClass(guard);
  jmethodID active=env->GetMethodID(type,"isActive","()Z");
  if(!active) return;
  try {
    reinterpret_cast<NativeMallocStorage *>(handle)->step(op,[&] {
      const auto result=env->CallBooleanMethod(guard,active);
      if(env->ExceptionCheck()) return false;
      return result==JNI_TRUE;
    });
  } catch(const std::exception &e) {
    if(!env->ExceptionCheck()) env->ThrowNew(env->FindClass("java/lang/IllegalStateException"),e.what());
  }
}
