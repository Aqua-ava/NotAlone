// PROTOTYPE：只对临时合成目录验证 FSEvents 是否能跨进程回放；不用于产品或微信。
#include <CoreServices/CoreServices.h>
#include <CoreFoundation/CoreFoundation.h>
#include <sys/stat.h>
#include <sys/mount.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>
#include <unistd.h>

static FSEventStreamEventId latest;
static int observed, history_done, untrusted;
static FSEventStreamEventFlags event_mask;
static int capture_mode;
static void callback(ConstFSEventStreamRef stream, void *context, size_t count, void *paths,
                     const FSEventStreamEventFlags flags[], const FSEventStreamEventId ids[]) {
    (void)stream; (void)context;
    for(size_t i=0;i<count;i++){
        CFStringRef path=CFArrayGetValueAtIndex((CFArrayRef)paths,(CFIndex)i);
        if(flags[i] & kFSEventStreamEventFlagHistoryDone) history_done=1;
        event_mask |= flags[i];
        if(flags[i] & (kFSEventStreamEventFlagMustScanSubDirs|kFSEventStreamEventFlagUserDropped|
                       kFSEventStreamEventFlagKernelDropped|kFSEventStreamEventFlagEventIdsWrapped|
                       kFSEventStreamEventFlagRootChanged)) untrusted=1;
        if(!(flags[i] & kFSEventStreamEventFlagHistoryDone) && (!capture_mode || CFStringHasSuffix(path,CFSTR("/marker")))){observed++;if(ids[i]>latest)latest=ids[i];}
    }
}
int main(int argc, char **argv) {
    if(argc!=4 || (strcmp(argv[1],"capture") && strcmp(argv[1],"replay"))) return 2;
    char root[PATH_MAX]; struct stat st; struct statfs fs;
    if(!realpath(argv[2],root) || stat(root,&st) || statfs(root,&fs)) return 3;
    size_t mountlen=strlen(fs.f_mntonname);
    // 本机 APFS 数据卷经 firmlink 挂载时，realpath 可省略 /System/Volumes/Data。
    const char *relative=strncmp(root,fs.f_mntonname,mountlen)==0?root+mountlen:root;
    if(*relative!='/') return 5;
    CFUUIDRef uuid=FSEventsCopyUUIDForDevice(st.st_dev);if(!uuid) return 6;
    CFStringRef uuidText=CFUUIDCreateString(NULL,uuid);char uuidBuffer[80];
    if(!CFStringGetCString(uuidText,uuidBuffer,sizeof(uuidBuffer),kCFStringEncodingUTF8)) return 7;
    CFRelease(uuidText);CFRelease(uuid);
    CFStringRef cfPath=CFStringCreateWithCString(NULL,relative,kCFStringEncodingUTF8);
    const void *values[]={cfPath};CFArrayRef paths=CFArrayCreate(NULL,values,1,&kCFTypeArrayCallBacks);
    capture_mode=!strcmp(argv[1],"capture");
    FSEventStreamEventId since=capture_mode?kFSEventStreamEventIdSinceNow:strtoull(argv[3],NULL,10);
    FSEventStreamRef stream=FSEventStreamCreateRelativeToDevice(NULL,callback,NULL,st.st_dev,paths,since,0.05,
      kFSEventStreamCreateFlagFileEvents|kFSEventStreamCreateFlagWatchRoot|kFSEventStreamCreateFlagUseCFTypes);
    CFRelease(paths);CFRelease(cfPath);if(!stream)return 8;
    FSEventStreamScheduleWithRunLoop(stream,CFRunLoopGetCurrent(),kCFRunLoopDefaultMode);
    if(!FSEventStreamStart(stream))return 9;
    if(!strcmp(argv[1],"capture")){
        char marker[PATH_MAX];snprintf(marker,sizeof(marker),"%s/marker",root);FILE *f=fopen(marker,"w");if(!f)return 10;fputs("synthetic",f);fclose(f);
    }
    for(int i=0;i<50 && ((!strcmp(argv[1],"capture")&&!observed)||(!strcmp(argv[1],"replay")&&!history_done));i++) CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.1,false);
    // 回放结束标志之后，观察短窗口内是否才收到已经发生的事件。
    if(!strcmp(argv[1],"replay") && history_done && !observed)
      for(int i=0;i<20 && !observed;i++) CFRunLoopRunInMode(kCFRunLoopDefaultMode,0.1,false);
    FSEventStreamFlushSync(stream);FSEventStreamStop(stream);FSEventStreamInvalidate(stream);FSEventStreamRelease(stream);
    printf("{\"uuid_present\":true,\"uuid\":\"%s\",\"latest\":%llu,\"observed\":%d,\"history_done\":%s,\"untrusted\":%s,\"created\":%s,\"removed\":%s,\"renamed\":%s,\"modified\":%s}\n",uuidBuffer,(unsigned long long)latest,observed,history_done?"true":"false",untrusted?"true":"false",event_mask&kFSEventStreamEventFlagItemCreated?"true":"false",event_mask&kFSEventStreamEventFlagItemRemoved?"true":"false",event_mask&kFSEventStreamEventFlagItemRenamed?"true":"false",event_mask&kFSEventStreamEventFlagItemModified?"true":"false");
    return untrusted||(!strcmp(argv[1],"capture")&&latest==0)||(!strcmp(argv[1],"replay")&&!history_done)?11:0;
}
