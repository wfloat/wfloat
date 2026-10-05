#include "../OrtAssets.h"
#include <fstream>
#include <iostream>
#include <sys/stat.h>
using wfloat_next::OrtAssetPath;
int main(int argc, char** argv) {
  try {
    // A real ORT session probe can hold the exact C++ alias open over stdin.
    if (argc == 2) {
      OrtAssetPath alias(argv[1]); std::cout << alias.path() << std::endl;
      std::string done; std::getline(std::cin, done); return 0;
    }
    char root[] = "/tmp/wfloat-ort-contract-XXXXXX";
    if (!mkdtemp(root)) throw std::runtime_error("mkdtemp failed");
    const std::string source = std::string(root)+"/opaque-hash";
    { std::ofstream out(source, std::ios::binary); out.write("0000ORTM",8); }
    std::string aliasPath, directory;
    {
      OrtAssetPath alias(source); aliasPath=alias.path();directory=aliasPath.substr(0,aliasPath.find_last_of('/'));
      if (aliasPath.substr(aliasPath.size()-4)!=".ort") throw std::runtime_error("Missing ORT suffix");
      struct stat src{},dst{},link{};
      if(stat(source.c_str(),&src)||stat(aliasPath.c_str(),&dst)||lstat(aliasPath.c_str(),&link)||src.st_ino!=dst.st_ino||!S_ISLNK(link.st_mode))throw std::runtime_error("Alias changed model identity");
      OrtAssetPath second(source);
      if(second.path()==aliasPath)throw std::runtime_error("Aliases overlap owners");
    }
    if(access(aliasPath.c_str(),F_OK)==0||access(directory.c_str(),F_OK)==0||access(source.c_str(),F_OK)!=0)throw std::runtime_error("Alias cleanup changed cache source");
    {OrtAssetPath existing(source+".ort");if(existing.path()!=source+".ort")throw std::runtime_error("Existing suffix changed");}
    bool rejected=false;try{OrtAssetPath bad(source+"-missing");}catch(const std::exception&){rejected=true;}
    if(!rejected)throw std::runtime_error("Missing source accepted");
    unlink(source.c_str());rmdir(root);
    std::cout<<"PASS ORT alias identity, ownership, cleanup, existing paths, missing source\n";
    return 0;
  }catch(const std::exception& e){std::cerr<<e.what()<<'\n';return 1;}
}
