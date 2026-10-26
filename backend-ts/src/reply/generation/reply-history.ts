/** 有界历史Tool只读本轮固定范围；来源窗口和模型工具共用同一累计预算。 */
import type pg from 'pg';
import {defineTool,type ToolDefinition} from '@deepseek-ai/dsh-tools';
import {readContextMessages} from '../context/reply-context-read.ts';
import {validMessageSource} from '../../contacts/contact-context.ts';
import {replyUuid} from './reply-contract.ts';
import type {EvidenceAliases} from './reply-evidence-alias.ts';
import type {ContextScope,ReplyContextEvidence} from '../context/reply-context-types.ts';
export interface HistoryTrace {tool_name:string;status:'succeeded'|'empty'|'failed'|'timeout'|'budget_exceeded';evidence_ids:string[];latency_ms:number}
export interface HistoryOptions {
  transaction<T>(fn:(client:pg.Client)=>Promise<T>):Promise<T>;
  scope:ContextScope;binding_id:string;initial_evidence_ids:string[];navigation_message_ids?:string[];
  excluded_message_ids?:string[];allowed_message_ids?:string[]|null;
  prior_budget?:{used_calls:number;used_count:number;used_tokens:number};
  requireCurrent(client:pg.Client):Promise<void>;
  aliases?:EvidenceAliases;
}
const guidance={"empty":"未命中不代表消息不存在，也不是继续搜索的理由。不要重复相同或相近的查询；如确需更多语境，最多再换一个明显不同的查询词，然后必须停止调用任何工具，立即基于当前消息、表达方向和已有证据返回结构化候选。","budget_exceeded":"历史检索调用预算已用尽。禁止再调用任何历史工具；立即基于当前消息、表达方向和已有证据返回结构化候选。","failed":"历史工具本次调用失败。不要依赖该结果，也不要反复重试；基于已有证据直接返回结构化候选。","timeout":"历史工具本次调用超时。不要等待或重试；基于已有证据直接返回结构化候选。"};
export class ReplyHistory {
  readonly evidence:ReplyContextEvidence[]=[];
  readonly tool_calls:HistoryTrace[]=[];
  private readonly options:HistoryOptions;
  private readonly known:Set<string>;
  private readonly provided:Set<string>;
  private used=0;
  private reserved=0;
  constructor(options:HistoryOptions){
   const scope={owner_id:options.scope.owner_id,contact_id:options.scope.contact_id};
   this.options={...options,scope};
   this.known=new Set([...options.initial_evidence_ids,...options.navigation_message_ids??[]]);
   this.provided=new Set(options.initial_evidence_ids);
   this.used=options.prior_budget?.used_tokens??0;
  }
  get token_count(){return this.used;}
  private sessionAlias(){return this.options.aliases?.sessionFor(this.options.binding_id)??this.options.binding_id;}
  tools():ToolDefinition[]{return [
    defineTool({name:'conversation_search',description:'搜索当前已验证联系人相关历史消息，不读取全量历史。',parameters:{query:{type:'string',required:true},top_k:{type:'integer'},occurred_after:{oneOf:[{type:'string'},{type:'null'}]},occurred_before:{oneOf:[{type:'string'},{type:'null'}]},timeout_ms:{type:'integer'}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async(args,exec)=>this.search(args,exec.signal)}),
    defineTool({name:'conversation_query',description:'仅用成功 Tool 结果给出的 session_id 别名读取命中附近消息，不得猜测或改用真实会话 ID。',parameters:{session_id:{type:'string',required:true},anchor_message_id:{oneOf:[{type:'string'},{type:'null'}]},before:{type:'integer'},after:{type:'integer'},timeout_ms:{type:'integer'}},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute:async(args,exec)=>this.query(args,exec.signal)})];}
  private status(status:Exclude<HistoryTrace['status'],'succeeded'>,reason:string){return JSON.stringify({status,evidence_type:'raw_message_evidence',executable:false,not_found_is_not_evidence:true,reason,messages:[],guidance:guidance[status]});}
  private async run(name:string,timeout:number,signal:AbortSignal|undefined,read:(client:pg.Client)=>Promise<ReplyContextEvidence[]>):Promise<string>{
    const start=performance.now();
    const finish=(status:HistoryTrace['status'],ids:string[]=[])=>this.tool_calls.push({tool_name:name,status,evidence_ids:ids,latency_ms:Math.floor(performance.now()-start)});
    if((this.options.prior_budget?.used_calls??0)+this.reserved>=3){finish('budget_exceeded');return this.status('budget_exceeded','tool_call_budget');}
    // 在第一个await之前占用次数，避免同批并行工具越界。
    this.reserved++;
    try {
      if(!Number.isInteger(timeout)||timeout<1||timeout>1500)throw new Error('timeout_invalid');
      signal?.throwIfAborted();
      const rows=await this.options.transaction(async client=>{
        await client.query("SELECT set_config('statement_timeout',$1,true)",[`${timeout}ms`]);
        await this.options.requireCurrent(client);signal?.throwIfAborted();const result=await read(client);signal?.throwIfAborted();return result;
      });
      if(performance.now()-start>timeout){finish('timeout');return this.status('timeout','history_timeout');}
      const result=rows.filter(row=>!this.options.excluded_message_ids?.includes(row.evidence_id));
      if(!result.length){finish('empty');return this.status('empty','no_matching_history');}
      const tokens=result.reduce((n,r)=>n+Math.max(1,Math.ceil([...r.text].length/4)),0);
      if(this.used+tokens>2048||(this.options.prior_budget?.used_count??0)+this.evidence.length+result.length>16){finish('budget_exceeded');return this.status('budget_exceeded','history_token_budget');}
      result.sort((a,b)=>{const x=a.timing.source_started_at,y=b.timing.source_started_at;return x===y?0:x===null?1:y===null?-1:x<y?-1:1;});
      for(const row of result){
        if(row.scope.owner_id!==this.options.scope.owner_id||row.scope.contact_id!==this.options.scope.contact_id||!row.source_ids.length)throw new Error('history_scope_invalid');
        this.known.add(row.evidence_id);if(!this.provided.has(row.evidence_id)){this.evidence.push({...row,selection_reason:name==='conversation_search'?'本轮相关性搜索返回的联系人历史消息。':'本轮时间顺序查询返回的联系人历史消息。'});this.provided.add(row.evidence_id);}
      }
      this.used+=tokens;finish('succeeded',result.map(r=>r.evidence_id));
      return JSON.stringify({status:'ok',evidence_type:'raw_message_evidence',executable:false,not_found_is_not_evidence:true,message_order:'known_times_ascending_unknown_last_equal_unordered',messages:result.map(r=>{
       const evidenceId=this.options.aliases?.aliasFor(r.evidence_id)??r.evidence_id;
       return {evidence_id:evidenceId,message_id:evidenceId,role:r.speaker_role,speaker_role:r.speaker_role,factual_role:'source_message_statement',occurred_at:r.timing.source_started_at,session_id:this.options.aliases?this.sessionAlias():null,can_query_context:this.options.aliases!==undefined,status:r.status,text:r.text,timing:r.timing};
      })});
    }catch(error){signal?.throwIfAborted();finish('failed');return this.status('failed',name==='conversation_search'?'history_search_failed':'history_query_failed');}
  }
  async search(args:{query:string;top_k?:number;occurred_after?:string|null;occurred_before?:string|null;timeout_ms?:number},signal?:AbortSignal):Promise<string>{
    return this.run('conversation_search',args.timeout_ms??500,signal,async client=>{
      const limit=args.top_k??5;
      if(typeof args.query!=='string'||!args.query.trim()||[...args.query.trim()].length>200||!Number.isInteger(limit)||limit<1||limit>8)throw new Error('history_input_invalid');
      const after=time(args.occurred_after),before=time(args.occurred_before);
      if(after&&before&&Date.parse(before)<Date.parse(after))throw new Error('history_window_invalid');
      const tokens=args.query.trim().split(/\s+/u).map(s=>s.toLowerCase());
      const ids=(await client.query(`SELECT m.id FROM public.message m WHERE m.owner_id=$1 AND m.contact_id=$2 AND ${validMessageSource('m')}
        AND ($3::uuid[] IS NULL OR m.id=ANY($3::uuid[])) AND ($4::timestamptz IS NULL OR m.occurred_at>=$4) AND ($5::timestamptz IS NULL OR m.occurred_at<=$5)
        AND NOT EXISTS(SELECT 1 FROM unnest($6::text[]) token WHERE position(lower(token) in lower(CASE WHEN length(btrim(m.text_content))>0 THEN m.text_content ELSE m.media_placeholder END))=0)
        ORDER BY m.occurred_at DESC NULLS LAST,m.id DESC LIMIT $7`,[this.options.scope.owner_id,this.options.scope.contact_id,this.options.allowed_message_ids??null,after,before,tokens,limit])).rows.map(r=>r.id);
      return readContextMessages(client,this.options.scope,{ids,limit});
    });
  }
  async query(args:{session_id:string;anchor_message_id?:string|null;before?:number;after?:number;timeout_ms?:number},signal?:AbortSignal):Promise<string>{
    return this.run('conversation_query',args.timeout_ms??500,signal,async client=>{
      const session=this.options.aliases?this.options.aliases.resolveSession(args.session_id):replyUuid(args.session_id);
      if(session!==this.options.binding_id)throw new Error('history_session_invalid');
      const requested=args.anchor_message_id??null;
      const anchor=requested?(this.options.aliases?this.options.aliases.resolve(requested):replyUuid(requested)):null;
      if(requested&&anchor==null)throw new Error('history_query_invalid');
      const before=args.before??3,after=args.after??3;
      if(!Number.isInteger(before)||before<0||before>10||!Number.isInteger(after)||after<0||after>10||anchor&&!this.known.has(anchor))throw new Error('history_query_invalid');
      const scope=this.options.scope,limit=Math.min(20,before+after+1);
      if(!anchor)return (await readContextMessages(client,scope,{ids:this.options.allowed_message_ids,limit})).reverse();
      const found=await readContextMessages(client,scope,{ids:[anchor],limit:1});if(!found.length||this.options.allowed_message_ids&&!this.options.allowed_message_ids.includes(anchor))return [];
      const date=found[0].timing.source_started_at;
      const adjacent=async(direction:'before'|'after',count:number)=>{
        const condition=date===null?`m.occurred_at IS NULL AND m.id${direction==='before'?'<':'>'}$3::uuid`:direction==='before'?`m.occurred_at IS NOT NULL AND (m.occurred_at,m.id)<($4::timestamptz,$3::uuid)`:`(m.occurred_at IS NULL OR (m.occurred_at,m.id)>($4::timestamptz,$3::uuid))`;
        const sort=direction==='before'?'DESC':'ASC';
        return (await client.query(`SELECT m.id FROM public.message m WHERE m.owner_id=$1 AND m.contact_id=$2 AND m.id<>$3 AND ${validMessageSource('m')} AND ${condition} AND ($5::uuid[] IS NULL OR m.id=ANY($5::uuid[])) AND ($4::timestamptz IS NULL OR TRUE) ORDER BY m.occurred_at ${sort} NULLS LAST,m.id ${sort} LIMIT $6`,[scope.owner_id,scope.contact_id,anchor,date,this.options.allowed_message_ids??null,count])).rows.map(r=>r.id);
      };
      const ids=[...(await adjacent('before',before)).reverse(),anchor,...await adjacent('after',after)].slice(0,limit),rows=await readContextMessages(client,scope,{ids,limit});
      return ids.map(id=>rows.find(row=>row.evidence_id===id)!).filter(Boolean);
    });
  }
}
function time(value:string|null|undefined):string|null{if(value==null)return null;if(typeof value!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw new Error('history_time_invalid');return value;}
