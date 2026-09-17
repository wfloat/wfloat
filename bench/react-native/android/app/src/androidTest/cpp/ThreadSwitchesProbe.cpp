#include <jni.h>
#include <sys/resource.h>
extern "C" JNIEXPORT jlongArray JNICALL
Java_com_wfloat_bench_ThreadSwitchesInstrumentation_ownSwitches(JNIEnv *env, jclass) {
  struct rusage usage{};
  if(getrusage(RUSAGE_THREAD,&usage)!=0 || usage.ru_nvcsw<0 || usage.ru_nivcsw<0) return nullptr;
  jlong values[2]={usage.ru_nvcsw,usage.ru_nivcsw};
  auto result=env->NewLongArray(2);if(result)env->SetLongArrayRegion(result,0,2,values);return result;
}
