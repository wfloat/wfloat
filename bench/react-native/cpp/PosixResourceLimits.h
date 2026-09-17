#pragma once
#include "NativeJson.h"
#include <unistd.h>
#include <cerrno>
namespace bench {
inline std::string posixResourceLimits(const char *volumePath){
  struct Entry {const char *name;int selector;};
  const Entry systemEntries[]={
#ifdef _SC_ARG_MAX
    {"_SC_ARG_MAX",_SC_ARG_MAX},
#endif
#ifdef _SC_CHILD_MAX
    {"_SC_CHILD_MAX",_SC_CHILD_MAX},
#endif
#ifdef _SC_CLK_TCK
    {"_SC_CLK_TCK",_SC_CLK_TCK},
#endif
#ifdef _SC_NGROUPS_MAX
    {"_SC_NGROUPS_MAX",_SC_NGROUPS_MAX},
#endif
#ifdef _SC_OPEN_MAX
    {"_SC_OPEN_MAX",_SC_OPEN_MAX},
#endif
#ifdef _SC_STREAM_MAX
    {"_SC_STREAM_MAX",_SC_STREAM_MAX},
#endif
#ifdef _SC_TZNAME_MAX
    {"_SC_TZNAME_MAX",_SC_TZNAME_MAX},
#endif
#ifdef _SC_AIO_LISTIO_MAX
    {"_SC_AIO_LISTIO_MAX",_SC_AIO_LISTIO_MAX},
#endif
#ifdef _SC_AIO_MAX
    {"_SC_AIO_MAX",_SC_AIO_MAX},
#endif
#ifdef _SC_AIO_PRIO_DELTA_MAX
    {"_SC_AIO_PRIO_DELTA_MAX",_SC_AIO_PRIO_DELTA_MAX},
#endif
#ifdef _SC_DELAYTIMER_MAX
    {"_SC_DELAYTIMER_MAX",_SC_DELAYTIMER_MAX},
#endif
#ifdef _SC_MQ_OPEN_MAX
    {"_SC_MQ_OPEN_MAX",_SC_MQ_OPEN_MAX},
#endif
#ifdef _SC_MQ_PRIO_MAX
    {"_SC_MQ_PRIO_MAX",_SC_MQ_PRIO_MAX},
#endif
#ifdef _SC_RTSIG_MAX
    {"_SC_RTSIG_MAX",_SC_RTSIG_MAX},
#endif
#ifdef _SC_SEM_NSEMS_MAX
    {"_SC_SEM_NSEMS_MAX",_SC_SEM_NSEMS_MAX},
#endif
#ifdef _SC_SEM_VALUE_MAX
    {"_SC_SEM_VALUE_MAX",_SC_SEM_VALUE_MAX},
#endif
#ifdef _SC_SIGQUEUE_MAX
    {"_SC_SIGQUEUE_MAX",_SC_SIGQUEUE_MAX},
#endif
#ifdef _SC_TIMER_MAX
    {"_SC_TIMER_MAX",_SC_TIMER_MAX},
#endif
#ifdef _SC_PAGESIZE
    {"_SC_PAGESIZE",_SC_PAGESIZE},
#endif
#ifdef _SC_THREAD_KEYS_MAX
    {"_SC_THREAD_KEYS_MAX",_SC_THREAD_KEYS_MAX},
#endif
#ifdef _SC_THREAD_STACK_MIN
    {"_SC_THREAD_STACK_MIN",_SC_THREAD_STACK_MIN},
#endif
#ifdef _SC_THREAD_THREADS_MAX
    {"_SC_THREAD_THREADS_MAX",_SC_THREAD_THREADS_MAX},
#endif
#ifdef _SC_NPROCESSORS_CONF
    {"_SC_NPROCESSORS_CONF",_SC_NPROCESSORS_CONF},
#endif
#ifdef _SC_NPROCESSORS_ONLN
    {"_SC_NPROCESSORS_ONLN",_SC_NPROCESSORS_ONLN},
#endif
#ifdef _SC_PHYS_PAGES
    {"_SC_PHYS_PAGES",_SC_PHYS_PAGES},
#endif
#ifdef _SC_AVPHYS_PAGES
    {"_SC_AVPHYS_PAGES",_SC_AVPHYS_PAGES},
#endif
#ifdef _SC_IOV_MAX
    {"_SC_IOV_MAX",_SC_IOV_MAX},
#endif
#ifdef _SC_GETGR_R_SIZE_MAX
    {"_SC_GETGR_R_SIZE_MAX",_SC_GETGR_R_SIZE_MAX},
#endif
#ifdef _SC_GETPW_R_SIZE_MAX
    {"_SC_GETPW_R_SIZE_MAX",_SC_GETPW_R_SIZE_MAX},
#endif
  };
  const Entry pathEntries[]={
#ifdef _PC_LINK_MAX
    {"_PC_LINK_MAX",_PC_LINK_MAX},
#endif
#ifdef _PC_NAME_MAX
    {"_PC_NAME_MAX",_PC_NAME_MAX},
#endif
#ifdef _PC_PATH_MAX
    {"_PC_PATH_MAX",_PC_PATH_MAX},
#endif
#ifdef _PC_PIPE_BUF
    {"_PC_PIPE_BUF",_PC_PIPE_BUF},
#endif
#ifdef _PC_ALLOC_SIZE_MIN
    {"_PC_ALLOC_SIZE_MIN",_PC_ALLOC_SIZE_MIN},
#endif
#ifdef _PC_FILESIZEBITS
    {"_PC_FILESIZEBITS",_PC_FILESIZEBITS},
#endif
#ifdef _PC_REC_INCR_XFER_SIZE
    {"_PC_REC_INCR_XFER_SIZE",_PC_REC_INCR_XFER_SIZE},
#endif
#ifdef _PC_REC_MAX_XFER_SIZE
    {"_PC_REC_MAX_XFER_SIZE",_PC_REC_MAX_XFER_SIZE},
#endif
#ifdef _PC_REC_MIN_XFER_SIZE
    {"_PC_REC_MIN_XFER_SIZE",_PC_REC_MIN_XFER_SIZE},
#endif
#ifdef _PC_REC_XFER_ALIGN
    {"_PC_REC_XFER_ALIGN",_PC_REC_XFER_ALIGN},
#endif
#ifdef _PC_SYMLINK_MAX
    {"_PC_SYMLINK_MAX",_PC_SYMLINK_MAX},
#endif
#ifdef _PC_XATTR_SIZE_BITS
    {"_PC_XATTR_SIZE_BITS",_PC_XATTR_SIZE_BITS},
#endif
#ifdef _PC_MIN_HOLE_SIZE
    {"_PC_MIN_HOLE_SIZE",_PC_MIN_HOLE_SIZE},
#endif
  };
  auto query=[&](const Entry *entries,size_t count,bool path){std::string rows="[";
    for(size_t i=0;i<count;++i){errno=0;long value=path?pathconf(volumePath,entries[i].selector):sysconf(entries[i].selector);int error=errno;
      if(i)rows+=',';rows+=jsonObject({{"name",jsonString(entries[i].name)},{"raw",jsonInteger(value)},{"errno",std::to_string(error)},{"value",value<0?"null":jsonInteger(value)},{"indeterminateOrUnsupported",value==-1&&!error?"true":"false"}});}
    return rows+"]";};
  return jsonObject({{"sysconf",query(systemEntries,sizeof(systemEntries)/sizeof(systemEntries[0]),false)},
    {"pathconf",query(pathEntries,sizeof(pathEntries)/sizeof(pathEntries[0]),true)},
    {"scope",jsonString("Native process/system resource limits and specified filesystem transfer/allocation constraints. Minus one without errno is indeterminate or unsupported, never zero capacity. Constants and policy limits are not live utilization.")}});
}
}
