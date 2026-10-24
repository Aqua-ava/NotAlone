import {requireScenarioReceipts} from './reply-context-scenario.ts';
import {captureLayeredSnapshot,selectLayeredMaterial,requireLayeredMaterial,CONTACT_LAYERED_BUDGET,OWNER_LAYERED_BUDGET} from './reply-context-layered.ts';
import {readReplyContactOverview,readReplyOwnerOverview,type ReplyOverviewSnapshot} from './reply-context-overview.ts';
import {ReplyHistory} from './reply-history.ts';
import {readContextMemories,selectContextMemories,memoryEvidence,pendingSelectionReason,type MemoryKind} from './reply-context-memory.ts';
import {readContextMessages,readOptionalContext,selectReplyMessageWindow,requireReplyMessageWindowBudget} from './reply-context-read.ts';
import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import {canonicalJSON} from './contact-overview-evidence.ts';
import {replyUuid} from './reply-contract.ts';
import {blankTiming,ReplyContextError,PENDING_REASON,HISTORICAL_REASON,type ReplyContextBuildInput,type BuiltReplyContext,type ReplyContextEvidence,type ContextScope,type ReplyContextOptions} from './reply-context-types.ts';
export * from './reply-context-types.ts';
export function allowsHistory(input:ReplyContextBuildInput['request']):boolean {
 return input.content.type!=='rewrite_draft'||input.content.include_relationship_context===true;
}
export function recentOnly(input:ReplyContextBuildInput['request']):boolean {
 return input.content.type==='rewrite_draft'&&input.content.input_kind==='workspace'&&Array.isArray(input.content.excluded_message_ids)&&input.content.excluded_message_ids.length>0;
}
export function modelVisibleEvidence(context:BuiltReplyContext):ReplyContextEvidence[]{return context.evidence.filter(item=>item.model_visible);}
function riskNotes(text:string):string[]{return ([['转账',['转账','汇款']],['验证码',['验证码']],['地址',['地址']],['借款',['借款','借钱']],['承诺',['承诺']],['见面安排',['见面','约见']],['关系冲突',['冲突','吵架','分手']]] as [string,string[]][]).filter(([,terms])=>terms.some(t=>text.includes(t))).map(([label])=>`请核实${label}相关内容。`);}
function validateEvidence(context:BuiltReplyContext):void {
 const seen=new Set<string>();
 for(const item of context.evidence){
  if(canonicalJSON(item.scope)!==canonicalJSON(context.scope)||replyUuid(item.evidence_id)!==item.evidence_id||seen.has(item.evidence_id)||!item.text.trim()||typeof item.model_visible!=='boolean'||!['owner','contact','system','unknown'].includes(item.speaker_role)||item.kind!=='message'&&item.speaker_role!=='unknown')throw new ReplyContextError('回复依据结构或范围无效。');
  const statuses:Record<string,string[]>={message:['active'],confirmed_memory:['active','invalidated'],owner_memory:['active','invalidated'],pending_candidate:['pending'],user_draft:['active','user_input'],user_current_chat:['user_input'],user_purpose:['user_input'],continued_candidate:['active','candidate']};
  if(!statuses[item.kind]?.includes(item.status)||!Array.isArray(item.source_ids)||item.source_ids.some(id=>replyUuid(id)!==id)||item.kind==='pending_candidate'&&!item.selection_reason.startsWith(PENDING_REASON)||item.status==='invalidated'&&!item.selection_reason.startsWith(HISTORICAL_REASON)||item.revision!==null&&(!Number.isInteger(item.revision)||item.revision<1))throw new ReplyContextError('回复证据状态或来源无效。');
  seen.add(item.evidence_id);
  if(!allowsHistory(context.command)&&['message','confirmed_memory','owner_memory','pending_candidate'].includes(item.kind))throw new ReplyContextError('本次草稿未授权历史。');
 }
}
/** 复用调用方同一事务；不开始/提交事务，不负责联系人绑定授权。 */
export class PostgresReplyContext {
 private readonly client:Client;
 private readonly options:ReplyContextOptions;
 constructor(client:Client,options:ReplyContextOptions={}){this.client=client;this.options=options;}
 async revisions(scope:ContextScope):Promise<{memory_revision:number;index_revision:number|null}>{
  const row=(await this.client.query(`SELECT state.memory_revision,index.built_from_memory_revision FROM public.contact_memory_state state LEFT JOIN public.contact_memory_index index ON index.owner_id=state.owner_id AND index.contact_id=state.contact_id WHERE state.owner_id=$1 AND state.contact_id=$2`,[scope.owner_id,scope.contact_id])).rows[0];
  return {memory_revision:Number(row?.memory_revision??0),index_revision:row?.built_from_memory_revision==null?null:Number(row.built_from_memory_revision)};
 }
 async build(input:ReplyContextBuildInput):Promise<BuiltReplyContext>{
  const scope={owner_id:replyUuid(input.owner_id),contact_id:replyUuid(input.contact_id)},requestId=replyUuid(input.reply_request_id);
  if(input.request.contact_id!==scope.contact_id||!(await this.client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2',[scope.owner_id,scope.contact_id])).rowCount)throw new ReplyContextError('联系人范围不可用。');
  const candidateId=input.request.continued_from_candidate_id;
  if(candidateId&&(!this.options.readContinuationBasis||!input.conversation_binding_id))throw new ReplyContextError('显式候选继续须由已验证续写端口装配。');
  const continuation=candidateId?await this.options.readContinuationBasis!(this.client,scope,input.conversation_binding_id!,candidateId):null;
  if(continuation&&(continuation.candidate_id!==candidateId||canonicalJSON(continuation.scope)!==canonicalJSON(scope)||continuation.conversation_binding_id!==input.conversation_binding_id||!continuation.text.trim()))throw new ReplyContextError('历史候选超出当前联系人会话范围。');
  const c=input.request.content,evidence:ReplyContextEvidence[]=[];
  let retrieval:Record<string,any>|null=null,overviewReadFailed=false;
  const add=(kind:string,text:string,reason:string)=>evidence.push({evidence_id:evidence.length?randomUUID():requestId,kind,text,selection_reason:reason,status:'user_input',scope,source_ids:[],valid_at:null,invalid_at:null,revision:null,timing:blankTiming(),event:null,conditions:null,evolution:null,speaker_role:'unknown',model_visible:true,navigation:null});
  let currentText='',direction:BuiltReplyContext['direction']=null;
  if(c.type==='rewrite_draft'){
   currentText=c.draft_text as string;
   if(c.input_kind==='workspace'){
    add('user_purpose',c.workspace_action==='express'?'帮我表达':'帮我想想','用户主动选择的本次工作区动作，不代表已采纳任何建议立场。');
    if(currentText.trim())add('user_draft',currentText,'用户本次提供的想法、方向或草稿。');
    if(typeof c.context_text==='string'&&c.context_text.trim())add('user_current_chat',c.context_text,'用户为当前联系人补充的聊天上下文，不作为本人意图或长期记忆。');
   }else add(c.input_kind==='current_chat'?'user_current_chat':'user_draft',currentText,c.input_kind==='current_chat'?'用户为这位联系人明确粘贴的当前聊天文字；未经渠道核验，不作为本人原句或长期记忆。':'用户原句是改写模式的唯一默认输入。');
  }else if(c.type==='initiate_conversation'){
   currentText=c.purpose as string;direction={text:currentText,source:c.purpose_source as string};add('user_purpose',currentText,'用户本次明确的主动联系目的。');
  }else if(c.type==='reply_to_message'){direction={text:c.direction as string,source:c.direction_source as string};}
  else throw new ReplyContextError('回复模式无效。');
  if(allowsHistory(input.request)&&(c.type!=='rewrite_draft'||c.input_kind==='workspace')){
   const excluded=new Set(c.excluded_message_ids as string[]??[]);
   const messages=selectReplyMessageWindow((await readContextMessages(this.client,scope,{ids:input.history_message_ids,target:c.type==='reply_to_message'?c.target_message_id as string:undefined})).filter(item=>!excluded.has(item.evidence_id)),c.type==='reply_to_message'?c.target_message_id as string:undefined);
   if(c.type==='reply_to_message'){
    const target=messages.find(item=>item.evidence_id===c.target_message_id);if(!target)throw new ReplyContextError('待回复消息不在当前有效范围。');currentText=target.text;
   }
   evidence.push(...messages);
  }
  if(allowsHistory(input.request)&&!recentOnly(input.request)){
   let queries=[currentText];
   if(c.type==='rewrite_draft'&&c.input_kind==='workspace'){
    const background=evidence.filter(item=>['message','user_current_chat'].includes(item.kind)).map(item=>item.text).join('\n');
    queries=currentText.trim()?[currentText,background]:[background];
   }
   queries=[...new Set(queries.filter(query=>query.trim()))];if(!queries.length)queries=[''];
   let overviews:{confirmed_memory:ReplyOverviewSnapshot|null;owner_memory:ReplyOverviewSnapshot|null}|null=null;
   if(this.options.overview!==false){const contact=await readOptionalContext(this.client,()=>readReplyContactOverview(this.client,scope)),owner=await readOptionalContext(this.client,()=>readReplyOwnerOverview(this.client,scope.owner_id));overviews={confirmed_memory:contact.value,owner_memory:owner.value};overviewReadFailed=contact.failed||owner.failed;}
   if(overviews)retrieval={contact_overview:overviews.confirmed_memory?{projection_revision:overviews.confirmed_memory.projection_revision,memory_revision:overviews.confirmed_memory.memory_revision}:null,owner_overview:overviews.owner_memory?{projection_revision:overviews.owner_memory.projection_revision,memory_revision:overviews.owner_memory.memory_revision}:null,queries:[],source_messages:{call_limit:3,item_limit:16,token_limit:2048,used_calls:0,used_count:0,used_tokens:0,exhausted:false},status:overviewReadFailed?'unavailable':'empty'};
   for(const [kind,limit,budget] of [['confirmed_memory',5,600],['owner_memory',3,240],['pending_candidate',3,300]] as [MemoryKind,number,number][]){
    const overview=kind==='pending_candidate'?null:overviews?.[kind];
    const pendingRead=kind==='pending_candidate'?await readOptionalContext(this.client,()=>readContextMemories(this.client,scope,kind)):null;
    const rows=pendingRead?pendingRead.value??[]:overviews&&!overview?[]:await readContextMemories(this.client,scope,kind);
    const retrievalFailed=!!pendingRead?.failed||!!overviews&&kind!=='pending_candidate'&&!overview;
    if(retrieval&&retrievalFailed)retrieval.status='unavailable';
    const navigable=overview?new Map(overview.entries.filter(entry=>['manual_entry','source_supported'].includes(entry.provenance.kind)).map(entry=>[entry.memory.memory_id,entry])):null;
    const eligibleRows=navigable?rows.filter(row=>navigable.has(row.id)):rows;
    const allSelected=selectContextMemories(eligibleRows,queries,Math.max(1,eligibleRows.length),Number.MAX_SAFE_INTEGER);
    const selected=selectContextMemories(eligibleRows,queries,limit,budget),exhausted=selected.length<allSelected.length;
    for(const row of selected){const item=memoryEvidence(row,scope,kind),entry=navigable?.get(row.id);
     if(entry&&overview){if(entry.memory.revision!==row.revision)throw new ReplyContextError('概览底层版本已变化。');item.navigation={scope_kind:kind==='owner_memory'?'owner':'contact',projection_revision:overview.projection_revision,memory_id:row.id,memory_revision:row.revision,provenance_kind:entry.provenance.kind,source_message_ids:kind==='owner_memory'?[]:[...new Set(entry.provenance.references.filter((ref:Record<string,any>)=>ref.message_id&&(!ref.contact_id||ref.contact_id===scope.contact_id)).map((ref:Record<string,any>)=>ref.message_id))],dependency_ids:entry.dependency_ids};}
     evidence.push(item);
    }
    if(retrieval){retrieval.queries.push({kind,purpose:'recall',status:retrievalFailed?'failed':selected.length?'succeeded':exhausted?'budget_exceeded':'empty',evidence_ids:selected.map(row=>row.id),limit});retrieval[kind==='confirmed_memory'?'contact_memory':kind==='owner_memory'?'owner_memory':'pending_candidate']={limit,char_limit:budget,used_count:selected.length,used_chars:selected.reduce((n,row)=>n+[...row.text].length,0),exhausted};if(exhausted&&retrieval.status!=='unavailable')retrieval.status='budget_exhausted';else if(selected.length&&!['budget_exhausted','unavailable'].includes(retrieval.status))retrieval.status='succeeded';}
   }
  }
  if(continuation)evidence.push({evidence_id:continuation.candidate_id,kind:'continued_candidate',text:continuation.text,scope,source_ids:[],selection_reason:'用户明确选择的历史候选。',status:'candidate',valid_at:null,invalid_at:null,revision:null,timing:blankTiming(),event:null,conditions:null,evolution:null,speaker_role:'unknown',model_visible:true,navigation:null});
  const result:BuiltReplyContext={reply_request_id:requestId,scope,overview_read_failed:overviewReadFailed,conversation_binding_id:input.conversation_binding_id,continuation_basis:continuation,layered_scenario_reads:[],owner_layered_scenario_reads:[],command:structuredClone(input.request),current_text:currentText,direction,evidence,risk_notes:riskNotes([currentText,c.user_instruction??''].join('\n')),...await this.revisions(scope),history_message_ids:input.history_message_ids??null,retrieval,tool_calls:[],navigation_dependency_ids:[...new Set(evidence.flatMap(item=>item.navigation?.dependency_ids??[]))].sort()};
  for(const kind of ['contact','owner'] as const){
   const allowed=allowsHistory(input.request)&&!recentOnly(input.request),scopeValue={owner_id:scope.owner_id,contact_id:kind==='contact'?scope.contact_id:null};
   const read=allowed?await readOptionalContext(this.client,()=>captureLayeredSnapshot(this.client,scopeValue)):{value:null,failed:false};
   const snapshot=read.value;
   const material=snapshot?selectLayeredMaterial(snapshot,kind==='contact'?CONTACT_LAYERED_BUDGET:OWNER_LAYERED_BUDGET):null;
   if(kind==='contact'){result.layered_context=material;result.layered_status=!allowed?'not_allowed':material?'loaded':'unavailable';result.layered_read_failed=read.failed;}
   else{result.owner_layered_context=material;result.owner_layered_status=!allowed?'not_allowed':material?'loaded':'unavailable';result.owner_layered_read_failed=read.failed;}
  }
  validateEvidence(result);
  if(result.history_message_ids!==null)result.history_message_ids=[...new Set<string>([...result.history_message_ids,...evidence.flatMap(item=>item.navigation?.source_message_ids??[]),...evidence.filter(item=>item.kind==='message').map(item=>item.evidence_id)])].sort();
  if(retrieval){
   const existing=new Set(evidence.filter(item=>item.kind==='message').map(item=>item.evidence_id));
   const anchors=[...new Set<string>(evidence.filter(item=>item.navigation?.scope_kind==='contact'&&['historical','current_unverified'].includes(item.timing.current_status)).flatMap(item=>item.navigation!.source_message_ids))].filter(id=>!existing.has(id));
   if(anchors.length){
    if(!input.conversation_binding_id)throw new ReplyContextError('来源窗口缺少已验证会话绑定。');
    const history=new ReplyHistory({transaction:fn=>fn(this.client),scope,binding_id:input.conversation_binding_id,initial_evidence_ids:evidence.map(item=>item.evidence_id),navigation_message_ids:anchors,excluded_message_ids:c.excluded_message_ids as string[]??[],allowed_message_ids:result.history_message_ids,requireCurrent:async()=>{await this.validateCurrent(result);}});
    for(const anchor of anchors){const remaining=50-existing.size-history.evidence.length;if(remaining<=0){retrieval.queries.push({kind:'message',purpose:'source_window',status:'budget_exceeded',evidence_ids:[],limit:1});retrieval.source_messages.exhausted=true;if(retrieval.status!=='unavailable')retrieval.status='budget_exhausted';break;}const width=Math.min(7,remaining),before=Math.min(3,Math.floor((width-1)/2));await history.query({session_id:input.conversation_binding_id,anchor_message_id:anchor,before,after:width-before-1,timeout_ms:500});const trace=history.tool_calls.at(-1)!;retrieval.queries.push({kind:'message',purpose:'source_window',status:trace.status==='timeout'?'failed':trace.status,evidence_ids:trace.status==='succeeded'?trace.evidence_ids:[],limit:width});if(['failed','timeout'].includes(trace.status))retrieval.status='unavailable';if(trace.status==='budget_exceeded'){retrieval.source_messages.exhausted=true;if(retrieval.status!=='unavailable')retrieval.status='budget_exhausted';break;}}
    evidence.push(...history.evidence);result.tool_calls=history.tool_calls;Object.assign(retrieval.source_messages,{used_calls:Math.min(3,history.tool_calls.length),used_count:history.evidence.length,used_tokens:history.token_count});
   }
  }
  validateEvidence(result);return result;
 }
 async validateCurrent(context:BuiltReplyContext):Promise<void>{
  validateEvidence(context);
  if(context.command.continued_from_candidate_id){
   if(!this.options.readContinuationBasis||!context.conversation_binding_id||!context.continuation_basis)throw new ReplyContextError('续写依据无法复验。');
   const basis=await this.options.readContinuationBasis(this.client,context.scope,context.conversation_binding_id,context.command.continued_from_candidate_id);
   const items=context.evidence.filter(item=>item.kind==='continued_candidate');
   if(canonicalJSON(basis)!==canonicalJSON(context.continuation_basis)||items.length!==1||items[0].evidence_id!==basis.candidate_id||items[0].text!==basis.text)throw new ReplyContextError('续写正文或依据已变化。');
  }else if(context.continuation_basis||context.evidence.some(item=>item.kind==='continued_candidate'))throw new ReplyContextError('历史候选须显式选择。');
  for(const kind of ['contact','owner'] as const){const material=kind==='contact'?context.layered_context:context.owner_layered_context,status=kind==='contact'?context.layered_status:context.owner_layered_status;
   const receipts=kind==='contact'?context.layered_scenario_reads??[]:context.owner_layered_scenario_reads??[];
   if(!material&&receipts.length)throw new ReplyContextError('正文工具缺少冻结目录。');
   if(material){requireScenarioReceipts(material,receipts);if(!allowsHistory(context.command)||recentOnly(context.command)||status!=='loaded')throw new ReplyContextError('本次没有分层资料权限。');await requireLayeredMaterial(this.client,{owner_id:context.scope.owner_id,contact_id:kind==='contact'?context.scope.contact_id:null},material,kind==='contact'?CONTACT_LAYERED_BUDGET:OWNER_LAYERED_BUDGET);}
  }
  if(this.options.overview!==false&&allowsHistory(context.command)&&!recentOnly(context.command)&&!context.retrieval)throw new ReplyContextError('缺少概览导航回执。');
  if(context.retrieval){
   for(const key of ['contact_overview','owner_overview'] as const){const expected=context.retrieval[key];if(!expected){if(context.evidence.some(item=>item.model_visible&&item.kind===(key==='contact_overview'?'confirmed_memory':'owner_memory')))throw new ReplyContextError('资料缺少概览导航资格。');continue;}const current=key==='contact_overview'?await readReplyContactOverview(this.client,context.scope):await readReplyOwnerOverview(this.client,context.scope.owner_id);if(current.projection_revision!==expected.projection_revision||current.memory_revision!==expected.memory_revision)throw new ReplyContextError('概览导航修订已变化。');
    const kind=key==='contact_overview'?'confirmed_memory':'owner_memory';
    for(const item of context.evidence.filter(item=>item.kind===kind&&item.model_visible)){
     const entry=current.entries.find(entry=>entry.memory.memory_id===item.evidence_id);
     if(!entry||!item.navigation)throw new ReplyContextError('概览导航身份缺失。');
     const navigation={scope_kind:kind==='owner_memory'?'owner':'contact',projection_revision:current.projection_revision,memory_id:item.evidence_id,memory_revision:entry.memory.revision,provenance_kind:entry.provenance.kind,source_message_ids:kind==='owner_memory'?[]:[...new Set(entry.provenance.references.filter((ref:Record<string,any>)=>ref.message_id&&(!ref.contact_id||ref.contact_id===context.scope.contact_id)).map((ref:Record<string,any>)=>ref.message_id))],dependency_ids:entry.dependency_ids};
     if(canonicalJSON(navigation)!==canonicalJSON(item.navigation))throw new ReplyContextError('概览导航来源或版本已变化。');
    }
   }
   const dependencies=[...new Set<string>(context.evidence.flatMap(item=>item.navigation?.dependency_ids??[]))].sort();
   if(canonicalJSON(dependencies)!==canonicalJSON(context.navigation_dependency_ids))throw new ReplyContextError('导航依赖集合不一致。');
  }
  if(!(await this.client.query('SELECT 1 FROM public.contact WHERE owner_id=$1 AND id=$2',[context.scope.owner_id,context.scope.contact_id])).rowCount)throw new ReplyContextError('联系人已删除。');
  const messages=context.evidence.filter(item=>item.kind==='message');
  if(messages.length){
   const current=await readContextMessages(this.client,context.scope,{ids:messages.map(item=>item.evidence_id),limit:messages.length});
   for(const item of messages){const row=current.find(value=>value.evidence_id===item.evidence_id);if(!row||row.freshness_sha256!==item.freshness_sha256||canonicalJSON({...row,selection_reason:item.selection_reason,model_visible:item.model_visible,navigation:item.navigation})!==canonicalJSON(item))throw new ReplyContextError('消息作者、正文、时间或来源已变化。');}
  }
  for(const kind of ['confirmed_memory','owner_memory','pending_candidate'] as MemoryKind[]){
   const items=context.evidence.filter(item=>item.kind===kind);if(!items.length)continue;
   const rows=await readContextMemories(this.client,context.scope,kind,items.map(item=>item.evidence_id));
   for(const item of items){const row=rows.find(value=>value.id===item.evidence_id);if(!row)throw new ReplyContextError('记忆依据已不可用。');
    if(kind==='pending_candidate'&&!item.selection_reason.startsWith(pendingSelectionReason(row)))throw new ReplyContextError('待确认属性已变化。');
    const fresh=memoryEvidence(row,context.scope,kind);
    if(fresh.freshness_sha256!==item.freshness_sha256||canonicalJSON({...fresh,selection_reason:item.selection_reason,model_visible:item.model_visible,navigation:item.navigation})!==canonicalJSON(item))throw new ReplyContextError('记忆正文、版本、时间或语义依据已变化。');
   }
  }
  if(canonicalJSON(await this.revisions(context.scope))!==canonicalJSON({memory_revision:context.memory_revision,index_revision:context.index_revision}))throw new ReplyContextError('记忆目录版本已变化。');
  requireReplyMessageWindowBudget(context);
 }
}

/** 模型与持久回执的旧公开字段；内部复验对象不能直接作为模型输入。 */
export function retrievalReceiptPayload(context:BuiltReplyContext):Record<string,unknown>|null{
 const receipt=context.retrieval;if(!receipt)return null;
 return {version:1,retriever_version:'lexical-v1',status:receipt.status,overview_revisions:{contact:receipt.contact_overview,owner:receipt.owner_overview},queries:structuredClone(receipt.queries),budgets:{contact_memory:structuredClone(receipt.contact_memory),owner_memory:structuredClone(receipt.owner_memory),pending_candidate:structuredClone(receipt.pending_candidate),source_messages:structuredClone(receipt.source_messages)}};
}
