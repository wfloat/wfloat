#include "../DescriptorSources.h"
#include <sys/wait.h>
#include <cstdlib>
#include <cstdio>
#include <string>
static void require(bool ok){if(!ok){std::fputs("descriptor lock regression failed\n",stderr);std::abort();}}
static bool childCanLock(const char *path){
  const pid_t child=fork();require(child>=0);
  if(child==0){int fd=open(path,O_RDWR);if(fd<0)_exit(3);struct flock lock{};lock.l_type=F_WRLCK;lock.l_whence=SEEK_SET;lock.l_len=1;int result=fcntl(fd,F_SETLK,&lock);int e=errno;close(fd);_exit(result==0?0:(e==EACCES||e==EAGAIN?1:2));}
  int status=0;require(waitpid(child,&status,0)==child&&WIFEXITED(status)&&WEXITSTATUS(status)<=1);return WEXITSTATUS(status)==0;
}
int main(int argc,char **argv){
  require(argc==2);std::string path=std::string(argv[1])+"/wfloat-lock-"+std::to_string(getpid());
  int fd=open(path.c_str(),O_CREAT|O_EXCL|O_RDWR,0600);require(fd>=0&&fd<512);
  struct flock lock{};lock.l_type=F_WRLCK;lock.l_whence=SEEK_SET;lock.l_len=1;
  require(fcntl(fd,F_SETLK,&lock)==0);require(!childCanLock(path.c_str()));
  int copy=dup(fd);require(copy>=0);require(close(copy)==0);require(childCanLock(path.c_str()));
  require(fcntl(fd,F_SETLK,&lock)==0);
  for(int i=0;i<10;++i){const auto captured=bench::descriptorSources();const auto needle=std::string("\"fd\":")+bench::jsonInteger(fd);require(captured.find(needle)!=std::string::npos);require(captured.find("direct_nonatomic_no_duplication")!=std::string::npos);require(!childCanLock(path.c_str()));}
  close(fd);require(unlink(path.c_str())==0);
  puts("{\"dupCloseReleasedPosixLock\":true,\"readOnlyCollectorPreservedLock\":true,\"scans\":10}");
}
