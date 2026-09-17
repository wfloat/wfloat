#pragma once
#include "NativeJson.h"
#include <sys/vfs.h>
#include <sys/wait.h>
#include <fcntl.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>
#include <cerrno>
#include <cstring>
#include <chrono>
#include <mutex>
#include <sstream>
#include <vector>
namespace bench {
inline std::string mountPathDecode(const std::string &s){std::string out;for(size_t i=0;i<s.size();++i){if(s[i]=='\\'&&i+3<s.size()&&s[i+1]>='0'&&s[i+1]<='7'&&s[i+2]>='0'&&s[i+2]<='7'&&s[i+3]>='0'&&s[i+3]<='7'){out+=char((s[i+1]-'0')*64+(s[i+2]-'0')*8+s[i+3]-'0');i+=3;}else out+=s[i];}return out;}
// statfs may block on userspace/network filesystems. A same-identity child makes
// only syscall-wrapper calls; at most one unreaped child exists for this source.
inline std::string mountedFilesystemSources(){
  static std::mutex mutex;std::lock_guard<std::mutex> guard(mutex);static pid_t pending=0;static size_t cursor=0;
  if(pending){int status=0;pid_t r=waitpid(pending,&status,WNOHANG);if(r==0)return jsonObject({{"state",jsonString("previous filesystem query still terminating")},{"timedOut","true"}});if(r<0&&errno!=ECHILD)return jsonObject({{"waitErrno",std::to_string(errno)}});pending=0;}
  int fd=open("/proc/self/mountinfo",O_RDONLY|O_CLOEXEC);if(fd<0)return jsonObject({{"stage",jsonString("mountinfo")},{"errno",std::to_string(errno)}});
  std::vector<char> text(1048577);size_t used=0;int readError=0;while(used<text.size()){ssize_t n=read(fd,text.data()+used,text.size()-used);if(n<0){if(errno==EINTR)continue;readError=errno;break;}if(!n)break;used+=size_t(n);}close(fd);
  struct Mount{std::string id,path,type;};std::vector<Mount> mounts;bool limited=used==text.size();std::istringstream lines(std::string(text.data(),used));std::string line;
  while(std::getline(lines,line)){std::istringstream in(line);std::string id,parent,device,root,path,options,token,type;if(!(in>>id>>parent>>device>>root>>path>>options))continue;while(in>>token&&token!="-"){}if(token!="-"||!(in>>type))continue;if(mounts.size()==1024){limited=true;break;}mounts.push_back({id,mountPathDecode(path),type});}
  const size_t first=mounts.empty()?0:cursor%mounts.size();
  int pipes[2];if(pipe2(pipes,O_CLOEXEC))return jsonObject({{"stage",jsonString("pipe")},{"errno",std::to_string(errno)}});
  struct Row{uint32_t index;int error;struct statfs value;};std::vector<unsigned char> bytes((mounts.size()+1)*sizeof(Row));
  pid_t child=fork();if(child<0){int e=errno;close(pipes[0]);close(pipes[1]);return jsonObject({{"stage",jsonString("fork")},{"errno",std::to_string(e)}});}
  if(!child){close(pipes[0]);for(size_t i=0;i<mounts.size();++i){Row row{};row.index=uint32_t((first+i)%mounts.size());row.error=statfs(mounts[row.index].path.c_str(),&row.value)?errno:0;size_t sent=0;while(sent<sizeof(row)){ssize_t n=write(pipes[1],reinterpret_cast<char*>(&row)+sent,sizeof(row)-sent);if(n<0&&errno==EINTR)continue;if(n<=0)_exit(2);sent+=size_t(n);}}close(pipes[1]);_exit(0);}
  close(pipes[1]);auto now=[](){return std::chrono::steady_clock::now();};auto deadline=now()+std::chrono::milliseconds(250);size_t received=0;bool timeout=false,eof=false;int pipeError=0;
  while(received<bytes.size()){auto left=std::chrono::duration_cast<std::chrono::milliseconds>(deadline-now()).count();if(left<=0){timeout=true;break;}pollfd p{pipes[0],POLLIN|POLLHUP,0};int rc=poll(&p,1,int(left));if(rc<0){if(errno==EINTR)continue;pipeError=errno;break;}if(!rc){timeout=true;break;}ssize_t n=read(pipes[0],bytes.data()+received,bytes.size()-received);if(n<0){if(errno==EINTR)continue;pipeError=errno;break;}if(!n){eof=true;break;}received+=size_t(n);}
  close(pipes[0]);if(timeout||pipeError)kill(child,SIGKILL);int status=0;pid_t waited;do{waited=waitpid(child,&status,WNOHANG);}while(waited<0&&errno==EINTR);if(waited==0)pending=child;int waitError=waited<0?errno:0;
  std::string rows="[";size_t count=received/sizeof(Row);for(size_t i=0;i<count;++i){Row row{};memcpy(&row,bytes.data()+i*sizeof(Row),sizeof(Row));if(row.index>=mounts.size())continue;const auto &m=mounts[row.index];auto &v=row.value;std::string fields="null";
    if(!row.error)fields=jsonObject({{"f_type",jsonInteger(v.f_type)},{"f_bsize",jsonInteger(v.f_bsize)},{"f_blocks",jsonInteger(v.f_blocks)},{"f_bfree",jsonInteger(v.f_bfree)},{"f_bavail",jsonInteger(v.f_bavail)},{"f_files",jsonInteger(v.f_files)},{"f_ffree",jsonInteger(v.f_ffree)},{"f_namelen",jsonInteger(v.f_namelen)},{"f_frsize",jsonInteger(v.f_frsize)},{"f_flags",jsonInteger(v.f_flags)}});
    if(i)rows+=',';rows+=jsonObject({{"mountId",jsonString(m.id)},{"mountPoint",jsonString(m.path)},{"filesystemType",jsonString(m.type)},{"errno",std::to_string(row.error)},{"values",fields}});}
  std::string stalled="null";if(timeout&&count<mounts.size()){const auto &m=mounts[(first+count)%mounts.size()];stalled=jsonObject({{"mountId",jsonString(m.id)},{"mountPoint",jsonString(m.path)}});}
  if(!mounts.empty())cursor=(first+count+(timeout?1:0))%mounts.size();
  rows+=']';return jsonObject({{"firstMountIndex",std::to_string(first)},{"timedOutMount",stalled},{"mountinfoReadErrno",std::to_string(readError)},{"mountCount",std::to_string(mounts.size())},{"returnedCount",std::to_string(count)},{"limitReached",limited?"true":"false"},{"complete",eof&&count==mounts.size()&&!readError&&!limited?"true":"false"},{"timedOut",timeout?"true":"false"},{"pipeErrno",std::to_string(pipeError)},{"waitErrno",std::to_string(waitError)},{"childSignal",waited==child&&WIFSIGNALED(status)?std::to_string(WTERMSIG(status)):"null"},{"filesystems",rows},{"scope",jsonString("All visible mount points, same app identity. Bind/shared/snapshot mounts are not independent capacity and must not be summed. Non-atomic statfs queries may cause filesystem I/O; 250 ms child deadline retains partial results and prevents an indefinitely blocked filesystem from blocking app collection. After timeout, the next completed-child scan starts beyond that mount to cover remaining sources.")}});
}
}
