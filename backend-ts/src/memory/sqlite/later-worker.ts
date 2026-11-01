/** 时间是调度边界；业务资格、合并窗口和执行结果始终由 SQLite 动作决定。 */
export interface LaterStagesQueue {
 nextDueAt():Promise<number|null>;
 runDueStages(now?:number):Promise<unknown>;
}
interface SchedulerClock {
 now():number;
 setTimer(callback:()=>void,delay:number):ReturnType<typeof setTimeout>;
 clearTimer(timer:ReturnType<typeof setTimeout>):void;
}
const systemClock:SchedulerClock={now:Date.now,setTimer:(callback,delay)=>setTimeout(callback,delay),clearTimer:clearTimeout};

/** 一个宿主只持有一个期限定时器；丢失通知与退出不丢失 SQLite 中的待处理事实。 */
export class SqliteMemoryLaterWorker {
 private timer?:ReturnType<typeof setTimeout>;
 private running?:Promise<void>;
 private requested=false;
 private stopped=false;
 private readonly queue:LaterStagesQueue;private readonly onError:(error:unknown)=>void;private readonly clock:SchedulerClock;
 constructor(queue:LaterStagesQueue,onError:(error:unknown)=>void,clock:SchedulerClock=systemClock){this.queue=queue;this.onError=onError;this.clock=clock;}
 start():void{this.wake();}
 wake():void{
  if(this.stopped)return;
  if(this.timer!==undefined){this.clock.clearTimer(this.timer);this.timer=undefined;}
  this.requested=true;
  if(this.running)return;
  const work=this.pump().catch(error=>this.onError(error));this.running=work;
  void work.finally(()=>{this.running=undefined;if(this.requested&&!this.stopped)this.wake();});
 }
 private async pump():Promise<void>{
  do{
   this.requested=false;
   await this.queue.runDueStages(this.clock.now());
   if(this.stopped)return;
   const dueAt=await this.queue.nextDueAt();
   if(this.stopped)return;
   if(!this.requested&&dueAt!==null)this.timer=this.clock.setTimer(()=>{this.timer=undefined;this.wake();},Math.max(0,Math.min(dueAt-this.clock.now(),2_147_483_647)));
  }while(this.requested&&!this.stopped);
 }
 /** 先停受理；宿主同时关闭文档执行器以中止在途调用，然后等待此 drain。 */
 close():Promise<void>{
  this.stopped=true;this.requested=false;
  if(this.timer!==undefined){this.clock.clearTimer(this.timer);this.timer=undefined;}
  return this.running??Promise.resolve();
 }
}
