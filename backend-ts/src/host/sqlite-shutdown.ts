/** 停读接纳与排空结果分开；失败只允许同一宿主明确重试，不恢复业务受理。 */
export class SqliteHostShutdown {
 private current:'running'|'stopping'|'stopped'='running';
 private failed=false;
 private failedNames:readonly string[]=[];
 private pending?:Promise<void>;
 private forcedKeys:readonly string[]=[];
 private readonly release:()=>Promise<void|{forced?:readonly string[]}>;
 constructor(release:()=>Promise<void|{forced?:readonly string[]}>){this.release=release;}
 get state(){return this.current;}
 get shutdownFailed(){return this.failed;}
 /** 最近一次停读失败涉及的资源键（固定名称，无业务内容）；未失败时为空。 */
 get failedResources():readonly string[]{return this.failedNames;}
 /** 本次停读中因超过阶段上限或孤儿调用而被强制放弃的资源键（固定名称，无业务内容）；正常停读为空。 */
 get forcedResources():readonly string[]{return this.forcedKeys;}
 begin():void{void this.stop().catch(()=>{});}
 stop():Promise<void>{
  if(this.pending)return this.pending;
  this.current='stopping';this.failed=false;this.failedNames=[];this.forcedKeys=[];
  return this.pending=Promise.resolve().then(this.release).then(report=>{
   const names=report?.forced;
   this.forcedKeys=Array.isArray(names)?names.filter((name):name is string=>typeof name==='string'&&/^[A-Za-z]{1,32}$/.test(name)).slice(0,20):[];
   this.current='stopped';},error=>{
   this.failed=true;this.pending=undefined;
   const names=(error as {resources?:unknown})?.resources;
   this.failedNames=Array.isArray(names)?names.filter((name):name is string=>typeof name==='string'&&/^[A-Za-z]{1,32}$/.test(name)).slice(0,20):[];
   throw error;
  });
 }
}
