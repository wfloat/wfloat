#pragma once
#include <string>
#include <initializer_list>
#include <utility>
#include <sstream>
#include <iomanip>
#include <limits>
#include <cmath>
#include <locale>
namespace bench {
// Small serialization helpers for native source records, not a metric schema.
inline std::string jsonString(const std::string &s) {
  std::string out="\"";const char *hex="0123456789abcdef";
  for(unsigned char c:s) {if(c=='"'||c=='\\'){out+='\\';out+=c;}else if(c<32){out+="\\u00";out+=hex[c>>4];out+=hex[c&15];}else out+=c;}
  return out+'"';
}
inline std::string jsonObject(std::initializer_list<std::pair<std::string,std::string>> fields) {
  std::string out="{";bool first=true;for(const auto &f:fields){if(!first)out+=',';first=false;out+=jsonString(f.first)+":"+f.second;}return out+'}';
}
template<class T> inline std::string jsonReal(T value) {
  if(!std::isfinite(value))return jsonString(std::isnan(value)?"NaN":value<0?"-Infinity":"Infinity");
  std::ostringstream out;out.imbue(std::locale::classic());out<<std::setprecision(std::numeric_limits<T>::max_digits10)<<value;return out.str();
}
template<class T> inline std::string jsonInteger(T value) {return jsonString(std::to_string(value));}
}
