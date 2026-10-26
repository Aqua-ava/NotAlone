/** 全局元数据流与有界增量同步；前台定位和模型配置均不参与读取门禁。 */
import type {SyncScopeService} from './sync-scope.ts';
import type {WechatSessions} from './wechat-sessions.ts';
import type {SyncIncrementalCli} from './sync-incremental-cli.ts';
import type {IncrementalBinding,SyncIncrementalStore} from './sync-incremental-store.ts';
import {normalizeCliEvents,type IncrementalProcessingRecord} from './sync-incremental-normalize.ts';
import {SyncIncrementalRecovery,incrementalRecoveryStatus,type IncrementalRecoveryState} from './sync-incremental-recovery.ts';
import {parseJson} from '../host/host-json.ts';
import type {SyncHistory} from './sync-history.ts';

interface MessageCreated {owner_id:string;contact_id:string;message_id:string;occurred_at:string}
interface Options {
  ownerId:string;accountScope:string;store:SyncIncrementalStore;scope:SyncScopeService;
  sessions:WechatSessions;cli:SyncIncrementalCli;recovery:SyncIncrementalRecovery;
  history?:SyncHistory;
  publish:(events:readonly MessageCreated[],signal:AbortSignal)=>Promise<void>;
  clock?:()=>Date;heartbeatMs?:number;
}
class SyncStopped extends Error {readonly code='runtime_stopping';constructor(){super('同步已停止。');}}
const errorCode=(error:unknown)=>{
  const code=(error as {code?:unknown})?.code;
  return typeof code==='string'&&/^[a-z][a-z0-9_]{0,95}$/.test(code)?code:'cli_sync_failed';
};
const retryDelay=(count:number)=>Math.min(60_000,3000*2**Math.min(count-1,5));
const localTime=(iso:string)=>{
  const d=new Date(iso);if(!Number.isFinite(+d))throw new Error('baseline_invalid');
  // CLI以整数秒执行>=查询；向上取整，避免读到授权所在秒内更早的消息。
  d.setTime(Math.ceil(d.getTime()/1000)*1000);
  const pad=(n:number)=>String(n).padStart(2,'0');
  const value=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  // 无时区参数不能表达回拨后的重复时刻；拒绝退回更早的同名本地时间。
  if(new Date(value).getTime()!==d.getTime())throw new Error('baseline_invalid');
  return value;
};

