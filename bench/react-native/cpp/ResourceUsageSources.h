#pragma once
#include "NativeJson.h"
#include <sys/resource.h>
#include <cerrno>
namespace bench {
inline std::string scopedResourceUsage(int who) {
  rusage v{};const int e=getrusage(who,&v)==0?0:errno;
  if(e)return jsonObject({{"errno",std::to_string(e)},{"values","null"}});
  return jsonObject({{"errno","0"},{"values",jsonObject({
    {"ru_utime.tv_sec",jsonInteger(v.ru_utime.tv_sec)},{"ru_utime.tv_usec",jsonInteger(v.ru_utime.tv_usec)},
    {"ru_stime.tv_sec",jsonInteger(v.ru_stime.tv_sec)},{"ru_stime.tv_usec",jsonInteger(v.ru_stime.tv_usec)},
    {"ru_maxrss",jsonInteger(v.ru_maxrss)},{"ru_ixrss",jsonInteger(v.ru_ixrss)},{"ru_idrss",jsonInteger(v.ru_idrss)},
    {"ru_isrss",jsonInteger(v.ru_isrss)},{"ru_minflt",jsonInteger(v.ru_minflt)},{"ru_majflt",jsonInteger(v.ru_majflt)},
    {"ru_nswap",jsonInteger(v.ru_nswap)},{"ru_inblock",jsonInteger(v.ru_inblock)},{"ru_oublock",jsonInteger(v.ru_oublock)},
    {"ru_msgsnd",jsonInteger(v.ru_msgsnd)},{"ru_msgrcv",jsonInteger(v.ru_msgrcv)},
    {"ru_nsignals",jsonInteger(v.ru_nsignals)},{"ru_nvcsw",jsonInteger(v.ru_nvcsw)},{"ru_nivcsw",jsonInteger(v.ru_nivcsw)}
  })}});
}
}
