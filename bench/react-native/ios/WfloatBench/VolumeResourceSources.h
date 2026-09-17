#pragma once
#import <Foundation/Foundation.h>
#include <sys/attr.h>
#include <unistd.h>
#include <cerrno>
#include <cstring>
// Independent fixed-size queries preserve returned-attribute validity. Never
// interpret the zero-filled buffer as a reported zero for unsupported attributes.
static NSDictionary *volumeResourceSources() {
  struct Entry {const char *name;uint32_t bit;size_t bytes;bool signedWord;};
  const Entry entries[]={
    {"sizeBytes",ATTR_VOL_SIZE,8,true},{"freeBytes",ATTR_VOL_SPACEFREE,8,true},
    {"availableBytes",ATTR_VOL_SPACEAVAIL,8,true},{"usedBytes",ATTR_VOL_SPACEUSED,8,true},
    {"quotaBytes",ATTR_VOL_QUOTA_SIZE,8,true},{"reservedBytes",ATTR_VOL_RESERVED_SIZE,8,true},
    {"minimumAllocationBytes",ATTR_VOL_MINALLOCATION,8,true},{"allocationClumpBytes",ATTR_VOL_ALLOCATIONCLUMP,8,true},
    {"ioBlockBytes",ATTR_VOL_IOBLOCKSIZE,4,false},{"objects",ATTR_VOL_OBJCOUNT,4,false},
    {"files",ATTR_VOL_FILECOUNT,4,false},{"directories",ATTR_VOL_DIRCOUNT,4,false},
    {"maximumObjects",ATTR_VOL_MAXOBJCOUNT,4,false},{"mountFlags",ATTR_VOL_MOUNTFLAGS,4,false},
    {"filesystemType",ATTR_VOL_FSTYPE,4,false},{"filesystemSubtype",ATTR_VOL_FSSUBTYPE,4,false},
    {"capabilitiesAndValidity",ATTR_VOL_CAPABILITIES,sizeof(vol_capabilities_attr_t),false},
    {"validAndNativeAttributes",ATTR_VOL_ATTRIBUTES,sizeof(vol_attributes_attr_t),false},
  };
  NSMutableArray *rows=[NSMutableArray new];
  for(auto &entry:entries){struct attrlist request{};request.bitmapcount=ATTR_BIT_MAP_COUNT;request.commonattr=ATTR_CMN_RETURNED_ATTRS;request.volattr=ATTR_VOL_INFO|entry.bit;
    unsigned char bytes[256]{};errno=0;double began=NSProcessInfo.processInfo.systemUptime;
    int code=getattrlist(NSHomeDirectory().UTF8String,&request,bytes,sizeof(bytes),0),error=code?errno:0;
    uint32_t length=0;memcpy(&length,bytes,4);attribute_set_t returned{};
    bool validHeader=!code&&length>=4+sizeof(returned)&&length<=sizeof(bytes);
    if(validHeader)memcpy(&returned,bytes+4,sizeof(returned));
    const size_t offset=4+sizeof(returned);bool present=validHeader&&(returned.volattr&entry.bit)&&length>=offset+entry.bytes;
    NSMutableDictionary *row=[@{@"name":@(entry.name),@"requestedVolumeBit":@(entry.bit),@"returnCode":@(code),@"errno":@(error),@"durationMs":@((NSProcessInfo.processInfo.systemUptime-began)*1000),@"returnedBytes":@(length),@"validHeader":@(validHeader),@"attributePresent":@(present),@"value":NSNull.null} mutableCopy];
    if(validHeader){row[@"returnedVolumeMask"]=@(returned.volattr);row[@"rawBase64"]=[[NSData dataWithBytes:bytes length:length] base64EncodedStringWithOptions:0];}
    if(present){if(entry.signedWord){int64_t value;memcpy(&value,bytes+offset,8);row[@"value"]=[NSString stringWithFormat:@"%lld",(long long)value];}
      else {NSMutableArray *words=[NSMutableArray new];for(size_t i=0;i<entry.bytes;i+=4){uint32_t word;memcpy(&word,bytes+offset+i,4);[words addObject:@(word)];}row[@"value"]=entry.bytes==4?words[0]:(id)words;}}
    [rows addObject:row];
  }
  return @{@"attributes":rows,@"scope":@"App-home volume. Native volume-wide/shared-container capacity and limits, not app usage. Independent queries are not an atomic snapshot. Returned attribute masks distinguish unsupported from zero. XNU synthesizes allocation clump from block size; object counts have native uint32 width. Capability and attribute arrays retain their paired validity masks."};
}

#include <sys/mount.h>
#include <vector>
static NSDictionary *mountedFilesystemSources(){
  errno=0;int required=getfsstat(nullptr,0,MNT_NOWAIT),error=required<0?errno:0;
  if(error)return @{@"errno":@(error),@"stage":@"count"};
  const size_t capacity=std::min<size_t>(4096,size_t(required)+8);std::vector<struct statfs> records(capacity);
  errno=0;int count=getfsstat(records.data(),int(records.size()*sizeof(struct statfs)),MNT_NOWAIT);error=count<0?errno:0;
  NSMutableArray *rows=[NSMutableArray new];
  if(!error)for(size_t i=0;i<std::min<size_t>(count,capacity);++i){auto &v=records[i];
    [rows addObject:@{@"filesystemId":@[@(v.f_fsid.val[0]),@(v.f_fsid.val[1])],@"type":@(v.f_type),@"subtype":@(v.f_fssubtype),@"filesystemType":[NSString stringWithUTF8String:v.f_fstypename]?:@"",@"flags":@(v.f_flags),@"blockSize":[NSString stringWithFormat:@"%u",v.f_bsize],@"optimalIoBytes":[NSString stringWithFormat:@"%d",v.f_iosize],@"blocks":[NSString stringWithFormat:@"%llu",(unsigned long long)v.f_blocks],@"freeBlocks":[NSString stringWithFormat:@"%llu",(unsigned long long)v.f_bfree],@"availableBlocks":[NSString stringWithFormat:@"%llu",(unsigned long long)v.f_bavail],@"files":[NSString stringWithFormat:@"%llu",(unsigned long long)v.f_files],@"freeFiles":[NSString stringWithFormat:@"%llu",(unsigned long long)v.f_ffree]}];}
  return @{@"errno":@(error),@"countAtSizing":@(required),@"returnedCount":@(count),@"limitReached":@(!error&&size_t(count)>=capacity),@"filesystems":rows,@"scope":@"All visible mounted-filesystem resource records; MNT_NOWAIT uses cached statistics without forcing filesystem I/O. Mount enumeration is not atomic; shared/bind/snapshot volumes must not be summed as independent physical capacity. Paths, volume labels and device names omitted."};
}
