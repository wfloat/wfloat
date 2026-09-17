#include "../cpp/SourceCapture.h"
#include <cassert>
#include <sstream>
#include <thread>
int main(int argc, char **argv) {
  assert(argc==2); std::string dir=argv[1];
  {
    bench::SourceCapture capture(40,100);
    assert(capture.append(dir,"{\"value\":\"😀\"}")=="recording");
    auto file=capture.filePath();std::ifstream input(file);std::string line;std::getline(input,line);
    assert(line=="{\"value\":\"😀\"}");
    assert(capture.append(dir,std::string(40,'x'))=="size_limit");
    assert(capture.append(dir,"{}")=="size_limit");
    assert(std::filesystem::file_size(file)==line.size()+1);
  }
  {
    bench::SourceCapture capture(40,1);
    assert(capture.append(dir,"{}")=="size_limit");
  }
  {
    bench::SourceCapture capture;
    assert(capture.append(dir,"bad\nrecord")=="invalid_record");
    assert(capture.append(dir,"{}")=="recording");
  }
  {
    auto shared=dir+"/shared";
    bench::SourceCapture one(1000,300,"one"),two(1000,300,"two");
    auto write=[&](bench::SourceCapture &writer) { for(int i=0;i<100;++i) writer.append(shared,"{\"sample\":1}"); };
    std::thread a(write,std::ref(one)),b(write,std::ref(two));a.join();b.join();
    size_t bytes=0;for(auto &entry:std::filesystem::directory_iterator(shared)) bytes+=entry.file_size();
    assert(bytes<=300 && bytes>0);
    assert(one.append(shared,std::string(300,'x'))=="size_limit");
  }
  std::ofstream(dir+"/not-directory")<<"x";
  bench::SourceCapture denied;
  assert(denied.append(dir+"/not-directory/child","{}")=="io_failed");
}
