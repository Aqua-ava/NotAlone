/** 增量缺口的原库状态；首次完整历史分页属于独立执行者。 */
import type {HostStorage} from '../platform/database/host-storage.ts';
import type {IncrementalBinding,SyncIncrementalStore} from './sync-incremental-store.ts';

export interface IncrementalRecoveryState {
  contact_id:string;binding_id:string;phase:'gap_detected'|'backfilling'|'complete'|'failed'|'incomplete'|'paused';
  trigger_at:string;message_count:number;non_text_count:number;last_local_id:string|null;last_cursor:string|null;
  failure_code:string|null;started_at:string|null;completed_at:string|null;updated_at:string;
}
const columns='contact_id,binding_id,phase,trigger_at,message_count,non_text_count,last_local_id,last_cursor,failure_code,started_at,completed_at,updated_at';
const project=(row:Record<string,any>):IncrementalRecoveryState=>({...row,
  trigger_at:row.trigger_at.toISOString(),started_at:row.started_at?.toISOString()??null,
  completed_at:row.completed_at?.toISOString()??null,updated_at:row.updated_at.toISOString()}) as IncrementalRecoveryState;
const noop=()=>{};
export class SyncIncrementalRecovery {
  private readonly options:{store:SyncIncrementalStore;storage:HostStorage;ownerId:string};
  constructor(options:{store:SyncIncrementalStore;storage:HostStorage;ownerId:string}){this.options=options;}
  async list(check:()=>void=noop):Promise<IncrementalRecoveryState[]>{
    check();
    return this.options.storage.businessTransaction(async client=>{
      const rows=(await client.query(`SELECT ${columns.split(',').map(c=>'r.'+c).join(',')} FROM public.cli_backfill_state r
        JOIN public.conversation_binding b ON b.owner_id=r.owner_id AND b.contact_id=r.contact_id AND b.id=r.binding_id
        WHERE r.owner_id=$1 AND b.status='active' ORDER BY r.updated_at DESC,r.binding_id`,[this.options.ownerId])).rows;
      check();return rows.map(project);
    });
  }
  async prepare(binding:IncrementalBinding,options:{triggerAt?:Date;paused?:boolean;liveRead?:boolean},check:()=>void=noop):Promise<IncrementalRecoveryState|null>{
    return this.options.store.withBindingTransaction(binding,check,async client=>{
      const keys=[this.options.ownerId,binding.contact_id,binding.binding_id];
      let row=(await client.query(`SELECT ${columns} FROM public.cli_backfill_state WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 FOR UPDATE`,keys)).rows[0];
      if(options.paused&&!options.triggerAt)return options.liveRead?null:row?project(row):null;
      if(!row&&!options.triggerAt)return null;
      if(row?.phase==='complete'&&!options.triggerAt)return null;
      if(!row){
        row=(await client.query(`INSERT INTO public.cli_backfill_state(owner_id,contact_id,binding_id,phase,trigger_at)
          VALUES($1,$2,$3,'backfilling',$4) RETURNING ${columns}`,[...keys,options.triggerAt])).rows[0];
      }else if(row.phase==='complete'&&options.triggerAt){
        row=(await client.query(`UPDATE public.cli_backfill_state SET phase='backfilling',trigger_at=$4,message_count=0,
          non_text_count=0,last_local_id=NULL,last_cursor=NULL,failure_code=NULL,started_at=now(),completed_at=NULL,updated_at=now()
          WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 RETURNING ${columns}`,[...keys,options.triggerAt])).rows[0];
      }else{
        row=(await client.query(`UPDATE public.cli_backfill_state SET phase='backfilling',started_at=coalesce(started_at,now()),updated_at=now()
          WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 RETURNING ${columns}`,keys)).rows[0];
      }
      return project(row);
    });
  }
  async progress(binding:IncrementalBinding,options:{previous:IncrementalRecoveryState;messageCount:number;nonTextCount:number;lastLocalId:string|null;lastCursor:string|null;hasMore:boolean},check:()=>void=noop):Promise<IncrementalRecoveryState>{
    for(const n of [options.messageCount,options.nonTextCount])if(!Number.isSafeInteger(n)||n<0)throw new Error('backfill_invalid_count');
    if((options.lastLocalId===null)!==(options.lastCursor===null))throw new Error('backfill_invalid_cursor');
    return this.options.store.withBindingTransaction(binding,check,async client=>{
      const row=(await client.query(`UPDATE public.cli_backfill_state SET phase=$4,message_count=$5,non_text_count=$6,
        last_local_id=$7,last_cursor=$8,failure_code=NULL,completed_at=CASE WHEN $4='complete' THEN now() ELSE NULL END,updated_at=now()
        WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 AND trigger_at=$9 RETURNING ${columns}`,
        [this.options.ownerId,binding.contact_id,binding.binding_id,options.hasMore?'backfilling':'complete',
          options.previous.message_count+options.messageCount,options.previous.non_text_count+options.nonTextCount,
          options.lastLocalId,options.lastCursor,options.previous.trigger_at])).rows[0];
      if(!row)throw new Error('backfill_state_changed');return project(row);
    });
  }
  async fail(binding:IncrementalBinding,code:string,incomplete:boolean,check:()=>void=noop):Promise<void>{
    // 错误只接受稳定代码，不把CLI stderr或正文写进状态。
    if(!/^[a-z][a-z0-9_]{0,95}$/.test(code))code='cli_sync_failed';
    await this.options.store.withBindingTransaction(binding,check,async client=>{
      await client.query(`UPDATE public.cli_backfill_state SET phase=$4,failure_code=$5,completed_at=NULL,updated_at=now()
        WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3`,[this.options.ownerId,binding.contact_id,binding.binding_id,incomplete?'incomplete':'failed',code]);
    });
  }
  async pause(binding:IncrementalBinding,check:()=>void=noop):Promise<void>{
    await this.options.store.withBackfillPauseTransaction(binding,check,async client=>{
      await client.query(`UPDATE public.cli_backfill_state SET phase='paused',updated_at=now()
        WHERE owner_id=$1 AND contact_id=$2 AND binding_id=$3 AND phase<>'complete'`,[this.options.ownerId,binding.contact_id,binding.binding_id]);
    });
  }
}

