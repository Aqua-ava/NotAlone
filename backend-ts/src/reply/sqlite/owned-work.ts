/** 在途生成登记：关闭后拒绝新工作，关闭时先撤销全部在途请求，再等待它们结算。 */
export class OwnedWork {
 private stopping=false;
 private closing?:Promise<void>;
 private readonly pending=new Set<Promise<unknown>>();
 private readonly controllers=new Set<AbortController>();
 get closed():boolean{return this.stopping;}
 /** 同步启动 `work`；传入的信号合并调用方信号与本登记的关闭信号，结算后自动移除登记。 */
 run<T>(external:AbortSignal|undefined,work:(signal:AbortSignal)=>Promise<T>):Promise<T>{
  const controller=new AbortController();this.controllers.add(controller);
  let pending:Promise<T>;
  try{pending=work(external?AbortSignal.any([controller.signal,external]):controller.signal);}
  catch(error){this.controllers.delete(controller);throw error;}
  this.pending.add(pending);const release=()=>{this.pending.delete(pending);this.controllers.delete(controller);};pending.then(release,release);return pending;
 }
 close():Promise<void>{
  this.stopping=true;for(const controller of this.controllers)controller.abort();
  return this.closing??=Promise.allSettled([...this.pending]).then(()=>{});
 }
}
