#pragma once
#include "NativeJson.h"
#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <linux/sync_file.h>
#include <sys/ioctl.h>
#include <poll.h>
#include <unistd.h>
#include <cerrno>
#include <cstring>
#include <vector>
#include <chrono>
namespace bench {
inline std::string fenceBytes(const void *p,size_t size){const auto *b=(const unsigned char*)p;const char *h="0123456789abcdef";std::string out;for(size_t i=0;i<size;++i){out+=h[b[i]>>4];out+=h[b[i]&15];}return out;}
// Only descriptors created and owned by this probe reach this ioctl. A generic
// app-FD scan could race descriptor reuse and apply an ioctl to the wrong object.
inline std::string nativeFenceInfo(int ownedFd){
 sync_file_info info{};int code=ioctl(ownedFd,SYNC_IOC_FILE_INFO,&info),error=code?errno:0;if(code)return jsonObject({{"errno",jsonInteger(error)},{"stage",jsonString("fence_count")}});
 const uint32_t reported=info.num_fences;if(reported>256)return jsonObject({{"reportedFenceCount",jsonInteger(reported)},{"limitReached","true"}});
 std::vector<sync_fence_info> fences(reported);info.sync_fence_info=(uint64_t)(uintptr_t)fences.data();
 if(reported){code=ioctl(ownedFd,SYNC_IOC_FILE_INFO,&info);error=code?errno:0;}
 std::string rows="[";bool valid=!code&&info.num_fences<=fences.size();if(valid)for(size_t i=0;i<info.num_fences;++i){const auto &f=fences[i];if(i)rows+=',';rows+=jsonObject({{"objectName",jsonString(std::string(f.obj_name,strnlen(f.obj_name,sizeof(f.obj_name))))},{"driverName",jsonString(std::string(f.driver_name,strnlen(f.driver_name,sizeof(f.driver_name))))},{"status",jsonInteger(f.status)},{"flags",jsonInteger(f.flags)},{"signalTimestampNs",jsonInteger(f.timestamp_ns)},{"nativeBytesHex",jsonString(fenceBytes(&f,sizeof(f)))}});}rows+=']';
 return jsonObject({{"errno",jsonInteger(error)},{"reportedFenceCount",jsonInteger(reported)},{"returnedFenceCount",jsonInteger(info.num_fences)},{"layoutValid",valid?"true":"false"},{"status",code?"null":jsonInteger(info.status)},{"name",code?"null":jsonString(std::string(info.name,strnlen(info.name,sizeof(info.name))))},{"headerNativeBytesHex",code?"null":jsonString(fenceBytes(&info,sizeof(info)))},{"headerIncludesInputArrayPointer","true"},{"fences",rows},{"limitReached","false"}});
}
inline bool fenceExtension(const char *all,const char *name){if(!all)return false;size_t length=strlen(name);const char *p=all;while((p=strstr(p,name))){if((p==all||p[-1]==' ')&&(p[length]==' '||p[length]=='\0'))return true;p+=length;}return false;}
inline std::string nativeFenceProbe(EGLDisplay display){
 const char *extensions=eglQueryString(display,EGL_EXTENSIONS);if(!fenceExtension(extensions,"EGL_ANDROID_native_fence_sync"))return jsonObject({{"state",jsonString("EGL_ANDROID_native_fence_sync not advertised")}});
 auto create=(PFNEGLCREATESYNCKHRPROC)eglGetProcAddress("eglCreateSyncKHR");auto destroy=(PFNEGLDESTROYSYNCKHRPROC)eglGetProcAddress("eglDestroySyncKHR");auto duplicate=(PFNEGLDUPNATIVEFENCEFDANDROIDPROC)eglGetProcAddress("eglDupNativeFenceFDANDROID");
 if(!create||!destroy||!duplicate)return jsonObject({{"state",jsonString("advertised native-fence functions unavailable")}});
 glClearColor(.2f,.4f,.6f,1);glClear(GL_COLOR_BUFFER_BIT);const EGLint attributes[]={EGL_NONE};EGLSyncKHR sync=create(display,EGL_SYNC_NATIVE_FENCE_ANDROID,attributes);if(sync==EGL_NO_SYNC_KHR)return jsonObject({{"stage",jsonString("create")},{"eglError",jsonInteger(eglGetError())}});
 struct SyncOwner{EGLDisplay d;EGLSyncKHR s;PFNEGLDESTROYSYNCKHRPROC destroy;~SyncOwner(){destroy(d,s);}} syncOwner{display,sync,destroy};glFlush();int fd=duplicate(display,sync);if(fd<0)return jsonObject({{"stage",jsonString("export")},{"eglError",jsonInteger(eglGetError())}});
 struct FdOwner{int fd;~FdOwner(){close(fd);}} fdOwner{fd};const auto before=nativeFenceInfo(fd);auto started=std::chrono::steady_clock::now();const auto end=started+std::chrono::milliseconds(250);pollfd p{fd,POLLIN,0};int ready=0;
 do{auto left=std::chrono::duration_cast<std::chrono::milliseconds>(end-std::chrono::steady_clock::now()).count();if(left<=0)break;ready=poll(&p,1,int(left));}while(ready<0&&errno==EINTR);int error=ready<0?errno:0;const auto after=nativeFenceInfo(fd);
 return jsonObject({{"before",before},{"after",after},{"pollResult",jsonInteger(ready)},{"pollErrno",jsonInteger(error)},{"pollEvents",jsonInteger(p.revents)},{"waitElapsedNs",jsonInteger(std::chrono::duration_cast<std::chrono::nanoseconds>(std::chrono::steady_clock::now()-started).count())},{"scope",jsonString("Owned native EGL fence after one-pixel work; raw kernel sync-file component statuses, driver/timeline names and signaling timestamps. Status query may recognize completion and signal the fence; explicit probe only. Timestamp is fence signaling, not guaranteed hardware completion instant or GPU execution duration. No merge, deadline hints or queries on unrelated app descriptors; only the newly exported descriptor is closed.")}});
}
}
