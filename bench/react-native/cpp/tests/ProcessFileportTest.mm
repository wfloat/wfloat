#import <Foundation/Foundation.h>
#include <type_traits>
#include <mach/mach.h>
#include <fcntl.h>
static NSString *exact(uint64_t v){return [NSString stringWithFormat:@"%llu",(unsigned long long)v];}
static NSString *signedExact(int64_t v){return [NSString stringWithFormat:@"%lld",(long long)v];}
#include "../../ios/WfloatBench/DarwinProcessSources.h"
int main(){@autoreleasepool{
 auto read=[](){return darwinProcessSources();};
 NSDictionary *before=read();using Make=int(*)(int,mach_port_t*);auto make=(Make)dlsym(RTLD_DEFAULT,"fileport_makeport");assert(make);
 int fd=open("/dev/null",O_RDONLY);assert(fd>=0);mach_port_t port=0;assert(make(fd,&port)==0);NSDictionary *during=read();assert(mach_port_deallocate(mach_task_self(),port)==KERN_SUCCESS);close(fd);NSDictionary *after=read();
 auto contains=[](NSDictionary *s,mach_port_t port){for(NSDictionary *q in s[@"queries"])if([q[@"flavor"] isEqual:@"PROC_PIDLISTFILEPORTS"]){assert([q[@"valid"] boolValue]);for(NSDictionary *v in q[@"values"])if([v[@"portName"] longLongValue]==port)return true;}return false;};
 assert(!contains(before,port));assert(contains(during,port));assert(!contains(after,port));
 for(NSDictionary *q in during[@"queries"])if([q[@"flavor"] isEqual:@"PROC_PIDTBSDINFO"]){assert([q[@"returnedBytes"] intValue]==136);assert([q[@"values"][@"pid"] intValue]==getpid());}
 NSData *d=[NSJSONSerialization dataWithJSONObject:@{@"before":before,@"during":during,@"after":after,@"fileportLifecyclePassed":@YES} options:NSJSONWritingPrettyPrinted error:nil];fwrite(d.bytes,1,d.length,stdout);
}}
