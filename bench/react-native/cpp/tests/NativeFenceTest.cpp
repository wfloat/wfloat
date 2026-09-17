#include <sys/ioctl.h>
#include <linux/sync_file.h>
#include <cstdarg>
#include <cstring>
#include <cassert>
#include <cerrno>
#include <cstdio>
static int mode=0,calls=0;
static int testFenceIoctl(int,unsigned long request,...){assert(request==SYNC_IOC_FILE_INFO);++calls;va_list args;va_start(args,request);auto *v=va_arg(args,sync_file_info*);va_end(args);assert(v->flags==0&&v->pad==0);
 if(mode==1){errno=EACCES;return -1;}if(!v->num_fences){v->num_fences=mode==2?257:1;return 0;}
 if(mode==3){v->num_fences=2;return 0;}auto *f=(sync_fence_info*)(uintptr_t)v->sync_fence_info;memset(f->obj_name,'x',32);strcpy(f->driver_name,"test driver");f->status=-110;f->timestamp_ns=9007199254740993ULL;v->status=-110;return 0;
}
#define ioctl testFenceIoctl
#include "../NativeFenceProbe.h"
#undef ioctl
int main(){
 auto result=bench::nativeFenceInfo(9);assert(result.find("9007199254740993")!=std::string::npos&&result.find("\"status\":\"-110\"")!=std::string::npos);assert(result.find("\"layoutValid\":true")!=std::string::npos);
 mode=1;assert(bench::nativeFenceInfo(9).find("\"errno\":\"13\"")!=std::string::npos);
 mode=2;calls=0;assert(bench::nativeFenceInfo(9).find("\"limitReached\":true")!=std::string::npos&&calls==1);
 mode=3;assert(bench::nativeFenceInfo(9).find("\"layoutValid\":false")!=std::string::npos);
 assert(bench::fenceExtension("A EGL_ANDROID_native_fence_sync B","EGL_ANDROID_native_fence_sync"));assert(!bench::fenceExtension("EGL_ANDROID_native_fence_sync_extra","EGL_ANDROID_native_fence_sync"));
 puts("PASS: owned read-only selector, exact >2^53 timestamps, negative statuses, bounded names, denied replies, count cap/shape checks and exact extension matching");
}
