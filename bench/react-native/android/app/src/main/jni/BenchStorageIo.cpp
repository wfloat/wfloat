#include <jni.h>
#include "StorageIo.h"
static bench::StorageIoCheck check;
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_bench_BenchStorageIoNative_read(JNIEnv *env, jobject) {
  try { return env->NewStringUTF(bench::storageIoSnapshot().json().c_str()); }
  catch (const std::exception &error) { env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what()); return nullptr; }
}
extern "C" JNIEXPORT jlong JNICALL
Java_com_wfloat_bench_BenchStorageIoNative_token(JNIEnv *, jobject) { return check.token(); }
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_bench_BenchStorageIoNative_cancel(JNIEnv *, jobject) { check.cancel(); }
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_bench_BenchStorageIoNative_run(JNIEnv *env, jobject, jstring directory, jlong token, jboolean reduceCaching) {
  const char *path = env->GetStringUTFChars(directory, nullptr);
  if (!path) return nullptr;
  try {
    const std::string cacheDirectory(path);
    env->ReleaseStringUTFChars(directory, path); path = nullptr;
    return env->NewStringUTF(check.run(cacheDirectory, token, reduceCaching == JNI_TRUE).json().c_str());
  } catch (const std::exception &error) {
    if (path) env->ReleaseStringUTFChars(directory, path);
    env->ThrowNew(env->FindClass("java/lang/IllegalStateException"), error.what()); return nullptr;
  }
}
