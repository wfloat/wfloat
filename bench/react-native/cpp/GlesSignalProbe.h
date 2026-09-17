#pragma once
#include "NativeJson.h"
#include "GlesPerformanceProbe.h"
#include "NativeFenceProbe.h"
#include <EGL/egl.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <algorithm>
#include <chrono>
#include <thread>
#include <vector>
#include <cstring>
namespace bench {
// Separate tiny context on the probe caller's thread. Never terminate the
// process-shared EGL display; that could invalidate the app renderer's contexts.
inline std::string glesSignalProbe() {
  struct Context {
    EGLDisplay display=EGL_NO_DISPLAY,previousDisplay=eglGetCurrentDisplay();EGLContext context=EGL_NO_CONTEXT,previousContext=eglGetCurrentContext();EGLSurface surface=EGL_NO_SURFACE,previousDraw=eglGetCurrentSurface(EGL_DRAW),previousRead=eglGetCurrentSurface(EGL_READ);EGLenum previousApi=eglQueryAPI();
    ~Context(){if(display!=EGL_NO_DISPLAY){if(eglGetCurrentContext()==context)eglMakeCurrent(display,EGL_NO_SURFACE,EGL_NO_SURFACE,EGL_NO_CONTEXT);if(context!=EGL_NO_CONTEXT)eglDestroyContext(display,context);if(surface!=EGL_NO_SURFACE)eglDestroySurface(display,surface);}eglBindAPI(previousApi);if(previousContext!=EGL_NO_CONTEXT)eglMakeCurrent(previousDisplay,previousDraw,previousRead,previousContext);}
  } c;
  const auto fail=[](const char *where){return jsonObject({{"error",jsonString(where)},{"eglError",jsonInteger(eglGetError())}});};
  c.display=eglGetDisplay(EGL_DEFAULT_DISPLAY);EGLint major=0,minor=0;if(c.display==EGL_NO_DISPLAY||!eglInitialize(c.display,&major,&minor))return fail("eglInitialize");
  if(!eglBindAPI(EGL_OPENGL_ES_API))return fail("eglBindAPI");
  const EGLint attributes[]={EGL_SURFACE_TYPE,EGL_PBUFFER_BIT,EGL_RENDERABLE_TYPE,EGL_OPENGL_ES3_BIT,EGL_RED_SIZE,8,EGL_GREEN_SIZE,8,EGL_BLUE_SIZE,8,EGL_NONE};EGLConfig config{};EGLint count=0;
  if(!eglChooseConfig(c.display,attributes,&config,1,&count)||count!=1)return fail("no GLES3 pbuffer configuration");
  const EGLint size[]={EGL_WIDTH,1,EGL_HEIGHT,1,EGL_NONE},version[]={EGL_CONTEXT_CLIENT_VERSION,3,EGL_NONE};c.surface=eglCreatePbufferSurface(c.display,config,size);if(c.surface==EGL_NO_SURFACE)return fail("eglCreatePbufferSurface");
  c.context=eglCreateContext(c.display,config,EGL_NO_CONTEXT,version);if(c.context==EGL_NO_CONTEXT||!eglMakeCurrent(c.display,c.surface,c.surface,c.context))return fail("eglCreateContext/makeCurrent");
  const auto string=[](GLenum name){const auto *p=glGetString(name);return p?jsonString((const char *)p):"null";};
  GLint extensionCount=0;glGetIntegerv(GL_NUM_EXTENSIONS,&extensionCount);bool timer=false,amd=false,global=false,armCores=false;std::string extensions="[";
  for(GLint i=0;i<std::min(extensionCount,2048);++i){const auto *p=(const char *)glGetStringi(GL_EXTENSIONS,i);if(i)extensions+=',';extensions+=p?jsonString(p):"null";if(p){armCores|=!strcmp(p,"GL_ARM_shader_core_properties");timer|=!strcmp(p,"GL_EXT_disjoint_timer_query");amd|=!strcmp(p,"GL_AMD_performance_monitor");global|=!strcmp(p,"GL_QCOM_perfmon_global_mode");}}extensions+=']';
  std::string coreProperties="[]";
  if(armCores){coreProperties="[";const char *names[]={"SHADER_CORE_COUNT_ARM","SHADER_CORE_ACTIVE_COUNT_ARM","SHADER_CORE_PRESENT_MASK_ARM","SHADER_CORE_MAX_WARP_COUNT_ARM","SHADER_CORE_PIXEL_RATE_ARM","SHADER_CORE_TEXEL_RATE_ARM","SHADER_CORE_FMA_RATE_ARM"};
    for(int i=0;i<7;++i){if(i)coreProperties+=',';GLint64 value=0;glGetInteger64v(0x96F0+i,&value);const auto error=glGetError();coreProperties+=jsonObject({{"name",jsonString(names[i])},{"value",error==GL_NO_ERROR?jsonInteger(value):"null"},{"glError",jsonInteger(error)}});}coreProperties+=']';}
  std::string timing="null";
  if(timer) {
    auto gen=(PFNGLGENQUERIESEXTPROC)eglGetProcAddress("glGenQueriesEXT");auto del=(PFNGLDELETEQUERIESEXTPROC)eglGetProcAddress("glDeleteQueriesEXT");auto begin=(PFNGLBEGINQUERYEXTPROC)eglGetProcAddress("glBeginQueryEXT");auto end=(PFNGLENDQUERYEXTPROC)eglGetProcAddress("glEndQueryEXT");auto get=(PFNGLGETQUERYOBJECTUIVEXTPROC)eglGetProcAddress("glGetQueryObjectuivEXT");auto get64=(PFNGLGETQUERYOBJECTUI64VEXTPROC)eglGetProcAddress("glGetQueryObjectui64vEXT");auto info=(PFNGLGETQUERYIVEXTPROC)eglGetProcAddress("glGetQueryivEXT");
    if(gen&&del&&begin&&end&&get&&get64&&info) {
      GLint bits=0,disjointBefore=0,disjointAfter=0;info(GL_TIME_ELAPSED_EXT,GL_QUERY_COUNTER_BITS_EXT,&bits);glGetIntegerv(GL_GPU_DISJOINT_EXT,&disjointBefore);
      GLuint query=0;gen(1,&query);begin(GL_TIME_ELAPSED_EXT,query);glClearColor(0.25f,0.5f,0.75f,1.f);glClear(GL_COLOR_BUFFER_BIT);end(GL_TIME_ELAPSED_EXT);glFlush();GLenum error=glGetError();GLuint ready=0;GLuint64 value=0;
      const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(2);
      while(error==GL_NO_ERROR&&!ready&&std::chrono::steady_clock::now()<deadline){get(query,GL_QUERY_RESULT_AVAILABLE_EXT,&ready);error=glGetError();if(!ready)std::this_thread::sleep_for(std::chrono::milliseconds(1));}
      if(ready&&error==GL_NO_ERROR){get64(query,GL_QUERY_RESULT_EXT,&value);error=glGetError();}glGetIntegerv(GL_GPU_DISJOINT_EXT,&disjointAfter);const auto disjointError=glGetError();if(query)del(1,&query);
      timing=jsonObject({{"scope",jsonString("one-pixel clear in owned context")},{"counterBits",jsonInteger(bits)},{"available",ready?"true":"false"},{"elapsedNanoseconds",ready&&error==GL_NO_ERROR?jsonInteger(value):"null"},{"gpuDisjointBefore",jsonInteger(disjointBefore)},{"gpuDisjointAfter",jsonInteger(disjointAfter)},{"glError",jsonInteger(error)},{"disjointReadError",jsonInteger(disjointError)}});
    }else timing=jsonObject({{"error",jsonString("advertised timer functions unavailable")}});
  }
  std::vector<GlesCounter> sampleCounters;std::string groups="[]";bool counterLimited=false;size_t visited=0;const auto counterDeadline=std::chrono::steady_clock::now()+std::chrono::milliseconds(250);
  if(amd) {
    auto getGroups=(PFNGLGETPERFMONITORGROUPSAMDPROC)eglGetProcAddress("glGetPerfMonitorGroupsAMD");auto getCounters=(PFNGLGETPERFMONITORCOUNTERSAMDPROC)eglGetProcAddress("glGetPerfMonitorCountersAMD");auto groupString=(PFNGLGETPERFMONITORGROUPSTRINGAMDPROC)eglGetProcAddress("glGetPerfMonitorGroupStringAMD");auto counterString=(PFNGLGETPERFMONITORCOUNTERSTRINGAMDPROC)eglGetProcAddress("glGetPerfMonitorCounterStringAMD");auto counterInfo=(PFNGLGETPERFMONITORCOUNTERINFOAMDPROC)eglGetProcAddress("glGetPerfMonitorCounterInfoAMD");
    if(getGroups&&getCounters&&groupString&&counterString&&counterInfo){GLint n=0;getGroups(&n,0,nullptr);std::vector<GLuint> ids(std::clamp(n,0,64));if(!ids.empty())getGroups(nullptr,ids.size(),ids.data());groups="[";counterLimited=n>64;
      for(size_t i=0;i<ids.size();++i){if(visited>=1024||std::chrono::steady_clock::now()>=counterDeadline){counterLimited=true;break;}if(i)groups+=',';GLint total=0,active=0;getCounters(ids[i],&total,&active,0,nullptr);std::vector<GLuint> counters(std::clamp(total,0,256));if(!counters.empty())getCounters(ids[i],&total,&active,counters.size(),counters.data());char name[1024]{};groupString(ids[i],sizeof(name),nullptr,name);std::string rows="[";
        for(size_t j=0;j<counters.size();++j){if(visited>=1024||std::chrono::steady_clock::now()>=counterDeadline){counterLimited=true;break;}++visited;if(j)rows+=',';char label[1024]{};counterString(ids[i],counters[j],sizeof(label),nullptr,label);GLenum type=0;counterInfo(ids[i],counters[j],GL_COUNTER_TYPE_AMD,&type);alignas(8) unsigned char range[16]{};counterInfo(ids[i],counters[j],GL_COUNTER_RANGE_AMD,range);std::string bounds="null";
          if(type==GL_UNSIGNED_INT){uint32_t v[2];memcpy(v,range,sizeof(v));bounds="["+jsonInteger(v[0])+","+jsonInteger(v[1])+"]";}else if(type==GL_UNSIGNED_INT64_AMD){uint64_t v[2];memcpy(v,range,sizeof(v));bounds="["+jsonInteger(v[0])+","+jsonInteger(v[1])+"]";}else if(type==GL_FLOAT||type==GL_PERCENTAGE_AMD){float v[2];memcpy(v,range,sizeof(v));bounds="["+jsonReal(v[0])+","+jsonReal(v[1])+"]";}
          const auto error=glGetError();if(!error&&active>0)sampleCounters.push_back({ids[i],counters[j],type});rows+=jsonObject({{"id",jsonInteger(counters[j])},{"name",jsonString(label)},{"type",jsonInteger(type)},{"range",error==GL_NO_ERROR?bounds:"null"},{"glError",jsonInteger(error)}});
        }if(total>256)counterLimited=true;rows+=']';groups+=jsonObject({{"id",jsonInteger(ids[i])},{"name",jsonString(name)},{"reportedCounterCount",jsonInteger(total)},{"maximumActiveCounters",jsonInteger(active)},{"counters",rows}});
      }groups+=']';
    }else groups=jsonObject({{"error",jsonString("advertised performance functions unavailable")}});
  }
  return jsonObject({{"nativeFenceProbe",nativeFenceProbe(c.display)},{"error","null"},{"vendor",string(GL_VENDOR)},{"renderer",string(GL_RENDERER)},{"version",string(GL_VERSION)},{"extensions",extensions},{"reportedExtensionCount",jsonInteger(extensionCount)},{"armShaderCorePropertiesAdvertised",armCores?"true":"false"},{"armShaderCoreProperties",coreProperties},{"timerExtensionAdvertised",timer?"true":"false"},{"timerProbe",timing},{"amdPerformanceMonitorAdvertised",amd?"true":"false"},{"qcomGlobalModeAdvertised",global?"true":"false"},{"performanceGroups",groups},{"performanceScanLimited",counterLimited?"true":"false"},{"performanceSampling",amd?glesPerformanceProbe(sampleCounters):jsonObject({{"state",jsonString("extension not advertised")}})},{"finalGlError",jsonInteger(glGetError())}});
}
}
