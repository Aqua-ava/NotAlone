/** 原任务表的有界事件投影；不领取、不执行或恢复任务。 */
import type pg from 'pg';
import type {PureTsEvents} from './pure-ts-events.ts';
export class PureTsTaskEvents {
 private readonly pool:pg.Pool;
 private readonly owner:string|undefined;
 private readonly events:PureTsEvents;
 private readonly snapshots=new Map<string,string>();
 private stopped=false;
 private started=false;
 private timer:NodeJS.Timeout|undefined;
 private pending:Promise<void>|undefined;
 constructor(pool:pg.Pool,owner:string|undefined,events:PureTsEvents){this.pool=pool;this.owner=owner;this.events=events;}
 refresh():Promise<void>{
  if(this.stopped||!this.owner)return Promise.resolve();
  if(this.pending)return this.pending;
  const work=(async()=>{
   const rows=(await this.pool.query(`SELECT task.id AS task_id,task.contact_id,coalesce(task.current_step,'unknown') AS step,task.status,
      coalesce(step.processed_count,0)::int AS processed_count,coalesce(step.attempt_count,0)::int AS attempt_count,
      task.retry_count,task.last_error_code AS error_code
     FROM public.background_task task JOIN public.contact contact ON contact.owner_id=task.owner_id AND contact.id=task.contact_id
     LEFT JOIN public.background_task_step step ON step.task_id=task.id AND step.step_name=task.current_step
     WHERE task.owner_id=$1 ORDER BY task.updated_at DESC,task.id LIMIT 256`,[this.owner])).rows;
   if(this.stopped)return;
   const seen=new Set<string>();
   for(const row of rows){
    const {contact_id,...payload}=row;seen.add(payload.task_id);const encoded=JSON.stringify(payload);
    if(this.snapshots.get(payload.task_id)!==encoded){this.snapshots.set(payload.task_id,encoded);this.events.publish('task.progress',contact_id,payload);}
   }
   for(const task of this.snapshots.keys())if(!seen.has(task)){this.snapshots.delete(task);this.events.forgetTask(task);}
  })().finally(()=>{if(this.pending===work)this.pending=undefined;});this.pending=work;return work;
 }
 start(){
  if(this.started||this.stopped)return;this.started=true;
  const tick=()=>{void this.refresh().catch(()=>{}).finally(()=>{if(!this.stopped){this.timer=setTimeout(tick,1000);this.timer.unref();}});};tick();
 }
 async close(){this.stopped=true;clearTimeout(this.timer);await Promise.allSettled(this.pending?[this.pending]:[]);this.snapshots.clear();}
}
