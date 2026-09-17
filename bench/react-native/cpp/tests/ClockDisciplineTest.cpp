#include <sys/timex.h>
#include <unistd.h>
#include <signal.h>
#include <cerrno>
#include <cassert>
#include <chrono>
#include <cstdio>
static int mode=0;
static int testClock(timex *v){assert(v->modes==0);if(mode==1){errno=EPERM;return -1;}if(mode==2)usleep(2000000);if(mode==3)raise(SIGSYS);v->freq=-65536;v->status=STA_UNSYNC;return TIME_ERROR;}
#define adjtimex testClock
#include "../ClockDisciplineSource.h"
#undef adjtimex
int main(){
 auto unsynchronized=bench::clockDisciplineSource();assert(unsynchronized.find("\"clockState\":\"5\"")!=std::string::npos);assert(unsynchronized.find("\"errno\":\"0\"")!=std::string::npos);assert(unsynchronized.find("\"freq\":\"-65536\"")!=std::string::npos);usleep(30000);
 mode=1;auto denied=bench::clockDisciplineSource();assert(denied.find("\"fields\":null")!=std::string::npos);usleep(30000);
 mode=2;auto start=std::chrono::steady_clock::now();auto timeout=bench::clockDisciplineSource();assert(timeout.find("\"timedOut\":true")!=std::string::npos);assert(std::chrono::steady_clock::now()-start<std::chrono::seconds(1));usleep(30000);
 mode=3;bench::clockDisciplineSource();usleep(30000);auto blocked=bench::clockDisciplineSource();assert(blocked.find("SIGSYS")!=std::string::npos);
 puts("PASS: modes remain zero, TIME_ERROR differs from errno, signed native fields, denied nulls, timeout recovery and seccomp caching");
}
