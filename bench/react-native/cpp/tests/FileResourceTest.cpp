#include <sys/syscall.h>
#include <unistd.h>
#include <signal.h>
#include <cerrno>
#include <cassert>
#include <chrono>
#include <cstdio>
static int mode=0;
static long testFileSyscall(long,...){if(mode==1)raise(SIGSYS);if(mode==2)usleep(2000000);errno=EACCES;return -1;}
#define syscall testFileSyscall
#include "../FileResourceSources.h"
#undef syscall
int main(){
 unsigned char raw[256]{};uint32_t mask=0x2000,alignment=4096;memcpy(raw,&mask,4);memcpy(raw+152,&alignment,4);memset(raw+168,0xff,4);
 auto fields=bench::statxResourceFields(raw);assert(fields.find("\"name\":\"directIoMemoryAlignmentBytes\",\"supported\":true,\"value\":\"4096\"")!=std::string::npos);assert(fields.find("\"name\":\"atomicWriteMinimumBytes\",\"supported\":false,\"value\":null")!=std::string::npos);assert(bench::fileNativeHex(raw,256).size()==512);
 FILE *file=tmpfile();assert(file);mode=2;auto start=std::chrono::steady_clock::now();auto timeout=bench::fileResourceSources(true);assert(timeout.find("\"timedOut\":true")!=std::string::npos);assert(std::chrono::steady_clock::now()-start<std::chrono::seconds(1));usleep(30000);
 mode=0;auto denied=bench::fileResourceSources(true);assert(denied.find("\"complete\":true")!=std::string::npos);assert(denied.find("\"errno\":\"13\"")!=std::string::npos);usleep(30000);
 mode=1;auto blocked=bench::fileResourceSources(true);usleep(30000);auto cached=bench::fileResourceSources(true);assert(cached.find("SIGSYS")!=std::string::npos);mode=0;auto other=bench::fileResourceSources(false);assert(other.find("\"complete\":true")!=std::string::npos);fclose(file);
 puts("PASS: ABI masks, null unreturned fields, full bytes, bounded timeout/recovery, denied records, SIGSYS caching and independent syscall families");
}
