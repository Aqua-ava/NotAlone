/** 授权私聊的首次完整历史追平；普通业务模块，不注册模型 Tool 或 DSH 会话状态。 */
import type {SyncIncrementalCli} from './sync-incremental-cli.ts';
import {IncrementalCliError,normalizeCliEvents,type IncrementalProcessingRecord,type IncrementalTailResult} from './sync-incremental-normalize.ts';
import type {
  HistoryCoverage,HistoryPreparation,HistoryState,IncrementalBinding,SyncIncrementalStore,
} from './sync-incremental-store.ts';

export interface HistoryStep {
  phase:'not_required'|'syncing'|'complete';
  has_more:boolean;
  message_count:number;
  non_text_count:number;
  restored:boolean;
}
interface Options {
  store:SyncIncrementalStore;
  cli:SyncIncrementalCli;
  accountScope:string;
  pageLimit?:number;
  clock?:()=>Date;
}
interface ReadOptions {
  signal:AbortSignal;
  timeoutMs:()=>number;
  check:()=>void;
}
const stopped=new Set(['cli_cancelled','runtime_stopping','sync_disabled','sync_binding_invalid']);
const errorCode=(error:unknown):string=>{
  const code=(error as {code?:unknown})?.code;
  return typeof code==='string'&&/^[a-z][a-z0-9_]{0,95}$/.test(code)?code:'history_sync_failed';
};
const pageFailure=(page:IncrementalTailResult,state:HistoryState):string|null=>{
  if(page.local_history_state)return `local_history_${page.local_history_state}`;
  if(!page.freshness_confirmed)return 'cli_freshness_unknown';
  if(page.last_local_id===null||page.cursor===null){
    return page.last_local_id===null&&page.cursor===null
      ? state.last_cursor===null?'history_empty':'history_page_stalled'
      : 'cli_output_invalid';
  }
  if(page.has_more&&page.cursor===state.last_cursor)return 'cli_output_invalid';
  return null;
};

export class SyncHistory {
  private readonly options:Options;
  private version:string|null=null;
  constructor(options:Options){
    const limit=options.pageLimit??50;
    if(!options.accountScope.trim()||!Number.isSafeInteger(limit)||limit<1||limit>1000)throw new Error('history_page_limit_invalid');
    this.options={...options,pageLimit:limit};
  }
  private now():Date{return (this.options.clock??(()=>new Date()))();}
  async coverages(bindings:readonly IncrementalBinding[],check:()=>void=()=>{}):Promise<HistoryCoverage[]>{
    return this.options.store.historyCoverages(bindings,check);
  }
  async ensureStarted(bindings:readonly IncrementalBinding[],check:()=>void=()=>{}):Promise<number>{
    return this.options.store.ensureHistoryStarted(bindings,this.now(),check);
  }
  /** 已完成历史在后续私聊类型复验失败时撤回生成资格，但保留原完成证明。 */
  async markScopeIncomplete(binding:IncrementalBinding,code:string,check:()=>void):Promise<void>{
    await this.options.store.markHistoryIncomplete(binding,code,true,check);
  }
  private async unavailable(binding:IncrementalBinding,state:HistoryState,code:string,check:()=>void):Promise<void>{
    if(stopped.has(code))return;
    await this.options.store.markHistoryIncomplete(binding,code,state.completed_at!==null,check);
  }
  private async verifyPrivate(binding:IncrementalBinding,options:ReadOptions):Promise<void>{
    const timeout=Math.max(1,Math.min(1000,options.timeoutMs()));
    const resolved=await this.options.cli.resolveChat(binding.conversation_locator,{signal:options.signal,timeoutMs:timeout});
    if(resolved.candidates.length!==1||resolved.candidates[0].username!==binding.conversation_locator
      ||resolved.candidates[0].chat_type!=='private'){
      throw new IncrementalCliError('cli_scope_unverified','未能核实已关联会话的唯一私聊身份。');
    }
  }
  /**
   * 一页历史是一个完整恢复单元：先固定旧检查点，CLI 成功后在同一事务保存
   * cli_history 来源、规范消息、派生回执、覆盖状态和完成页增量游标。
   */
  async readPage(binding:IncrementalBinding,options:ReadOptions):Promise<HistoryStep>{
    const prepared:HistoryPreparation|null=await this.options.store.prepareHistory(binding,options.check);
    if(!prepared)return {phase:'not_required',has_more:false,message_count:0,non_text_count:0,restored:false};
    const {state,position_token}=prepared;
    // 工具版本属于技术前置条件；失败保留 syncing，下一次从同一检查点重试。
    this.version??=await this.options.cli.version({signal:options.signal,timeoutMs:options.timeoutMs()});
    try{
      await this.verifyPrivate(binding,options);
      if(state.completed_at!==null){
        await this.options.store.restoreHistoryCompletion(binding,options.check);
        return {phase:'complete',has_more:false,message_count:0,non_text_count:0,restored:true};
      }
      const page=await this.options.cli.tail(binding.conversation_locator,{
        history:true,limit:this.options.pageLimit,
        ...(state.last_cursor===null?{}:{cursor:state.last_cursor}),
        signal:options.signal,timeoutMs:options.timeoutMs(),
      });
      await this.options.cli.configuredAccount({expectedAccount:this.options.accountScope,signal:options.signal,timeoutMs:options.timeoutMs()});
      const code=pageFailure(page,state);
      if(code)throw new IncrementalCliError(code,'历史覆盖未能确认。');
      const records:IncrementalProcessingRecord[]=[];
      const messages=normalizeCliEvents(page.events,{processingReceipts:records});
      const saved=await this.options.store.saveHistoryPage({
        binding,page,messages,since_cursor:state.last_cursor,since_local_id:state.last_local_id,
        cli_version:this.version,position_token,
        processing_records:[...records,...page.filtered_records].sort((left,right)=>{
          const position=(record:{payload_json:string})=>{
            try{return Number((JSON.parse(record.payload_json) as {input_position?:unknown}).input_position??0);}catch{return 0;}
          };
          return position(left)-position(right);
        }),
        history:state,
      },options.check);
      if(!saved.source_created)throw new IncrementalCliError('history_page_stalled','历史分页检查点未能推进。');
      return {phase:page.has_more?'syncing':'complete',has_more:page.has_more,
        message_count:saved.accepted_message_count,non_text_count:page.non_text_count,restored:false};
    }catch(error){
      if(error instanceof IncrementalCliError){
        const code=errorCode(error);
        try{await this.unavailable(binding,state,code,options.check);}catch{}
      }
      throw error;
    }
  }
}
