import {randomUUID} from 'node:crypto';

export interface MemoryScheduleContact {contactId:string;incrementalDueAt:number|null;historyDue:boolean}
export interface MemoryScheduleSnapshot {contacts:MemoryScheduleContact[]}
export interface MemoryL1SchedulerPort {
 recoverBacklog?():Promise<unknown>;
 scheduleContacts():Promise<string[]>;
 scanSchedule(now:number,contactIds:string[]):Promise<MemoryScheduleSnapshot>;
 startContact(contactId:string,requestKey:string,now:number):Promise<unknown|null>;
 startHistoryBatch?(contactId:string,requestKey:string,now:number):Promise<unknown|null>;
}
export interface MemoryL1SchedulerOptions {
 /** 记忆自动处理总开关；关闭时不扫描、不建轮、不留定时器，开启后由 wake 重新扫描。 */
 enabled?:()=>boolean;
 now?:()=>number;
 setTimeout?:(callback:()=>void,delayMs:number)=>unknown;
 clearTimeout?:(timer:unknown)=>void;
}

/** 内存只保存到期提示；实际建轮始终由SQLite复验资格和待处理范围。 */
export class SqliteMemoryL1Scheduler {
 readonly #port:MemoryL1SchedulerPort;
 readonly #now:()=>number;
 readonly #enabled:()=>boolean;
 readonly #setTimeout:(callback:()=>void,delayMs:number)=>unknown;
 readonly #clearTimeout:(timer:unknown)=>void;
 #timer:unknown|null=null;
 #scan?:Promise<void>;
 #rescan=false;
 #started=false;
 #closed=false;
 #closing?:Promise<void>;
 #lastHistoryContact:string|null=null;
 readonly #schedule=new Map<string,MemoryScheduleContact>();
 #globalDueAt=0;
 #globalDirty=true;
 readonly #dirtyContacts=new Set<string>();
 #retryAt=0;
 constructor(port:MemoryL1SchedulerPort,options:MemoryL1SchedulerOptions={}){
  this.#port=port;this.#now=options.now??Date.now;this.#enabled=options.enabled??(()=>true);
  this.#setTimeout=options.setTimeout??((callback,delay)=>setTimeout(callback,delay));
  this.#clearTimeout=options.clearTimeout??(timer=>clearTimeout(timer as ReturnType<typeof setTimeout>));
 }
 start():Promise<void>{
  if(this.#closed)return Promise.resolve();
  this.#started=true;return this.scan();
 }
 /** 历史接受事件、启动或用户处理动作都只唤醒重扫，不扩大已冻结轮次。 */
 wake(contactId?:string):Promise<void>{
  if(!this.#started||this.#closed)return Promise.resolve();
  if(contactId===undefined)this.#globalDirty=true;else this.#dirtyContacts.add(contactId);
  return this.scan();
 }
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
 private async refreshContacts(contactIds:string[]):Promise<void>{
  for(let offset=0;offset<contactIds.length;offset+=32){
   if(this.#closed)return;
   const batch=contactIds.slice(offset,offset+32);
   // 先消费当前唤醒；查询在途新增的同一联系人唤醒仍留给下一轮。
   for(const contactId of batch)this.#dirtyContacts.delete(contactId);
   const snapshot=await this.#port.scanSchedule(this.#now(),batch);
   if(this.#closed)return;
   for(const contactId of batch)this.#schedule.delete(contactId);
   for(const row of snapshot.contacts)if(batch.includes(row.contactId))this.#schedule.set(row.contactId,row);
  }
 }
 private async refreshAll():Promise<void>{
  const contacts=await this.#port.scheduleContacts();if(this.#closed)return;
  const current=new Set(contacts);
  for(const contactId of this.#schedule.keys())if(!current.has(contactId))this.#schedule.delete(contactId);
  await this.refreshContacts(contacts);this.#globalDueAt=this.#now()+30_000;
 }
 private async scanOnce():Promise<void>{
  if(!this.#enabled()){this.clearTimer();return;}
  this.clearTimer();if(this.#closed)return;
  if(this.#now()<this.#retryAt){this.arm(this.#retryAt-this.#now());return;}
  let started=0,failed=false;
  try{
   const current=this.#now();
   if(this.#globalDirty||current>=this.#globalDueAt){this.#globalDirty=false;await this.refreshAll();}
   else{
    const contacts=new Set(this.#dirtyContacts);
    for(const row of this.#schedule.values())if(row.historyDue||row.incrementalDueAt!==null&&row.incrementalDueAt<=current)contacts.add(row.contactId);
    await this.refreshContacts([...contacts]);
   }
   if(this.#closed)return;
   const now=this.#now();
   for(const row of [...this.#schedule.values()])if(row.incrementalDueAt!==null&&row.incrementalDueAt<=now){
    if(this.#closed)return;
    try{if(await this.#port.startContact(row.contactId,randomUUID(),this.#now()))started++;}
    catch{failed=true;}
    await this.refreshContacts([row.contactId]);
   }
   if(this.#closed)return;
   const recovered=await this.#port.recoverBacklog?.();
   // 自动恢复可能影响多位联系人；没有返回具体范围时才重新取得全局提示。
   if(recovered){this.#globalDirty=false;await this.refreshAll();}
   if(this.#closed)return;
   if(this.#port.startHistoryBatch){
    const due=[...this.#schedule.values()].filter(row=>row.historyDue).map(row=>row.contactId),previous=this.#lastHistoryContact===null?-1:due.indexOf(this.#lastHistoryContact);
    const ordered=previous<0?due:[...due.slice(previous+1),...due.slice(0,previous+1)];
    for(const contactId of ordered){
     if(this.#closed)return;
     this.#lastHistoryContact=contactId;let admitted=false;
     try{admitted=Boolean(await this.#port.startHistoryBatch(contactId,randomUUID(),this.#now()));if(admitted)started++;}
     catch{failed=true;}
     await this.refreshContacts([contactId]);if(admitted)break;
    }
   }
   if(this.#closed)return;
   const settledAt=this.#now(),due=[this.#globalDueAt];
   for(const row of this.#schedule.values()){
    if(row.incrementalDueAt!==null)due.push(row.incrementalDueAt);
    if(row.historyDue&&this.#port.startHistoryBatch)due.push(settledAt);
   }
   const delay=Math.min(...due)-settledAt;
   this.#retryAt=failed?settledAt+5_000:0;
   this.arm(failed?Math.max(5_000,delay):delay<=0?(started===0?1_000:1):delay);
  }catch{this.#globalDirty=true;this.#retryAt=this.#now()+5_000;if(!this.#closed)this.arm(5_000);}
 }
 close():Promise<void>{return this.#closing??=(async()=>{this.#closed=true;this.#started=false;this.clearTimer();await this.#scan;this.#schedule.clear();this.#dirtyContacts.clear();})().catch(error=>{this.#closing=undefined;throw error;});}
}
