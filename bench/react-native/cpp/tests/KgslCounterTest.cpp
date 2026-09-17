#include "../NativeJson.h"
#include <sys/ioctl.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstdint>
#include <cerrno>
#include <vector>
#include <algorithm>
#include <chrono>
#include <cassert>
#include <cstring>
#include <cstdio>
int testOpen(const char*,int);int testClose(int);int testIoctl(int,unsigned long,void*);
#define open testOpen
#define close testClose
#define ioctl testIoctl
#include "../KgslCounterSource.h"
#undef open
#undef close
#undef ioctl
bool deny=false;int closes=0,reads=0;
int testOpen(const char*p,int flags){assert(!strcmp(p,"/dev/kgsl-3d0")&&(flags&O_ACCMODE)==O_RDONLY);return 42;}
int testClose(int fd){assert(fd==42);++closes;return 0;}
int testIoctl(int fd,unsigned long request,void *p){assert(fd==42&&_IOC_TYPE(request)==9);switch(_IOC_NR(request)){
 case 2:{auto*q=(bench::KgslProperty*)p;memset(q->value,0,q->bytes);return 0;}
 case 0x3a:{auto*q=(bench::KgslCounterQuery*)p;if(q->group){errno=EINVAL;return -1;}q->maximum=3;if(q->count){assert(q->count==3);q->countables[0]=4;q->countables[1]=0xffffffffU;q->countables[2]=5;}return 0;}
 case 0x3b:{auto*q=(bench::KgslCounterRead*)p;assert(q->count==2&&q->values[0].countable==4&&q->values[1].countable==5);++reads;if(deny){errno=EPERM;return -1;}q->values[0].value=UINT64_MAX;q->values[1].value=9007199254740993ULL;return 0;}
 default:assert(false);return -1;}}
int main(){auto s=bench::kgslCounterSource();assert(closes==1&&reads==1&&s.find("18446744073709551615")!=std::string::npos&&s.find("9007199254740993")!=std::string::npos&&s.find("\"groupRangeEnded\":true")!=std::string::npos&&s.find("\"limitReached\":false")!=std::string::npos);deny=true;s=bench::kgslCounterSource();assert(closes==2&&reads==2&&s.find("\"nativeValue\":null")!=std::string::npos);puts("PASS: read-only allowlisted ioctls, complete group enumeration, sentinel filtering, exact uint64 and permission nulls");}