export class SyncIncrementalEngine {
  private readonly options:Options;
  private stopped=false;
  private suspended=false;
  private epoch=0;
  private controller=new AbortController();
  private pending:Promise<Record<string,unknown>>|null=null;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private running=false;
  private stream:Awaited<ReturnType<SyncIncrementalCli['sessionEventsFollow']>>|null=null;
  private streamCursor:string|null=null;
  private streamRetryAt=0;
  private streamFailures=0;
  private streamFailure:string|null=null;
  private queue=new Map<string,boolean>();
  private retries=new Map<string,{count:number;at:number;code:string}>();
  private initial=true;
  private recoveryTrigger:Date|null=null;
  private recoveryPending=new Set<string>();
  private recoveryPaused=false;
  private sweepAt=0;
  private sweepIndex=0;
  private discoverAt=0;
  private scopeFailure:string|null=null;
  private priority:string|null=null;
  private priorityAt=0;
  private priorityRequestedAt:number|null=null;
  private promotedLastCycle=false;
  private controlVersion=0;
  private controlTail:Promise<unknown>=Promise.resolve();
  private version:string|null=null;
  private followEnabled=false;
  private cliAvailable:boolean|null=null;
  private cliFailure:string|null=null;
  private currentStatus:Record<string,unknown>={phase:'disabled',stream_active:false,stream_mode:null,failure_code:null,bound_count:0,pending_count:0,history_coverages:[]};
  constructor(options:Options){this.options=options;this.recoveryTrigger=this.now();}
  private now(){return (this.options.clock??(()=>new Date()))();}
  status(){return {...this.currentStatus,cli_available:this.cliAvailable,cli_failure_code:this.cliFailure,sync_scope_failure_code:this.scopeFailure};}
  followStatus(){const active=!!this.stream&&!this.stream.closed;return {enabled:this.followEnabled,stream_active:active,
    process_id:active?this.stream!.process_id:null,mode:active?'global_follow':'bounded_polling',watermark:null};}
  setFollowEnabled(enabled:boolean){this.followEnabled=enabled;}
  async interruptFollow(){
    if(!this.followEnabled||!this.stream||this.stream.closed)throw Object.assign(new Error('没有可中断的诊断流。'),{code:'cli_follow_inactive'});
    await this.stopStream('cli_follow_failed');
  }
  setPriority(contactId:string|null,_requestedAt?:number|null){
    if(contactId!==this.priority){
      this.priorityAt=0;
      this.priorityRequestedAt=performance.now();
      this.currentStatus={...this.currentStatus,priority_last_success_at:null,priority_last_failure_code:null,
        priority_last_duration_ms:null,priority_last_cli_duration_ms:null,priority_last_store_duration_ms:null,
        priority_local_history_state:null,priority_queue_wait_ms:null};
    }
    this.priority=contactId;
  }
  requestCheck(){this.initial=true;this.recoveryTrigger=this.now();this.recoveryPending.clear();this.retries.clear();this.streamRetryAt=0;this.sweepAt=0;this.discoverAt=0;this.recoveryPaused=false;}
  start(){
    if(this.stopped)throw new SyncStopped();if(this.running)return;this.running=true;
    const tick=async()=>{
      if(!this.running||this.stopped)return;
      try{await this.cycle();}catch{this.currentStatus={...this.currentStatus,phase:'degraded',failure_code:'cli_sync_failed'};}
      if(this.running&&!this.stopped)this.timer=setTimeout(tick,this.options.heartbeatMs??3000);
    };
    void tick();
  }
  /** 同步失效发生在首次await之前，调用方随后修改唯一权威状态并调用resume。 */
  async invalidateAndDrain(_reason:string):Promise<number>{
    const version=++this.controlVersion;this.suspended=true;this.epoch++;this.controller.abort();
    const stream=this.stream;this.stream=null;
    // 捕获已有控制写入；后来的stop也会使其提交前check失效，不能排空后再resume。
    await Promise.allSettled([stream?.close(),this.pending,this.controlTail]);
    this.queue.clear();this.retries.clear();this.initial=true;this.sweepAt=0;this.priorityAt=0;
    this.streamRetryAt=0;this.streamFailures=0;this.streamFailure=null;
    return version;
  }
  resume(expectedVersion?:number){if(this.stopped||expectedVersion!==undefined&&expectedVersion!==this.controlVersion)return false;this.controller=new AbortController();this.suspended=false;this.requestCheck();return true;}
  async setEnabled(enabled:boolean,options:{maxBindings?:number;signal?:AbortSignal;assertCurrent?:()=>void}={}):Promise<Record<string,unknown>>{
    if(this.stopped)throw new SyncStopped();
    const externalCheck=()=>{if(this.stopped||options.signal?.aborted)throw new SyncStopped();options.assertCurrent?.();};
    externalCheck();
    const previousControl=this.controlTail;
    const drained=this.invalidateAndDrain(enabled?'enable':'disable');
    const version=this.controlVersion;
    const check=()=>{externalCheck();if(version!==this.controlVersion)throw new SyncStopped();};
    const work=previousControl.catch(()=>{}).then(async()=>{
      await drained;check();
      await this.options.store.setEnabled(enabled,check);
      if(version===this.controlVersion){this.resume();return this.cycle({...options,maxBindings:options.maxBindings??1});}
      return this.status();
    });
    this.controlTail=work;return work;
  }
  async close():Promise<void>{
    if(this.stopped)return;this.stopped=true;this.running=false;
    if(this.timer)clearTimeout(this.timer);this.timer=null;
    await this.invalidateAndDrain('shutdown');
    await Promise.allSettled([this.controlTail]);
    await Promise.all([this.options.cli.close(),this.options.sessions.close()]);
  }
  async pauseBackfill(options:{signal?:AbortSignal;assertCurrent?:()=>void}={}):Promise<void>{
    const externalCheck=()=>{if(this.stopped||options.signal?.aborted)throw new SyncStopped();options.assertCurrent?.();};
    externalCheck();
    const previousControl=this.controlTail;
    const drained=this.invalidateAndDrain('pause_backfill'),version=this.controlVersion;
    const check=()=>{externalCheck();if(version!==this.controlVersion)throw new SyncStopped();};
    const work=previousControl.catch(()=>{}).then(async()=>{
      await drained;check();
      for(const binding of await this.options.store.listBindings(check))await this.options.recovery.pause(binding,check);
      check();
      this.resume();this.recoveryPaused=true;this.recoveryTrigger=null;this.recoveryPending.clear();
    }).catch(error=>{check();throw error;});
    this.controlTail=work;return work;
  }

