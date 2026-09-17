#include <jni.h>
#include <sched.h>
#include <cerrno>

extern "C" JNIEXPORT jint JNICALL
Java_com_wfloat_bench_ThreadSchedulerInstrumentation_setOwnPolicy(JNIEnv *, jclass, jint policy) {
  // Deliberately cannot request real-time scheduling. Only this test worker changes.
  if (policy != SCHED_OTHER && policy != SCHED_BATCH && policy != SCHED_IDLE) return EINVAL;
  sched_param param{};
  return sched_setscheduler(0, policy, &param) == 0 ? 0 : errno;
}
extern "C" JNIEXPORT jintArray JNICALL
Java_com_wfloat_bench_ThreadSchedulerInstrumentation_readScheduler(JNIEnv *env, jclass, jint tid) {
  errno=0;int policy=sched_getscheduler(tid);int policyError=policy<0?errno:0;
  sched_param param{};int code=sched_getparam(tid,&param);int paramError=code<0?errno:0;
  jint values[]={policy,param.sched_priority,policyError,paramError};
  auto result=env->NewIntArray(4);if(result)env->SetIntArrayRegion(result,0,4,values);return result;
}
