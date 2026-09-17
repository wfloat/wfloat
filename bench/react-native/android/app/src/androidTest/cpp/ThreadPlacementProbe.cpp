#include <jni.h>
#include <sched.h>
#include <cerrno>

extern "C" JNIEXPORT jintArray JNICALL
Java_com_wfloat_bench_ThreadPlacementInstrumentation_allowedCpus(JNIEnv *env, jclass) {
  cpu_set_t mask;CPU_ZERO(&mask);
  if (sched_getaffinity(0,sizeof(mask),&mask)!=0) return nullptr;
  jint cpus[CPU_SETSIZE];int count=0;
  for(int cpu=0;cpu<CPU_SETSIZE;cpu++)if(CPU_ISSET(cpu,&mask))cpus[count++]=cpu;
  auto result=env->NewIntArray(count);if(result)env->SetIntArrayRegion(result,0,count,cpus);return result;
}
extern "C" JNIEXPORT jint JNICALL
Java_com_wfloat_bench_ThreadPlacementInstrumentation_setOwnCpus(JNIEnv *env, jclass, jintArray cpus) {
  if(!cpus)return EINVAL;
  auto count=env->GetArrayLength(cpus);if(count<1||count>CPU_SETSIZE)return EINVAL;
  jint ids[CPU_SETSIZE];env->GetIntArrayRegion(cpus,0,count,ids);if(env->ExceptionCheck())return EINVAL;
  cpu_set_t mask;CPU_ZERO(&mask);
  for(int i=0;i<count;i++){if(ids[i]<0||ids[i]>=CPU_SETSIZE)return EINVAL;CPU_SET(ids[i],&mask);}
  return sched_setaffinity(0,sizeof(mask),&mask)==0?0:errno;
}
extern "C" JNIEXPORT jint JNICALL
Java_com_wfloat_bench_ThreadPlacementInstrumentation_currentCpu(JNIEnv *, jclass) {return sched_getcpu();}
