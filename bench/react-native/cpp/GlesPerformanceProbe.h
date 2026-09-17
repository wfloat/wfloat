#pragma once
#include "NativeJson.h"
#include <EGL/egl.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>
#include <vector>
#include <algorithm>
#include <cstring>
#include <chrono>
#include <thread>
namespace bench {
struct GlesCounter {GLuint group,id;GLenum type;};
inline std::string glesPerformanceRecord(const std::vector<GLuint>&words,size_t bytes,const std::vector<GlesCounter>&selected){
  if(bytes>words.size()*sizeof(GLuint))return jsonObject({{"error",jsonString("result exceeds backing buffer")}});
  const auto *raw=reinterpret_cast<const unsigned char*>(words.data());std::string hex,rows="[";const char *digits="0123456789abcdef";for(size_t i=0;i<bytes;++i){hex+=digits[raw[i]>>4];hex+=digits[raw[i]&15];}
  size_t offset=0;std::vector<bool>seen(selected.size());bool valid=true,first=true;
  while(offset<bytes){if(bytes-offset<8){valid=false;break;}GLuint group,id;memcpy(&group,raw+offset,4);memcpy(&id,raw+offset+4,4);offset+=8;size_t index=0;for(;index<selected.size();++index)if(selected[index].group==group&&selected[index].id==id)break;
    if(index==selected.size()||seen[index]){valid=false;break;}auto type=selected[index].type;size_t width=type==GL_UNSIGNED_INT64_AMD?8:4;if(type!=GL_UNSIGNED_INT64_AMD&&type!=GL_UNSIGNED_INT&&type!=GL_FLOAT&&type!=GL_PERCENTAGE_AMD){valid=false;break;}if(bytes-offset<width){valid=false;break;}
    std::string value;if(type==GL_UNSIGNED_INT64_AMD){uint64_t v;memcpy(&v,raw+offset,8);value=jsonInteger(v);}else if(type==GL_UNSIGNED_INT){uint32_t v;memcpy(&v,raw+offset,4);value=jsonInteger(v);}else{float v;memcpy(&v,raw+offset,4);value=jsonReal(v);}offset+=width;seen[index]=true;if(!first)rows+=',';first=false;rows+=jsonObject({{"groupId",jsonInteger(group)},{"counterId",jsonInteger(id)},{"nativeType",jsonInteger(type)},{"value",value}});
  }rows+=']';for(bool present:seen)valid&=present;
  return jsonObject({{"rawHex",jsonString(hex)},{"bytesWritten",std::to_string(bytes)},{"values",rows},{"completeTypedRecord",valid?"true":"false"}});
}
// Called only inside the explicit probe's owned GLES context. Each counter is
// isolated in its own monitor, avoiding cross-counter resource conflicts. Never
// enables QCOM global mode; the caller reports driver metadata separately.
inline std::string glesPerformanceProbe(const std::vector<GlesCounter>&counters){
  auto gen=(PFNGLGENPERFMONITORSAMDPROC)eglGetProcAddress("glGenPerfMonitorsAMD");auto del=(PFNGLDELETEPERFMONITORSAMDPROC)eglGetProcAddress("glDeletePerfMonitorsAMD");auto select=(PFNGLSELECTPERFMONITORCOUNTERSAMDPROC)eglGetProcAddress("glSelectPerfMonitorCountersAMD");auto begin=(PFNGLBEGINPERFMONITORAMDPROC)eglGetProcAddress("glBeginPerfMonitorAMD");auto end=(PFNGLENDPERFMONITORAMDPROC)eglGetProcAddress("glEndPerfMonitorAMD");auto get=(PFNGLGETPERFMONITORCOUNTERDATAAMDPROC)eglGetProcAddress("glGetPerfMonitorCounterDataAMD");
  if(!gen||!del||!select||!begin||!end||!get)return jsonObject({{"error",jsonString("advertised monitor entry points unavailable")}});
  if(counters.empty())return jsonObject({{"samples","[]"},{"candidateCount","0"},{"limitReached","false"}});
  const char *vs="#version 300 es\nvoid main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.0-1.0,0.0,1.0);}";
  const char *fs="#version 300 es\nprecision mediump float;out vec4 color;void main(){color=vec4(0.25,0.5,0.75,1.0);}";
  GLuint vertex=glCreateShader(GL_VERTEX_SHADER),fragment=glCreateShader(GL_FRAGMENT_SHADER),program=glCreateProgram();
  struct ProgramOwner{GLuint v,f,p;~ProgramOwner(){glUseProgram(0);glDeleteProgram(p);glDeleteShader(v);glDeleteShader(f);}}owner{vertex,fragment,program};
  glShaderSource(vertex,1,&vs,nullptr);glCompileShader(vertex);glShaderSource(fragment,1,&fs,nullptr);glCompileShader(fragment);glAttachShader(program,vertex);glAttachShader(program,fragment);glLinkProgram(program);GLint linked=0;glGetProgramiv(program,GL_LINK_STATUS,&linked);if(!linked)return jsonObject({{"error",jsonString("owned performance-probe shader link failed")}});glUseProgram(program);glViewport(0,0,1,1);
  const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(10);std::string samples="[";bool first=true,limited=false;
  for(auto counter:counters){
    if(std::chrono::steady_clock::now()>=deadline){limited=true;break;}
    GLuint monitor=0;gen(1,&monitor);GLenum error=glGetError();const char *stage="create";std::string record="null";bool ready=false;
    if(!error&&monitor){select(monitor,GL_TRUE,counter.group,1,&counter.id);error=glGetError();stage="select";}
    if(!error&&monitor){begin(monitor);error=glGetError();stage="begin";if(!error){for(int i=0;i<64;++i)glDrawArrays(GL_TRIANGLES,0,3);end(monitor);glFlush();error=glGetError();stage="end/submit";
      const auto waitUntil=std::min(deadline,std::chrono::steady_clock::now()+std::chrono::milliseconds(250));GLuint available=0;
      while(!error&&!available&&std::chrono::steady_clock::now()<waitUntil){get(monitor,GL_PERFMON_RESULT_AVAILABLE_AMD,sizeof(available),&available,nullptr);error=glGetError();if(!available&&!error)std::this_thread::sleep_for(std::chrono::milliseconds(1));}ready=available!=0;stage="availability";
      if(!error&&ready){GLuint bytes=0;get(monitor,GL_PERFMON_RESULT_SIZE_AMD,sizeof(bytes),&bytes,nullptr);error=glGetError();stage="result size";
        if(!error&&bytes&&bytes<=65536){std::vector<GLuint>data((bytes+3)/4);GLint written=0;get(monitor,GL_PERFMON_RESULT_AMD,bytes,data.data(),&written);error=glGetError();stage="result";
          if(!error&&written>=0&&static_cast<size_t>(written)<=bytes)record=glesPerformanceRecord(data,written,{counter});else if(!error)record=jsonObject({{"error",jsonString("invalid bytesWritten")}});
        }else if(!error)record=jsonObject({{"reportedBytes",std::to_string(bytes)},{"error",jsonString("empty or oversized result")}});
      }
    }}
    if(monitor)del(1,&monitor);const GLenum cleanupError=glGetError();if(!first)samples+=',';first=false;samples+=jsonObject({{"groupId",jsonInteger(counter.group)},{"counterId",jsonInteger(counter.id)},{"stage",jsonString(stage)},{"glError",jsonInteger(error)},{"cleanupError",jsonInteger(cleanupError)},{"available",ready?"true":"false"},{"record",record}});
  }samples+=']';return jsonObject({{"samples",samples},{"candidateCount",std::to_string(counters.size())},{"limitReached",limited?"true":"false"},{"scope",jsonString("One counter per repeated 64-draw, one-pixel workload in owned context. Native driver semantics; counters are separate observations, not simultaneous totals. Global mode never enabled. 250 ms availability wait per counter, 10 s between-call budget; driver calls themselves can block. Monitoring has overhead.")}});
}
}
