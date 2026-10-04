#include <jni.h>
#include <codecvt>
#include <locale>
#include <stdexcept>
#include <string>
#include "NextRuntime.h"

namespace {
std::string utf8(JNIEnv* env, jstring value) {
  const auto* chars = env->GetStringChars(value, nullptr);
  if (!chars) throw std::runtime_error("Cannot read Java string");
  std::u16string text(reinterpret_cast<const char16_t*>(chars), env->GetStringLength(value));
  env->ReleaseStringChars(value, chars);
  return std::wstring_convert<std::codecvt_utf8_utf16<char16_t>, char16_t>().to_bytes(text);
}
jstring javaString(JNIEnv* env, const std::string& value) {
  auto text = std::wstring_convert<std::codecvt_utf8_utf16<char16_t>, char16_t>().from_bytes(value);
  return env->NewString(reinterpret_cast<const jchar*>(text.data()), static_cast<jsize>(text.size()));
}
void reject(JNIEnv* env, const char* message) {
  if (env->ExceptionCheck()) return;
  auto type = env->FindClass("java/lang/IllegalStateException");
  env->ThrowNew(type, message);
  env->DeleteLocalRef(type);
}
// Runtime callbacks are synchronous on the requesting worker per NextRuntime.h.
}
extern "C" JNIEXPORT jlong JNICALL
Java_com_wfloat_WfloatNextModule_nativeCreate(JNIEnv* env, jobject) {
  try { return reinterpret_cast<jlong>(new wfloat_next::Runtime()); }
  catch (const std::exception& e) { reject(env, e.what()); return 0; }
}
extern "C" JNIEXPORT void JNICALL
Java_com_wfloat_WfloatNextModule_nativeDestroy(JNIEnv*, jobject, jlong handle) {
  delete reinterpret_cast<wfloat_next::Runtime*>(handle);
}
extern "C" JNIEXPORT jstring JNICALL
Java_com_wfloat_WfloatNextModule_nativeRequest(JNIEnv* env, jobject module, jlong handle,
                                              jstring command, jstring requestId, jobject cancelled) {
  try {
    if (!handle) throw std::invalid_argument("Runtime is closed");
    auto type = env->GetObjectClass(module);
    auto event = env->GetMethodID(type, "nativeEvent", "(Ljava/lang/String;Ljava/lang/String;)V");
    env->DeleteLocalRef(type);
    auto atomicType = env->GetObjectClass(cancelled);
    auto get = env->GetMethodID(atomicType, "get", "()Z");
    env->DeleteLocalRef(atomicType);
    if (!event || !get) throw std::runtime_error("JNI callback lookup failed");
    const auto result = reinterpret_cast<wfloat_next::Runtime*>(handle)->request(utf8(env, command),
      [&](const std::string& payload) {
        auto text = javaString(env, payload);
        if (!text) throw std::runtime_error("Cannot allocate native event");
        env->CallVoidMethod(module, event, requestId, text);
        env->DeleteLocalRef(text);
        if (env->ExceptionCheck()) throw std::runtime_error("Native event delivery failed");
      },
      [&]() {
        const bool result = env->CallBooleanMethod(cancelled, get);
        return result || env->ExceptionCheck();
      });
    return javaString(env, result);
  } catch (const std::exception& e) { reject(env, e.what()); return nullptr; }
  catch (...) { reject(env, "Unknown common runtime failure"); return nullptr; }
}