export function incrementalRecoveryStatus(bindings:readonly IncrementalBinding[],states:readonly IncrementalRecoveryState[],priorityContact:string|null=null,expected=false):Record<string,unknown>{
  const valid=new Set(bindings.map(b=>b.binding_id));states=states.filter(s=>valid.has(s.binding_id));
  const total=expected?bindings.length:states.length;
  const by=(phases:string[])=>states.filter(s=>phases.includes(s.phase));
  const complete=by(['complete']),active=by(['gap_detected','backfilling']),failed=by(['failed']),incomplete=by(['incomplete']),paused=by(['paused']);
  const actual=incomplete.filter(s=>!['local_history_deleted','local_history_empty'].includes(s.failure_code??''));
  const current=states.find(s=>s.contact_id===priorityContact)??active[0]??paused[0]??incomplete[0]??failed[0]??states[0];
  const failure=actual[0]??failed[0]??incomplete[0];
  const phase=!expected&&!states.length?'not_required':active.length?'backfilling':actual.length?'incomplete':failed.length?'failed':incomplete.length?'incomplete':paused.length?'paused':states.length&&complete.length===total?'complete':'gap_detected';
  const skipped=complete.filter(s=>!s.message_count&&!s.non_text_count).length;
  return {backfill_phase:phase,backfill_contact_id:current?.contact_id??null,backfill_message_count:current?.message_count??0,
    backfill_non_text_count:current?.non_text_count??0,backfill_last_cursor:current?.last_cursor??null,
    backfill_failure_code:failure?.failure_code??current?.failure_code??null,backfill_total_contacts:total,
    backfill_completed_contacts:complete.length,backfill_succeeded_contacts:complete.length-skipped,backfill_skipped_contacts:skipped,
    backfill_failed_contacts:failed.length,backfill_incomplete_contacts:incomplete.length,backfill_pending_contacts:Math.max(0,total-complete.length),
    backfill_total_message_count:states.reduce((sum,s)=>sum+s.message_count,0),backfill_total_non_text_count:states.reduce((sum,s)=>sum+s.non_text_count,0)};
}
