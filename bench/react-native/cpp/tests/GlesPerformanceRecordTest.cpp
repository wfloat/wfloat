#include "../GlesPerformanceProbe.h"
#include <cassert>
#include <cstdio>
int main(){
 std::vector<bench::GlesCounter> counters={{7,9,GL_UNSIGNED_INT64_AMD},{7,10,GL_UNSIGNED_INT},{7,11,GL_PERCENTAGE_AMD}};
 std::vector<GLuint> data={7,9,0xffffffffU,0xffffffffU,7,10,4000000000U,7,11,0};float f=12.5;memcpy(&data[9],&f,4);
 auto s=bench::glesPerformanceRecord(data,40,counters);assert(s.find("18446744073709551615")!=std::string::npos&&s.find("4000000000")!=std::string::npos&&s.find("12.5")!=std::string::npos&&s.find("\"completeTypedRecord\":true")!=std::string::npos);
 assert(bench::glesPerformanceRecord(data,39,counters).find("\"completeTypedRecord\":false")!=std::string::npos);
 assert(bench::glesPerformanceRecord(data,41,counters).find("exceeds backing")!=std::string::npos);
 data[5]=9;assert(bench::glesPerformanceRecord(data,40,counters).find("\"completeTypedRecord\":false")!=std::string::npos);
 data[5]=10;data[0]=99;assert(bench::glesPerformanceRecord(data,40,counters).find("\"completeTypedRecord\":false")!=std::string::npos);
 puts("PASS: exact mixed 32/64/float records, truncation, buffer bounds, duplicate and unknown IDs");
}
