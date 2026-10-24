/** 08冻结上下文的同事务构造与旧快照恢复；不创建C，不写A CAS。 */
import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import {PostgresReplyContext} from './reply-context.ts';
import type {BuiltReplyContext,ReplyContextOptions} from './reply-context-types.ts';
import {ReplyContextError} from './reply-context-types.ts';
import type {ReplyRequestInput} from './reply-contract.ts';
import type {ReplyAssistantGuards} from './reply-assistant-guards.ts';
import type {PostgresReplyDiscussionContext,ReplyDiscussionContext} from './reply-discussion-context.ts';
import {selectApplicablePreferences,validatePreferenceSnapshot} from './preference-service.ts';
import {encodePreparedContext,decodePreparedContext,PreparedContextFormatError} from './reply-prepared-codec.ts';
import {readContextMessages} from './reply-context-read.ts';
import {readContextMemories,memoryEvidence,type MemoryKind} from './reply-context-memory.ts';
import {canonicalJSON} from './contact-overview-evidence.ts';
import {evidenceSources,generationDependencies} from './reply-assistant-erasure.ts';
import {replyGenerationNavigationDependencies,restoreLegacyEmptyPreferences,isLegacyEmptyPreferences,type ReplyPreferenceSnapshot} from './reply-generation-guards.ts';
import type {ReplyExploredContextValidator} from './reply-exploration-guards.ts';
type Row=Record<string,any>;
export interface ReplyPreparedIdentity {owner_id:string;contact_id:string;conversation_binding_id:string;idempotency_key:string}
export interface ReplyPreparedState {context:BuiltReplyContext;discussion:ReplyDiscussionContext|null;preferences:ReplyPreferenceSnapshot;skillRevision:string;dependency_ids:string[]}
export interface ReplyPreparedOptions {
 command:ReplyRequestInput;
 discussion:Pick<PostgresReplyDiscussionContext,'readPreparation'|'validatePreparation'|'preparationDependencies'>;
 assistant:Pick<ReplyAssistantGuards,'readContinuationBasis'>;
 explored?:ReplyExploredContextValidator;
}
const scope=(i:ReplyPreparedIdentity)=>({owner_id:i.owner_id,contact_id:i.contact_id});
const omit=(v:Row,keys:string[])=>Object.fromEntries(Object.entries(v).filter(([k])=>!keys.includes(k)));
const unique=(ids:string[])=>[...new Set(ids)].sort();
function oldDiscussion(d:ReplyDiscussionContext|null):Row|null {if(!d)return null;return {...d,snapshot:{...omit(d.snapshot,['version']),basis_revision_sha256:d.snapshot.basis_revision_sha256??null}};}
function oldContext(s:ReplyPreparedState):Row{
 const c=s.context;
 const material=(v:any)=>v?{...v,snapshot:{...v.snapshot,quality_receipt:v.snapshot.quality_receipt??null}}:null;
 return {reply_request_id:c.reply_request_id,scope:c.scope,current_text:c.current_text,direction:c.direction?{...c.direction,suggestion:(c.command as ReplyRequestInput).suggestion??null}:null,
 evidence:c.evidence.map(e=>omit(e,['freshness_sha256'])),skill_library_revision:BigInt(s.skillRevision),risk_notes:c.risk_notes,memory_revision:c.memory_revision,index_revision:c.index_revision,tool_calls:c.tool_calls??[],assistant_discussion:oldDiscussion(s.discussion),continuation_basis:c.continuation_basis??null,retrieval:c.retrieval??null,
 layered_context:material(c.layered_context),layered_status:c.layered_status??'quality_closed',layered_read_failed:c.layered_read_failed??false,layered_scenario_reads:c.layered_scenario_reads??[],owner_layered_context:material(c.owner_layered_context),owner_layered_status:c.owner_layered_status??'quality_closed',owner_layered_read_failed:c.owner_layered_read_failed??false,owner_layered_scenario_reads:c.owner_layered_scenario_reads??[],overview_read_failed:c.overview_read_failed??false,
 expression_preferences:s.preferences.preferences.map(p=>({...omit(p,['scope','origin']),scope:{owner_id:c.scope.owner_id,...p.scope},origin_kind:p.origin.kind,origin_id:p.origin.id??null})),expression_preference_revision:s.preferences.revision,history_message_ids:c.history_message_ids};
}
export class ReplyPreparedContexts {
 private readonly options:ReplyPreparedOptions;
 readonly contextOptions:ReplyContextOptions;
 constructor(options:ReplyPreparedOptions){this.options=options;this.contextOptions={readContinuationBasis:(...args)=>options.assistant.readContinuationBasis(...args)};}
 private check(identity:ReplyPreparedIdentity){if(identity.contact_id!==this.options.command.contact_id||identity.idempotency_key!==this.options.command.idempotency_key)throw new ReplyContextError('准备输入身份不一致。');}
 async build(client:Client,identity:ReplyPreparedIdentity,historyIds:string[]):Promise<ReplyPreparedState>{
  this.check(identity);if(historyIds.length>500||new Set(historyIds).size!==historyIds.length)throw new ReplyContextError('准备历史范围无效。');
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${identity.owner_id}`]);
  const context=await new PostgresReplyContext(client,this.contextOptions).build({...scope(identity),reply_request_id:randomUUID(),request:this.options.command,conversation_binding_id:identity.conversation_binding_id,history_message_ids:historyIds});
  if(this.options.command.suggestion){if(!this.options.explored)throw new ReplyContextError('探索复验端口不可用。');await this.options.explored.captureExploredDependencies(client,context);}
  const discussion=await this.options.discussion.readPreparation(client,identity);
  const preferences=await selectApplicablePreferences(client,identity.owner_id,identity.contact_id,this.options.command.content.type);
  const skillRevision=String((await client.query('SELECT revision FROM skill_library WHERE owner_id=$1',[identity.owner_id])).rows[0]?.revision??0);
  const state={context,discussion,preferences,skillRevision,dependency_ids:[]};await this.validate(client,identity,state);return state;
 }
 encode(state:ReplyPreparedState):unknown{return encodePreparedContext(oldContext(state));}
 dependencies(state:ReplyPreparedState):string[]{return [...state.dependency_ids];}
 async restore(client:Client,identity:ReplyPreparedIdentity,encoded:unknown,requestId?:string):Promise<ReplyPreparedState>{
  this.check(identity);const c=decodePreparedContext(encoded,this.options.command,scope(identity),identity.conversation_binding_id,requestId);
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${identity.owner_id}`]);
  const discussion=c.assistant_discussion?{...c.assistant_discussion,snapshot:{version:1,...omit(c.assistant_discussion.snapshot,['basis_revision_sha256']),...(c.assistant_discussion.snapshot.basis_revision_sha256?{basis_revision_sha256:c.assistant_discussion.snapshot.basis_revision_sha256}:{})}}:null;
  const preferences:ReplyPreferenceSnapshot=c.expression_preference_revision===null?restoreLegacyEmptyPreferences():{revision:c.expression_preference_revision,preferences:c.expression_preferences.map((p:Row)=>({...omit(p,['scope','origin_kind','origin_id']),scope:omit(p.scope,['owner_id']),origin:p.origin_id?{kind:p.origin_kind,id:p.origin_id}:{kind:p.origin_kind}}))};
  const context={...omit(c,['skill_library_revision','assistant_discussion','expression_preferences','expression_preference_revision']),command:this.options.command,conversation_binding_id:identity.conversation_binding_id,navigation_dependency_ids:unique(c.evidence.flatMap((e:Row)=>e.navigation?.dependency_ids??[]))} as unknown as BuiltReplyContext;
  // 旧格式没有TS内部行指纹。只对冻结ID读取当前资格，逐字段相等后绑定指纹，不能重选正文。
  const messages=context.evidence.filter(e=>e.kind==='message');
  const current=messages.length?await readContextMessages(client,scope(identity),{ids:messages.map(e=>e.evidence_id),limit:messages.length}):[];
  for(const e of context.evidence){let fresh:Row|undefined;if(e.kind==='message')fresh=current.find(v=>v.evidence_id===e.evidence_id);
   else if(['confirmed_memory','owner_memory','pending_candidate'].includes(e.kind)){const kind=e.kind as MemoryKind,row=(await readContextMemories(client,scope(identity),kind,[e.evidence_id]))[0];if(row)fresh=memoryEvidence(row,scope(identity),kind);}
   else continue;
   if(!fresh||canonicalJSON(omit({...fresh,selection_reason:e.selection_reason,model_visible:e.model_visible,navigation:e.navigation},['freshness_sha256']))!==canonicalJSON(e))throw new ReplyContextError('固定证据正文、版本或语义已变化。');e.freshness_sha256=fresh.freshness_sha256;
  }
  const state:ReplyPreparedState={context,discussion,preferences,skillRevision:String(c.skill_library_revision),dependency_ids:[]};await this.validate(client,identity,state);return state;
 }
 async validate(client:Client,identity:ReplyPreparedIdentity,state:ReplyPreparedState):Promise<void>{
  this.check(identity);await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${identity.owner_id}`]);
  // 编解码严格验证完整字段和原scope/偏好/检索合同，不把不认识的旧格式升级。
  decodePreparedContext(this.encode(state),this.options.command,scope(identity),identity.conversation_binding_id);
  await new PostgresReplyContext(client,this.contextOptions).validateCurrent(state.context);
  if(this.options.command.suggestion){if(!this.options.explored)throw new ReplyContextError('探索复验端口不可用。');await this.options.explored(client,state.context);}
  await this.options.discussion.validatePreparation(client,identity,state.discussion);
  if(!isLegacyEmptyPreferences(state.preferences))await validatePreferenceSnapshot(client,identity.owner_id,identity.contact_id,this.options.command.content.type,state.preferences);
  else if(state.preferences.preferences.length)throw new PreparedContextFormatError();
  if(String((await client.query('SELECT revision FROM skill_library WHERE owner_id=$1',[identity.owner_id])).rows[0]?.revision??0)!==state.skillRevision)throw new ReplyContextError('准备Skill修订已变化。');
  const dependencies:string[]=[];
  for(const e of state.context.evidence){const refs=await evidenceSources(client,identity.owner_id,e,false,{historical:e.timing.current_status==='historical',text:e.text});dependencies.push(...refs);if(['message','confirmed_memory','owner_memory','pending_candidate'].includes(e.kind))dependencies.push(e.evidence_id);}
  for(const p of state.preferences.preferences)dependencies.push(p.preference_id,...p.source_ids,...p.origin.id?[p.origin.id]:[]);
  if(!state.discussion)throw new ReplyContextError('准备讨论身份缺失。');
  dependencies.push(...await this.options.discussion.preparationDependencies(client,identity,state.discussion));
  if(state.context.continuation_basis){const previous=(await client.query('SELECT reply_request_id FROM reply_candidate WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[identity.owner_id,identity.contact_id,state.context.continuation_basis.candidate_id])).rows[0];if(!previous)throw new ReplyContextError();dependencies.push(...await generationDependencies(client,identity.owner_id,identity.contact_id,{turn_dependencies:[],reply_request_id:previous.reply_request_id}));}
  state.dependency_ids=unique([...dependencies,...replyGenerationNavigationDependencies(state.context)]);
 }
}
