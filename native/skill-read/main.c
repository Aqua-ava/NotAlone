/** 只读 Skill 包快照：逐段 openat，绝不跟随符号链接或输出物理路径。 */
#define _DARWIN_C_SOURCE
#include <sys/stat.h>
#include <dirent.h>
#include <fcntl.h>
#include <unistd.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <limits.h>

#define MAX_FILE (1024*1024)
#define MAX_TOTAL (4*MAX_FILE)
#define MAX_FILES 101
struct observed { char *path; struct stat before; int directory; };
struct observations { struct observed *values; size_t count,capacity; };
struct item { char path[PATH_MAX]; unsigned char *bytes; size_t length; };
static struct observations ancestors={0},nodes={0};
static struct item items[MAX_FILES];
static int item_count=0;
static size_t total=0;
static const char *error_code="skill_package_invalid";

static void fail(void) { fprintf(stdout,"{\"error\":\"%s\"}",error_code); exit(1); }
static void io_fail(void) { if(errno==ENOENT||errno==EACCES)error_code="skill_directory_unavailable";fail(); }
static int same_identity(struct stat *a,struct stat *b) { return a->st_dev==b->st_dev && a->st_ino==b->st_ino; }
static int same(struct stat *a,struct stat *b) {
 return same_identity(a,b) && a->st_mode==b->st_mode && a->st_nlink==b->st_nlink && a->st_size==b->st_size &&
 a->st_mtimespec.tv_sec==b->st_mtimespec.tv_sec && a->st_mtimespec.tv_nsec==b->st_mtimespec.tv_nsec &&
 a->st_ctimespec.tv_sec==b->st_ctimespec.tv_sec && a->st_ctimespec.tv_nsec==b->st_ctimespec.tv_nsec;
}
static void remember(struct observations *list,const char *path,struct stat before,int directory) {
 if(list->count==list->capacity){
  size_t capacity=list->capacity?list->capacity*2:32;
  if(capacity<list->capacity||capacity>SIZE_MAX/sizeof(struct observed))fail();
  void *grown=realloc(list->values,capacity*sizeof(struct observed));if(!grown)fail();
  list->values=grown;list->capacity=capacity;
 }
 char *saved=strdup(path);if(!saved)fail();
 list->values[list->count++]=(struct observed){.path=saved,.before=before,.directory=directory};
}
/** 返回绑定当前父目录的 FD；调用方完成使用后关闭，不累计保留整包 FD。 */
static int checked_open(int parent,const char *name,int directory,struct stat *info) {
 if(strlen(name)>NAME_MAX)fail();
 int fd=openat(parent,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|(directory?O_DIRECTORY:0));
 if(fd<0)io_fail();
 if(fstat(fd,info)!=0)io_fail();
 if(directory?!S_ISDIR(info->st_mode):(!S_ISREG(info->st_mode)||info->st_nlink!=1))fail();
 struct stat current;if(fstatat(parent,name,&current,AT_SYMLINK_NOFOLLOW)!=0)io_fail();
 if(!same(info,&current))fail();
 return fd;
}
static void unchanged(int fd,int parent,const char *name,struct stat *before) {
 struct stat current,location;
 if(fstat(fd,&current)!=0||fstatat(parent,name,&location,AT_SYMLINK_NOFOLLOW)!=0)io_fail();
 if(!same(before,&current)||!same(&current,&location))fail();
}
static int root_open(const char *path) {
 if(path[0]!='/'||strlen(path)>=PATH_MAX)fail();
 int current=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(current<0)io_fail();
 char copy[PATH_MAX];strcpy(copy,path);char *save=NULL,*part=strtok_r(copy,"/",&save);
 while(part){
  if(!strcmp(part,".")||!strcmp(part,".."))fail();
  struct stat info;int next=checked_open(current,part,1,&info);
  remember(&ancestors,part,info,1);close(current);current=next;part=strtok_r(NULL,"/",&save);
 }
 return current;
}
/** 重新逐段核对原祖先身份；兄弟目录变化不使已授权根产生新身份。 */
static void validate_root(int root) {
 int current=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(current<0)io_fail();
 for(size_t i=0;i<ancestors.count;i++){
  struct observed *entry=&ancestors.values[i];struct stat info;
  int next=checked_open(current,entry->path,1,&info);
  if(!same_identity(&entry->before,&info))fail();
  close(current);current=next;
 }
 struct stat bound,location;if(fstat(root,&bound)!=0||fstat(current,&location)!=0)io_fail();
 if(!same_identity(&bound,&location))fail();close(current);
}
static int valid_package(const char *name) {
 size_t n=strlen(name);if(n<1||n>64)return 0;
 for(size_t i=0;i<n;i++){char c=name[i];if((c>='a'&&c<='z')||(c>='0'&&c<='9'))continue;if(c=='-'&&i>0&&i+1<n&&name[i-1]!='-')continue;return 0;}return 1;
}
static void quoted(const char *s) {putchar('"');for(const unsigned char *c=(const unsigned char*)s;*c;c++){if(*c=='"'||*c=='\\'){putchar('\\');putchar(*c);}else if(*c<32)printf("\\u%04x",*c);else putchar(*c);}putchar('"');}
static void identity(int fd) {struct stat info;if(fstat(fd,&info)!=0)io_fail();printf("[\"%llu\",\"%llu\"]",(unsigned long long)info.st_dev,(unsigned long long)info.st_ino);}
static void check_root(int fd,const char *dev,const char *ino) {
 if(!strcmp(dev,"-")&&!strcmp(ino,"-"))return;
 struct stat info;if(fstat(fd,&info)!=0)io_fail();char d[32],i[32];snprintf(d,sizeof(d),"%llu",(unsigned long long)info.st_dev);snprintf(i,sizeof(i),"%llu",(unsigned long long)info.st_ino);
 if(strcmp(dev,d)||strcmp(ino,i)){error_code="skill_directory_conflict";fail();}
}
static struct dirent *next_entry(DIR *dir) {errno=0;struct dirent *entry=readdir(dir);if(!entry && errno)io_fail();return entry;}
/** 从绑定包 FD 逐段进入相对路径，只同时保留当前父子 FD，不限制资源目录层数。 */
static int open_relative(int package,const char *relative,int directory,struct stat *info) {
 if(strlen(relative)>=PATH_MAX)fail();
 if(!*relative){int fd=dup(package);if(fd<0||fstat(fd,info)!=0)io_fail();return fd;}
 char copy[PATH_MAX];strcpy(copy,relative);char *save=NULL,*part=strtok_r(copy,"/",&save);
 int current=dup(package);if(current<0)io_fail();
 while(part){
  if(!strcmp(part,".")||!strcmp(part,".."))fail();
  char *next_part=strtok_r(NULL,"/",&save);
  int next=checked_open(current,part,next_part?1:directory,info);close(current);current=next;part=next_part;
 }
 return current;
}
static void read_file(int parent,const char *name,const char *relative) {
 if(item_count>=MAX_FILES||strlen(relative)>=PATH_MAX)fail();struct stat before;int fd=checked_open(parent,name,0,&before);
 if(before.st_size<0||(!item_count&&before.st_size<1)||before.st_size>MAX_FILE)fail();
 unsigned char *bytes=malloc(MAX_FILE+1);if(!bytes)fail();size_t length=0;
 while(length<=MAX_FILE){ssize_t n=read(fd,bytes+length,MAX_FILE+1-length);if(n<0){if(errno==EINTR)continue;io_fail();}if(!n)break;length+=(size_t)n;}
 if(length>MAX_FILE||length!=(size_t)before.st_size)fail();
 if(item_count && (total+=length)>MAX_TOTAL)fail();
 unchanged(fd,parent,name,&before);remember(&nodes,relative,before,0);close(fd);
 struct item *item=&items[item_count++];strcpy(item->path,relative);item->bytes=bytes;item->length=length;
}
static int allowed_resource(const char *path) {
 const char *dot=strrchr(path,'.');if(!dot)return 0;
 const char *allowed[]={".csv",".json",".markdown",".md",".txt",".xml",".yaml",".yml",NULL};
 for(int i=0;allowed[i];i++)if(!strcasecmp(dot,allowed[i]))return 1;
 if(!strncmp(path,"assets/",7)&&(!strcasecmp(dot,".svg")||!strcasecmp(dot,".template")||!strcasecmp(dot,".tmpl")))return 1;
 return 0;
}
static void remember_directory(int parent,const char *name,const char *relative) {
 struct stat before;int child=checked_open(parent,name,1,&before);
 remember(&nodes,relative,before,1);unchanged(child,parent,name,&before);close(child);
}
static void resources(int package,size_t index) {
 struct observed observed=nodes.values[index];struct stat before;
 int fd=open_relative(package,observed.path,1,&before);if(!same(&before,&observed.before))fail();
 DIR *dir=fdopendir(dup(fd));if(!dir)io_fail();struct dirent *entry;
 while((entry=next_entry(dir))){const char *name=entry->d_name;if(!strcmp(name,".")||!strcmp(name,".."))continue;if(name[0]=='.'||strchr(name,'\\'))fail();
  char path[PATH_MAX];if(snprintf(path,sizeof(path),"%s/%s",observed.path,name)>=(int)sizeof(path))fail();
  struct stat info;if(fstatat(fd,name,&info,AT_SYMLINK_NOFOLLOW)!=0)io_fail();
  if(S_ISDIR(info.st_mode))remember_directory(fd,name,path);
  else if(S_ISREG(info.st_mode)){if(!allowed_resource(path))fail();read_file(fd,name,path);}else fail();
 }
 closedir(dir);struct stat after;if(fstat(fd,&after)!=0)io_fail();if(!same(&before,&after))fail();close(fd);
}
static void package_read(int fd,struct stat before) {
 remember(&nodes,"",before,1);
 DIR *dir=fdopendir(dup(fd));if(!dir)io_fail();struct dirent *entry;int body=0;
 while((entry=next_entry(dir))){const char *name=entry->d_name;if(!strcmp(name,".")||!strcmp(name,".."))continue;
  struct stat info;if(fstatat(fd,name,&info,AT_SYMLINK_NOFOLLOW)!=0)io_fail();
  if(!strcmp(name,"SKILL.md")&&S_ISREG(info.st_mode)){body=1;continue;}
  if((!strcmp(name,"references")||!strcmp(name,"assets"))&&S_ISDIR(info.st_mode))continue;fail();
 }
 closedir(dir);if(!body){error_code="skill_directory_unavailable";fail();}read_file(fd,"SKILL.md","SKILL.md");
 const char *folders[]={"references","assets"};
 for(int i=0;i<2;i++){struct stat info;if(fstatat(fd,folders[i],&info,AT_SYMLINK_NOFOLLOW)==0)remember_directory(fd,folders[i],folders[i]);else if(errno!=ENOENT)io_fail();}
 // 显式队列避免 C 递归深度或目录数量成为新的包合同；文件数及墙钟仍由既有预算限制。
 for(size_t i=1;i<nodes.count;i++)if(nodes.values[i].directory)resources(fd,i);
}
static void validate_package(int root,int package,const char *name) {
 for(size_t i=0;i<nodes.count;i++){
  struct observed *entry=&nodes.values[i];struct stat info;
  int fd=open_relative(package,entry->path,entry->directory,&info);
  if(!same(&entry->before,&info))fail();close(fd);
 }
 unchanged(package,root,name,&nodes.values[0].before);validate_root(root);
}
static void list_packages(int root) {
 struct observations names={0};DIR *dir=fdopendir(dup(root));if(!dir)io_fail();struct dirent *entry;
 while((entry=next_entry(dir))){if(!valid_package(entry->d_name))continue;struct stat info;if(fstatat(root,entry->d_name,&info,AT_SYMLINK_NOFOLLOW)!=0)io_fail();if(S_ISDIR(info.st_mode))remember(&names,entry->d_name,info,1);}
 closedir(dir);validate_root(root);printf("{\"names\":[");for(size_t i=0;i<names.count;i++){if(i)putchar(',');quoted(names.values[i].path);}printf("]}");
}
static void hex(const unsigned char *bytes,size_t n){static const char table[]="0123456789abcdef";putchar('"');for(size_t i=0;i<n;i++){putchar(table[bytes[i]>>4]);putchar(table[bytes[i]&15]);}putchar('"');}
int main(int argc,char **argv) {
 if(argc!=8)fail();const char *op=argv[1];int root=root_open(argv[2]);check_root(root,argv[4],argv[5]);
 if(!strcmp(op,"root")){validate_root(root);printf("{\"identity\":");identity(root);putchar('}');return 0;}
 if(!strcmp(op,"list")){list_packages(root);return 0;}
 if(!valid_package(argv[3]))fail();struct stat before;int fd=checked_open(root,argv[3],1,&before);
 if(!strcmp(op,"identity")){unchanged(fd,root,argv[3],&before);validate_root(root);printf("{\"identity\":");identity(fd);printf("}");return 0;}
 if(strcmp(op,"package"))fail();check_root(fd,argv[6],argv[7]);package_read(fd,before);validate_package(root,fd,argv[3]);
 printf("{\"identity\":");identity(fd);printf(",\"files\":[");for(int i=0;i<item_count;i++){if(i)putchar(',');printf("{\"path\":");quoted(items[i].path);printf(",\"hex\":");hex(items[i].bytes,items[i].length);putchar('}');}printf("]}");return 0;
}
