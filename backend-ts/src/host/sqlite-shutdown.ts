/** 停读接纳与排空结果分开；失败只允许同一宿主明确重试，不恢复业务受理。 */
export class SqliteHostShutdown {
 private current:'running'|'stopping'|'stopped'='running';
 private failed=false;
 private failedNames:readonly string[]=[];
 private pending?:Promise<void>;
 private readonly release:()=>Promise<void>;
 constructor(release:()=>Promise<void>){this.release=release;}
 get state(){return this.current;}
 get shutdownFailed(){return this.failed;}
 /** 最近一次停读失败涉及的资源键（固定名称，无业务内容）；未失败时为空。 */
 get failedResources():readonly string[]{return this.failedNames;}
 begin():void{void this.stop().catch(()=>{});}
 stop():Promise<void>{
  if(this.pending)return this.pending;
  this.current='stopping';this.failed=false;this.failedNames=[];
  return this.pending=Promise.resolve().then(this.release).then(()=>{this.current='stopped';},error=>{
   this.failed=true;this.pending=undefined;
   const names=(error as {resources?:unknown})?.resources;
   this.failedNames=Array.isArray(names)?names.filter((name):name is string=>typeof name==='string'&&/^[A-Za-z]{1,32}$/.test(name)).slice(0,20):[];
   throw error;
  });
 }
}
