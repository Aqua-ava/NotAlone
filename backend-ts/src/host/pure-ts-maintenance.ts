/** 原分层维护的宿主寿命：PG通知只唤醒同一管理调度器，不另建任务写者。 */
import type pg from 'pg';
interface MaintenanceResult {nextDueAt?:string|Date|null;enqueued?:readonly string[]}
export class PureTsMaintenance {
 private readonly pool:pg.Pool;
 private readonly run:(signal:AbortSignal)=>Promise<MaintenanceResult>;
 private readonly controller=new AbortController();
 private listener:pg.PoolClient|undefined;
 private connecting:Promise<void>|undefined;
 private pending:Promise<void>|undefined;
 private timer:NodeJS.Timeout|undefined;
 private stopped=false;
 private again=false;
 constructor(pool:pg.Pool,run:(signal:AbortSignal)=>Promise<MaintenanceResult>){this.pool=pool;this.run=run;}
 private async listen(){
  if(this.listener||this.stopped)return;
  if(this.connecting)return this.connecting;
  const work=(async()=>{
   const client=await this.pool.connect();
   if(this.stopped){client.release();return;}
   const lost=()=>{if(this.listener===client){this.listener=undefined;client.release(true);this.schedule(1000);}};
   client.on('error',lost);client.on('end',lost);
   client.on('notification',notification=>{if(notification.channel==='layered_memory_changed')this.request();});
   this.listener=client;
   try{await client.query('LISTEN layered_memory_changed');}
   catch(error){if(this.listener===client){this.listener=undefined;client.release(true);}throw error;}
  })().finally(()=>{if(this.connecting===work)this.connecting=undefined;});this.connecting=work;return work;
 }
 private schedule(ms:number){
  if(this.stopped)return;clearTimeout(this.timer);
  this.timer=setTimeout(()=>{void this.tick();},ms);this.timer.unref();
 }
 request(){if(this.stopped)return;if(this.pending){this.again=true;return;}this.schedule(350);}
 private tick():Promise<void>{
  if(this.stopped)return Promise.resolve();
  if(this.pending){this.again=true;return this.pending;}
  let delay=30_000;
  const work=(async()=>{
   await this.listen();if(this.stopped)return;
   const result=await this.run(this.controller.signal);
   if(result.nextDueAt){const due=+new Date(result.nextDueAt);if(Number.isFinite(due))delay=Math.max(350,Math.min(30_000,due-Date.now()));}
  })().catch(()=>{delay=3000;}).finally(()=>{
   if(this.pending===work)this.pending=undefined;
   if(!this.stopped){this.schedule(this.again?350:delay);this.again=false;}
  });this.pending=work;return work;
 }
 async start(){await this.listen();this.request();}
 async close(){
  if(this.stopped)return;this.stopped=true;this.controller.abort();clearTimeout(this.timer);
  await Promise.allSettled([...(this.connecting?[this.connecting]:[]),...(this.pending?[this.pending]:[])]);
  const client=this.listener;this.listener=undefined;
  if(client){let failed=false;try{await client.query('UNLISTEN layered_memory_changed');}catch{failed=true;}finally{client.release(failed);}}
 }
}
