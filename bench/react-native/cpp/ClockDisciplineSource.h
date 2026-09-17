#pragma once
#include "NativeJson.h"
#include <sys/timex.h>
#include <cerrno>
#include <cstring>
#include <string>
#include <vector>
#include <chrono>
#if defined(__APPLE__)
#include <dlfcn.h>
#else
#include <sys/wait.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>
#include <mutex>
#endif
namespace bench {
inline std::string clockBytes(const void *p,size_t n){const char *h="0123456789abcdef";const auto *b=(const unsigned char*)p;std::string out;for(size_t i=0;i<n;++i){out+=h[b[i]>>4];out+=h[b[i]&15];}return out;}
inline std::string clockDisciplineRecord(const timex &v,int state,int error){
 std::string fields="null";
 if(!error){std::vector<std::pair<std::string,std::string>> values;
#define CLOCK_FIELD(x) values.emplace_back(#x,jsonInteger(v.x))
 CLOCK_FIELD(modes);CLOCK_FIELD(offset);CLOCK_FIELD(freq);CLOCK_FIELD(maxerror);CLOCK_FIELD(esterror);CLOCK_FIELD(status);CLOCK_FIELD(constant);CLOCK_FIELD(precision);CLOCK_FIELD(tolerance);CLOCK_FIELD(ppsfreq);CLOCK_FIELD(jitter);CLOCK_FIELD(shift);CLOCK_FIELD(stabil);CLOCK_FIELD(jitcnt);CLOCK_FIELD(calcnt);CLOCK_FIELD(errcnt);CLOCK_FIELD(stbcnt);
#if defined(__linux__)
 CLOCK_FIELD(tick);CLOCK_FIELD(tai);values.emplace_back("timeSeconds",jsonInteger(v.time.tv_sec));values.emplace_back("timeSubsecondNative",jsonInteger(v.time.tv_usec));
#endif
#undef CLOCK_FIELD
 fields="{";for(size_t i=0;i<values.size();++i){if(i)fields+=',';fields+=jsonString(values[i].first)+":"+values[i].second;}fields+='}';}
 return jsonObject({{"requestedModes","0"},{"clockState",error?"null":jsonInteger(state)},{"errno",jsonInteger(error)},{"nativeRecordBytes",jsonInteger(sizeof(v))},{"nativeBytesHex",error?"null":jsonString(clockBytes(&v,sizeof(v)))},{"fields",fields},{"scope",jsonString("Kernel clock discipline queried with modes=0 only: no clock adjustment, synchronization enablement or network request. TIME_ERROR is a successful query reporting unsynchronized/error state, not an errno. Raw frequency/tolerance use scaled ppm; status controls applicable subsecond units. Kernel error estimates and PPS placeholders are not guaranteed wall-clock accuracy or benchmark timing error; platform ABI/semantics differ.")}});
}
#if defined(__APPLE__)
inline std::string clockTimeErrorSource(){
 static auto get=(int(*)(ntptimeval*))dlsym(RTLD_DEFAULT,"ntp_gettime");if(!get)return jsonObject({{"state",jsonString("ntp_gettime symbol unavailable")}});
 ntptimeval value{};errno=0;int code=get(&value),error=code<0?errno:0;
 return jsonObject({{"returnCode",jsonInteger(code)},{"errno",jsonInteger(error)},{"nativeRecordBytes",jsonInteger(sizeof(value))},{"bufferAfterCallHex",jsonString(clockBytes(&value,sizeof(value)))},{"fields",code<0?"null":jsonObject({{"timeSeconds",jsonInteger(value.time.tv_sec)},{"timeNanoseconds",jsonInteger(value.time.tv_nsec)},{"maximumErrorMicroseconds",jsonInteger(value.maxerror)},{"estimatedErrorMicroseconds",jsonInteger(value.esterror)},{"taiOffset",jsonInteger(value.tai)},{"timeState",jsonInteger(value.time_state)}})},{"scope",jsonString("Read-only kernel wall-clock error/TAI report. Reviewed XNU copies the reply then returns time_state through the syscall error path; nonzero states may appear as errno. Keep return/errno and the zero-initialized post-call buffer without silently reclassifying failure as a valid reading. Query updates elapsed maximum-error bookkeeping; no clock adjustment or network request.")}});
}
#endif
inline std::string clockDisciplineSource(){
#if defined(__APPLE__)
 static auto get=(int(*)(timex*))dlsym(RTLD_DEFAULT,"ntp_adjtime");if(!get)return jsonObject({{"state",jsonString("ntp_adjtime symbol unavailable")}});
 timex v{};errno=0;int state=get(&v);return clockDisciplineRecord(v,state,state<0?errno:0);
#else
 static std::mutex mutex;std::lock_guard<std::mutex> lock(mutex);static pid_t pending=0;static bool denied=false;
 if(denied)return jsonObject({{"state",jsonString("SIGSYS restriction cached for this process")}});
 if(pending){int status=0;pid_t w;do{w=waitpid(pending,&status,WNOHANG);}while(w<0&&errno==EINTR);if(w<0&&errno!=ECHILD)return jsonObject({{"waitErrno",jsonInteger(errno)}});if(!w)return jsonObject({{"state",jsonString("prior query child still terminating")}});if(w>0&&((WIFSIGNALED(status)&&WTERMSIG(status)==SIGSYS)||(WIFEXITED(status)&&WEXITSTATUS(status)==128+SIGSYS)))denied=true;pending=0;if(denied)return jsonObject({{"state",jsonString("SIGSYS restriction cached for this process")}});}
 struct Reply{timex value;int state,error;};Reply r{};int pipefd[2];if(pipe(pipefd))return jsonObject({{"stage",jsonString("pipe")},{"errno",jsonInteger(errno)}});
 pid_t child=fork();if(child<0){int error=errno;close(pipefd[0]);close(pipefd[1]);return jsonObject({{"stage",jsonString("fork")},{"errno",jsonInteger(error)}});}
 if(!child){close(pipefd[0]);struct sigaction action{};action.sa_handler=+[](int){_exit(128+SIGSYS);};sigemptyset(&action.sa_mask);sigaction(SIGSYS,&action,nullptr);sigset_t signals;sigemptyset(&signals);sigaddset(&signals,SIGSYS);sigprocmask(SIG_UNBLOCK,&signals,nullptr);
  Reply reply{};reply.state=adjtimex(&reply.value);reply.error=reply.state<0?errno:0;size_t sent=0;while(sent<sizeof(reply)){ssize_t n=write(pipefd[1],(char*)&reply+sent,sizeof(reply)-sent);if(n<0&&errno==EINTR)continue;if(n<=0)_exit(2);sent+=size_t(n);}_exit(0);}
 close(pipefd[1]);pollfd p{pipefd[0],POLLIN|POLLHUP,0};int ready=0;auto deadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);do{auto left=std::chrono::duration_cast<std::chrono::milliseconds>(deadline-std::chrono::steady_clock::now()).count();if(left<=0){ready=0;break;}ready=poll(&p,1,int(left));}while(ready<0&&errno==EINTR);int pollError=ready<0?errno:0;ssize_t got=ready>0?read(pipefd[0],&r,sizeof(r)):-1;int readError=ready>0&&got<0?errno:0;close(pipefd[0]);if(ready<=0)kill(child,SIGKILL);
 int status=0;pid_t w;do{w=waitpid(child,&status,WNOHANG);}while(w<0&&errno==EINTR);if(!w)pending=child;
 if(w>0&&((WIFSIGNALED(status)&&WTERMSIG(status)==SIGSYS)||(WIFEXITED(status)&&WEXITSTATUS(status)==128+SIGSYS)))denied=true;
 if(got!=sizeof(r))return jsonObject({{"state",jsonString(denied?"SIGSYS restriction":"no complete native reply")},{"pollErrno",jsonInteger(pollError)},{"readErrno",jsonInteger(readError)},{"receivedBytes",jsonInteger(got)},{"timedOut",ready==0?"true":"false"}});
 return clockDisciplineRecord(r.value,r.state,r.error);
#endif
}
}
