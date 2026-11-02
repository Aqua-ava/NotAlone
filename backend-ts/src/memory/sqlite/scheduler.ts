import {randomUUID} from 'node:crypto';

export interface MemoryL1SchedulerPort {
 recoverBacklog?():Promise<unknown>;
 nextDueAt(now:number):Promise<number|null>;
 dueContacts(now:number):Promise<string[]>;
 startContact(contactId:string,requestKey:string,now:number):Promise<unknown|null>;
 dueHistoryContacts?(now:number):Promise<string[]>;
 nextHistoryDueAt?(now:number):Promise<number|null>;
 startHistoryBatch?(contactId:string,requestKey:string,now:number):Promise<unknown|null>;
}
export interface MemoryL1SchedulerOptions {
 now?:()=>number;
 setTimeout?:(callback:()=>void,delayMs:number)=>unknown;
 clearTimeout?:(timer:unknown)=>void;
}

/** 从SQLite派生下一次到期时间；单timer只负责唤醒，不保存业务资格或待处理边界。 */
export class SqliteMemoryL1Scheduler {
 readonly #port:MemoryL1SchedulerPort;
 readonly #now:()=>number;
 readonly #setTimeout:(callback:()=>void,delayMs:number)=>unknown;
 readonly #clearTimeout:(timer:unknown)=>void;
 #timer:unknown|null=null;
 #scan?:Promise<void>;
 #rescan=false;
 #started=false;
 #closed=false;
 #closing?:Promise<void>;
 #lastHistoryContact:string|null=null;
 constructor(port:MemoryL1SchedulerPort,options:MemoryL1SchedulerOptions={}){
  this.#port=port;this.#now=options.now??Date.now;
  this.#setTimeout=options.setTimeout??((callback,delay)=>setTimeout(callback,delay));
  this.#clearTimeout=options.clearTimeout??(timer=>clearTimeout(timer as ReturnType<typeof setTimeout>));
 }
 start():Promise<void>{
  if(this.#closed)return Promise.resolve();
  this.#started=true;return this.scan();
 }
 /** 历史接受事件、启动或用户处理动作都只唤醒重扫，不扩大已冻结轮次。 */
 wake(_contactId?:string):Promise<void>{if(!this.#started||this.#closed)return Promise.resolve();return this.scan();}
 private scan():Promise<void>{
  if(this.#scan){this.#rescan=true;return this.#scan;}
  this.#scan=(async()=>{
   do{this.#rescan=false;await this.scanOnce();}while(this.#rescan&&!this.#closed);
  })().finally(()=>{this.#scan=undefined;});
  return this.#scan;
 }
 private clearTimer():void{if(this.#timer!==null){this.#clearTimeout(this.#timer);this.#timer=null;}}
 private arm(delayMs:number):void{
  if(this.#closed)return;
  this.clearTimer();
  this.#timer=this.#setTimeout(()=>{this.#timer=null;if(!this.#closed)void this.scan().catch(()=>{});},Math.max(0,Math.min(delayMs,2_147_483_647)));
 }
 private async scanOnce():Promise<void>{
  this.clearTimer();if(this.#closed)return;
  let started=0,failed=false;
  const historyEnabled=Boolean(this.#port.dueHistoryContacts&&this.#port.startHistoryBatch&&this.#port.nextHistoryDueAt);
  try{
   const contacts=await this.#port.dueContacts(this.#now());
   for(const contactId of contacts){
    if(this.#closed)return;
    try{if(await this.#port.startContact(contactId,randomUUID(),this.#now()))started++;}
    catch{failed=true;}
   }
   if(this.#closed)return;
   if(this.#port.recoverBacklog)await this.#port.recoverBacklog();
   if(this.#closed)return;
   if(historyEnabled){
    const due=await this.#port.dueHistoryContacts!(this.#now());
    const previous=this.#lastHistoryContact===null?-1:due.indexOf(this.#lastHistoryContact);
    const ordered=previous<0?due:[...due.slice(previous+1),...due.slice(0,previous+1)];
    for(const contactId of ordered){
     if(this.#closed)return;
     this.#lastHistoryContact=contactId;
     try{
      if(await this.#port.startHistoryBatch!(contactId,randomUUID(),this.#now())){started++;break;}
     }catch{failed=true;}
    }
   }
   if(this.#closed)return;
   const now=this.#now(),incremental=await this.#port.nextDueAt(now);
   const history=historyEnabled?await this.#port.nextHistoryDueAt!(now):null;
   const due=[incremental,history].filter((value):value is number=>value!==null);
   // 历史终页可能没有新增文字事件，有限周期重扫保证恢复导入及空终页也能被发现。
   if(historyEnabled)due.push(now+30_000);
   if(!due.length){if(failed)this.arm(5_000);return;}
   const delay=Math.min(...due)-this.#now();
   // 每次只执行一个历史小批，下一轮优先重新领取增量；资格变化或异常时避免忙重试。
   this.arm(failed?Math.max(5_000,delay):delay<=0?(started===0?1_000:1):delay);
  }catch{
   if(!this.#closed)this.arm(5_000);
  }
 }
 close():Promise<void>{return this.#closing??=(async()=>{this.#closed=true;this.#started=false;this.clearTimer();await this.#scan;})().catch(error=>{this.#closing=undefined;throw error;});}
}