  cycle(options:{maxBindings?:number;signal?:AbortSignal;assertCurrent?:()=>void}={}):Promise<Record<string,unknown>>{
    if(this.pending)return this.pending;
    const budget=options.maxBindings??32;
    if(!Number.isInteger(budget)||budget<1||budget>32)return Promise.reject(new Error('invalid_sync_budget'));
    if(this.stopped||this.suspended)return Promise.resolve(this.status());
    const epoch=this.epoch,signal=options.signal?AbortSignal.any([this.controller.signal,options.signal]):this.controller.signal;
    const check=()=>{if(this.stopped||this.suspended||epoch!==this.epoch||signal.aborted)throw new SyncStopped();options.assertCurrent?.();};
    const run=this.run(budget,signal,check).catch(error=>{
      const code=errorCode(error);
      if(code.startsWith('cli_')&&code!=='cli_normalization_failed'){this.cliAvailable=false;this.cliFailure=code;}
      this.currentStatus={...this.currentStatus,phase:code==='runtime_stopping'?'disabled':'degraded',failure_code:code==='runtime_stopping'?null:code};
      return this.status();
    }).finally(()=>{if(this.pending===run)this.pending=null;});
    this.pending=run;return run;
  }
  private enqueue(locator:string,live:boolean){this.queue.set(locator,live||this.queue.get(locator)||false);}
  private async stopStream(code:string){
    const stream=this.stream;this.stream=null;await stream?.close();
    this.streamFailure=code;this.streamFailures=Math.min(6,this.streamFailures+1);
    this.streamRetryAt=code==='cli_follow_unsupported'?Infinity:+this.now()+retryDelay(this.streamFailures);
  }
  private async run(budget:number,signal:AbortSignal,check:()=>void):Promise<Record<string,unknown>>{
    const cycleStarted=performance.now();
    const remaining=()=>{const time=3000-(performance.now()-cycleStarted);if(time<=0)throw Object.assign(new Error('CLI预算耗尽。'),{code:'cli_timeout'});return time;};
    check();const enabled=await this.options.store.readEnabled(check);
    if(!enabled){
      const stream=this.stream;this.stream=null;await stream?.close();this.queue.clear();this.initial=true;
      const bindings=await this.options.store.listBindings(check);
      const historyCoverages=this.options.history?await this.options.history.coverages(bindings,check):[];
      this.currentStatus={phase:'disabled',stream_active:false,stream_mode:null,failure_code:null,bound_count:bindings.length,pending_count:0,
        history_coverages:historyCoverages,...incrementalRecoveryStatus(bindings,await this.options.recovery.list(check),this.priority)};
      return this.status();
    }
    const now=+this.now();
    if(now>=this.discoverAt){
      this.discoverAt=now+60_000;
      try{
        if(await this.options.scope.canDiscover(check)){
          // 元数据发现独立限时；失败不阻断已确认绑定，正文仍逐页复验账号。
          const discoverySignal=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Math.floor(Math.min(1000,remaining()))))]);
          const sessions=await this.options.sessions.sessions({type_filter:'private',limit:5000,expected_account:this.options.accountScope,signal:discoverySignal});check();
          await this.options.scope.enroll(sessions,check);
        }
        this.scopeFailure=null;
      }catch(error){
        check();const code=errorCode(error);
        this.scopeFailure=['sync_scope_identity_conflict','sync_scope_session_limit'].includes(code)?code:'sync_scope_discovery_failed';
      }
    }
    const bindings=await this.options.store.listBindings(check);check();
    const byLocator=new Map(bindings.map(b=>[b.conversation_locator,b]));
    for(const locator of this.queue.keys())if(!byLocator.has(locator))this.queue.delete(locator);
    for(const id of this.retries.keys())if(!bindings.some(b=>b.binding_id===id))this.retries.delete(id);
    if(!bindings.length){await this.stream?.close();this.stream=null;this.initial=true;
      this.currentStatus={phase:'waiting_bindings',stream_active:false,stream_mode:null,failure_code:null,bound_count:0,pending_count:0,history_coverages:[]};return this.status();}
    let historyFailure:string|null=null;
    if(this.options.history)try{await this.options.history.ensureStarted(bindings,check);}catch(error){check();historyFailure='history_state_unavailable';}
    await this.options.cli.configuredAccount({expectedAccount:this.options.accountScope,signal,timeoutMs:remaining()});check();
    this.cliAvailable=true;this.cliFailure=null;
    if(!this.stream&&now>=this.streamRetryAt){
      try{this.stream=await this.options.cli.sessionEventsFollow({cursor:this.streamCursor??undefined,scanLimit:5000,pollInterval:'3s',signal});}
      catch(error){check();await this.stopStream(errorCode(error));}
    }
    const changed=new Set<string>();
    if(this.stream){
      const live=this.streamCursor!==null;
      try{for(let n=0;n<128;n++){
        const event=await this.stream.read({timeoutMs:0,signal});if(!event)break;
        this.streamCursor=event.cursor;this.streamFailures=0;this.streamFailure=null;
        if(byLocator.has(event.conversation_locator)){this.enqueue(event.conversation_locator,live);if(live)changed.add(event.conversation_locator);}
      }}catch(error){check();await this.stopStream(errorCode(error));}
    }
    if(this.initial){
      for(const binding of bindings){this.enqueue(binding.conversation_locator,false);this.recoveryPending.add(binding.conversation_locator);}
      this.initial=false;this.sweepAt=now;
    }else if(!this.queue.size&&now-this.sweepAt>=15_000){
      for(let n=0;n<Math.min(8,bindings.length);n++)this.enqueue(bindings[(this.sweepIndex+n)%bindings.length].conversation_locator,true);
      this.sweepIndex=(this.sweepIndex+8)%bindings.length;this.sweepAt=now;
    }
    for(const binding of bindings){const retry=this.retries.get(binding.binding_id);if(retry&&now>=retry.at)this.enqueue(binding.conversation_locator,false);}
    const priority=bindings.find(b=>b.contact_id===this.priority);
    if(priority&&now-this.priorityAt>=3000)this.enqueue(priority.conversation_locator,true);
    // 当前联系人每轮至多一页；余量仍按原队列顺序服务其他联系人。
    const work=[...this.queue.keys()];
    if(priority&&work.includes(priority.conversation_locator)&&now-this.priorityAt>=3000){
      if(work.length>1&&this.promotedLastCycle)this.promotedLastCycle=false;
      else {work.splice(work.indexOf(priority.conversation_locator),1);work.unshift(priority.conversation_locator);this.promotedLastCycle=true;}
    }
    let written=0,failure:string|null=this.streamFailure;let processed=0;
    for(const locator of work){
      if(processed>=budget||performance.now()-cycleStarted>=3000)break;check();
      const live=this.queue.get(locator)??false;this.queue.delete(locator);
      const binding=byLocator.get(locator);if(!binding)continue;
      const retry=this.retries.get(binding.binding_id);
      if(retry&&now<retry.at&&!changed.has(locator))continue;
      processed++;
      const started=performance.now();let recovery:IncrementalRecoveryState|null=null;
      let cliDuration=0,storeDuration:number|null=null;
      const callCli=async<T>(operation:()=>Promise<T>):Promise<T>=>{
        const began=performance.now();
        try{const result=await operation();this.cliAvailable=true;this.cliFailure=null;return result;}
        catch(error){this.cliAvailable=false;this.cliFailure=errorCode(error);throw error;}
        finally{cliDuration+=performance.now()-began;}
      };
      try{
        if(!await this.options.store.readEnabled(check))throw new SyncStopped();
        if(this.options.history){
          const historyStep=await this.options.history.readPage(binding,{signal,timeoutMs:remaining,check});
          if(historyStep.phase!=='not_required'){
            this.cliAvailable=true;this.cliFailure=null;
            written+=historyStep.message_count;
            this.retries.delete(binding.binding_id);
            // 历史页完成后下一片才进入增量；期间不发布逐条消息事件。
            this.enqueue(locator,live);
            if(binding===priority)this.currentStatus={...this.currentStatus,priority_last_success_at:this.now().toISOString(),priority_last_failure_code:null};
            continue;
          }
        }
        const position=await this.options.store.readPosition(binding,check);check();
        if(position.history_busy){this.recoveryPending.delete(locator);continue;}
        const resolved=await callCli(()=>this.options.cli.resolveChat(locator,{signal,timeoutMs:Math.min(1000,remaining())}));check();
        if(resolved.candidates.length!==1||resolved.candidates[0].username!==locator||resolved.candidates[0].chat_type!=='private'){
          throw Object.assign(new Error('未核实私聊。'),{code:'cli_scope_unverified'});
        }
        recovery=await this.options.recovery.prepare(binding,{triggerAt:this.recoveryPending.has(locator)?this.recoveryTrigger??undefined:undefined,paused:this.recoveryPaused,liveRead:live},check);
        if(recovery?.phase==='paused'&&!live)continue;
        const page=await callCli(()=>this.options.cli.tail(locator,{...(position.cursor?{cursor:position.cursor.last_cursor}:{sinceTime:localTime(position.query_since_at)}),signal,timeoutMs:remaining()}));check();
        await callCli(()=>this.options.cli.configuredAccount({expectedAccount:this.options.accountScope,signal,timeoutMs:remaining()}));check();
        if(binding===priority)this.currentStatus={...this.currentStatus,priority_local_history_state:page.local_history_state};
        if(page.local_history_state)throw Object.assign(new Error('本机历史不可读。'),{code:`local_history_${page.local_history_state}`});
        if(!page.freshness_confirmed&&(page.events.length||page.cursor!==null||page.last_local_id!==null||recovery))throw Object.assign(new Error('水位未确认。'),{code:'cli_freshness_unknown'});
        if(page.has_more&&(!page.cursor||!page.last_local_id||page.cursor===position.cursor?.last_cursor))throw Object.assign(new Error('游标未前进。'),{code:'cli_output_invalid'});
        if((page.cursor===null)!==(page.last_local_id===null))throw Object.assign(new Error('游标不完整。'),{code:'cli_output_invalid'});
        const receipts:IncrementalProcessingRecord[]=[];
        const messages=normalizeCliEvents(page.events,{processingReceipts:receipts});
        let acceptedMessageCount=0;
        if(page.cursor!==null&&page.last_local_id!==null){
          this.version??=await callCli(()=>this.options.cli.version({signal,timeoutMs:remaining()}));check();
          const storeStarted=performance.now();
          const batch=await this.options.store.save({binding,page,messages,since_cursor:position.cursor?.last_cursor??null,
            since_local_id:position.cursor?.last_local_id??null,cli_version:this.version,position_token:position.position_token,
            processing_records:[...receipts,...page.filtered_records].sort((a,b)=>Number((parseJson(a.payload_json) as Record<string,unknown>).input_position??0)-Number((parseJson(b.payload_json) as Record<string,unknown>).input_position??0))},check);
          storeDuration=performance.now()-storeStarted;
          acceptedMessageCount=batch.accepted_message_count;written+=acceptedMessageCount;
          const events=batch.created_message_ids.flatMap((id,index)=>id?[{owner_id:this.options.ownerId,contact_id:binding.contact_id,message_id:id,occurred_at:messages[index].occurred_at??this.now().toISOString()}]:[]);
          if(events.length){
            try{
              // 提交后的通知共用本轮剩余预算；投递失败由原持久提取回执补偿。
              const eventSignal=AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,Math.floor(remaining())))]);
              await this.options.publish(events,eventSignal);
            }catch{failure='message_event_delivery_failed';}
          }
        }
        if(recovery)await this.options.recovery.progress(binding,{previous:recovery,messageCount:acceptedMessageCount,nonTextCount:page.non_text_count,
          lastLocalId:page.last_local_id??position.cursor?.last_local_id??null,lastCursor:page.cursor??position.cursor?.last_cursor??null,hasMore:page.has_more},check);
        this.retries.delete(binding.binding_id);
        if(page.has_more)this.enqueue(locator,live);else this.recoveryPending.delete(locator);
        if(binding===priority)this.currentStatus={...this.currentStatus,priority_last_success_at:this.now().toISOString(),priority_last_failure_code:null};
      }catch(error){
        check();const code=errorCode(error);failure=code;
        const failureRecord=(error as {failure_record?:IncrementalProcessingRecord}).failure_record;
        if(failureRecord)try{await this.options.store.recordInputFailure(binding,failureRecord,check);}catch{check();failure='source_processing_write_failed';}
        if(this.options.history&&['cli_scope_unverified','cli_chat_not_private'].includes(code)){
          try{await this.options.history.markScopeIncomplete(binding,code,check);}
          catch{check();failure='history_state_unavailable';}
        }
        const count=(retry?.count??0)+1;
        if(code.startsWith('cli_')){this.cliAvailable=false;this.cliFailure=code;}
        this.retries.set(binding.binding_id,{count,at:now+(['cli_scope_unverified','cli_chat_not_private','local_history_deleted','local_history_empty','history_empty'].includes(code)?300_000:Math.min(300_000,5000*2**Math.min(count-1,6))),code});
        if(recovery)try{await this.options.recovery.fail(binding,code,['cli_freshness_unknown','cli_output_invalid','local_history_deleted','local_history_empty'].includes(code),check);}catch{check();failure='backfill_state_unavailable';}
        if(binding===priority)this.currentStatus={...this.currentStatus,priority_last_failure_code:code};
      }finally{if(binding===priority){this.priorityAt=now;this.currentStatus={...this.currentStatus,
        priority_last_duration_ms:Math.round(performance.now()-started),priority_last_cli_duration_ms:Math.round(cliDuration),
        priority_last_store_duration_ms:storeDuration===null?null:Math.round(storeDuration),
        priority_queue_wait_ms:this.priorityRequestedAt===null?null:Math.max(0,Math.round(started-this.priorityRequestedAt))};this.priorityRequestedAt=null;}}
    }
    if(!this.recoveryPending.size)this.recoveryTrigger=null;
    const states=await this.options.recovery.list(check);check();
    const historyCoverages=this.options.history?await this.options.history.coverages(bindings,check):[];
    const scopeFailure=[...this.retries.values()].find(r=>['cli_scope_unverified','cli_chat_not_private'].includes(r.code));
    failure=historyFailure??scopeFailure?.code??failure;
    this.currentStatus={...this.currentStatus,phase:failure||!this.stream?'degraded':'active',stream_active:!!this.stream&&!this.stream.closed,
      stream_mode:this.stream?'global_follow':'bounded_polling',failure_code:failure,bound_count:bindings.length,pending_count:this.queue.size,
      history_coverages:historyCoverages,priority_contact_id:this.priority,batch_message_count:written,
      ...incrementalRecoveryStatus(bindings,states,this.priority,this.recoveryPending.size>0)};
    return this.status();
  }
}
