/** 停读接纳与排空结果分开；失败只允许同一宿主明确重试，不恢复业务受理。 */
export class SqliteHostShutdown {
 private current:'running'|'stopping'|'stopped'='running';
 private failed=false;
 private pending?:Promise<void>;
 private readonly release:()=>Promise<void>;
 constructor(release:()=>Promise<void>){this.release=release;}
 get state(){return this.current;}
 get shutdownFailed(){return this.failed;}
 begin():void{void this.stop().catch(()=>{});}
 stop():Promise<void>{
  if(this.pending)return this.pending;
  this.current='stopping';this.failed=false;
  return this.pending=Promise.resolve().then(this.release).then(()=>{this.current='stopped';},error=>{
   this.failed=true;this.pending=undefined;throw error;
  });
 }
}
