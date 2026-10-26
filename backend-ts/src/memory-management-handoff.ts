/** 公开记忆／偏好的 TS 请求门禁；提取及自动采纳仍属于各自生产任务。 */
import type {HostStorage} from './host-storage.ts';
import {MemoryError} from './memory-errors.ts';
export class MemoryManagementHandoff {
  private readonly owner='typescript';
  private accepting=false;
  private transitioning=false;
  private closed=false;
  private revision=0;
  private pending=new Set<Promise<void>>();
  private transition:Promise<unknown>|undefined;
  private readonly storage:HostStorage;
  constructor(storage:HostStorage){this.storage=storage;}
  status(){return {owner:this.owner,state:this.accepting?'running':this.transitioning?'transferring':'stopped',active_requests:this.pending.size,revision:this.revision};}
  enter(){
    if(!this.accepting||this.closed)throw new MemoryError('memory_management_transferring',503);
    const revision=this.revision;let resolve!:()=>void;
    const pending=new Promise<void>(done=>{resolve=done;});this.pending.add(pending);
    let finished=false;
    return {owner:this.owner,assertCurrent:()=>{
      if(this.closed||!this.accepting||revision!==this.revision)throw new MemoryError('memory_management_changed',409);
    },finish:()=>{if(finished)return;finished=true;this.pending.delete(pending);resolve();}};
  }
  async activate(){
    if(this.closed)throw new MemoryError('runtime_stopping',503);
    if(this.transitioning)throw new MemoryError('memory_management_transferring',409);
    this.transitioning=true;this.accepting=false;this.revision++;
    const operation=this.performActivation();this.transition=operation;
    try{return await operation;}finally{this.transitioning=false;this.transition=undefined;}
  }
  private async performActivation(){
    await Promise.all([...this.pending]);
    // HostStorage先核验全部原迁移清单。锁内再核对09依赖的原列；不建表或恢复旧库。
    await this.storage.businessTransaction(async client=>{
      const migration=(await client.query('SELECT pg_try_advisory_xact_lock(1852798049,1) AS locked')).rows[0];
      const lease=(await client.query("SELECT pg_try_advisory_xact_lock(hashtextextended('notalone:memory-management-handoff',0)) AS locked")).rows[0];
      if(!migration.locked||!lease.locked)throw new MemoryError('memory_management_lease_busy',503);
      const owner=this.storage.runtimeOwnerId?.toLowerCase();
      if(owner){
        const contacts=(await client.query('SELECT id FROM public.contact WHERE owner_id=$1 ORDER BY id',[owner])).rows;
        for(const contact of contacts)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`contact:${owner}:${contact.id}`]);
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);
      }
      const required:Record<string,Record<string,string>>={
        confirmed_memory:{id:'uuid',owner_id:'uuid',contact_id:'uuid',source_ids:'uuid[]',revision:'integer',version_evidence:'jsonb'},
        owner_memory:{id:'uuid',owner_id:'uuid',source_ids:'uuid[]',revision:'integer',version_evidence:'jsonb'},
        memory_candidate:{id:'uuid',owner_id:'uuid',contact_id:'uuid',correction_evidence:'jsonb',correction_decision_ids:'uuid[]'},
        memory_correction_decision:{id:'uuid',owner_id:'uuid',record_id:'uuid',evidence:'jsonb'},
        expression_preference:{id:'uuid',owner_id:'uuid',revision:'bigint',confirmed_operation_key:'uuid'},
        expression_preference_operation:{owner_id:'uuid',operation_key:'uuid'},
        expression_preference_state:{owner_id:'uuid',revision:'bigint'},
      };
      const rows=(await client.query("SELECT c.relname,a.attname,format_type(a.atttypid,a.atttypmod) AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped",[Object.keys(required)])).rows;
      for(const[table,columns]of Object.entries(required))for(const[column,type]of Object.entries(columns))if(!rows.some(row=>row.relname===table&&row.attname===column&&row.kind===type))throw new MemoryError('memory_management_schema_changed',503);
    });
    if(this.closed)throw new MemoryError('runtime_stopping',503);
    this.accepting=true;return this.status();
  }
  async close(){
    this.closed=true;this.accepting=false;this.revision++;
    // 等在途激活终止，避免关闭后迟到核验重新打开管理门禁。
    await Promise.allSettled([...(this.transition?[this.transition]:[]),...this.pending]);
  }
}
