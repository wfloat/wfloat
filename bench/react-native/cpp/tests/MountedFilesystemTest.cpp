#include <sys/vfs.h>
#include <time.h>
#include <cerrno>
#include <cassert>
#include <chrono>
#include <cstdio>
int mode=0,calls=0;
int testStatfs(const char *path,struct statfs *value){
  if(mode==1&&++calls==4){timespec delay{3,0};nanosleep(&delay,nullptr);}
  if(mode==2){errno=EACCES;return -1;}
  return statfs(path,value);
}
#define statfs(path,value) testStatfs(path,value)
#include "../MountedFilesystemSources.h"
#undef statfs
int main(){
  assert(bench::mountPathDecode("/a\\040b\\134c")=="/a b\\c");
  mode=1;auto start=std::chrono::steady_clock::now();auto partial=bench::mountedFilesystemSources();
  assert(partial.find("\"timedOut\":true")!=std::string::npos&&partial.find("\"returnedCount\":3")!=std::string::npos);
  assert(std::chrono::steady_clock::now()-start<std::chrono::seconds(1));
  timespec settle{0,20000000};nanosleep(&settle,nullptr);mode=2;
  auto denied=bench::mountedFilesystemSources();assert(denied.find("\"complete\":true")!=std::string::npos&&denied.find("\"values\":null")!=std::string::npos&&denied.find("\"errno\":13")!=std::string::npos);
  puts("PASS: mount escape decoding, partial timeout, bounded return, child recovery and denied/null records");
}
