import {replyGenerationNavigationDependencies,isLegacyEmptyPreferences,type ReplyPreferenceSnapshot} from './reply-generation-guards.ts';
import {ReplyPreparedContexts} from './reply-prepared-context.ts';
import {parseJson} from './host-json.ts';
import type {ReplyExploredContextValidator} from './reply-exploration-guards.ts';
/** 模型调用前的真实SQL准备与工具完成后的快照组装；事务由宿主提供。 */
import type {Client} from 'pg';
import {defineTool,type ToolDefinition,type ToolRunContext} from '@deepseek-ai/dsh-tools';
import {PostgresReplyContext,retrievalReceiptPayload,allowsHistory} from './reply-context.ts';
import type {BuiltReplyContext,ReplyContextOptions,ContextMetadata} from './reply-context-types.ts';
import {ReplyContextError} from './reply-context-types.ts';
import type {ReplyRequestInput} from './reply-contract.ts';
import type {ReplyStoreRequest,ReplyStoreContext} from './reply-store.ts';
import type {ReplyAssistantGuards,ReplyAssistantContext} from './reply-assistant-guards.ts';
import type {PostgresReplyDiscussionContext,ReplyDiscussionContext} from './reply-discussion-context.ts';
import {selectApplicablePreferences,validatePreferenceSnapshot} from './preference-service.ts';
import {ReplyScenarioAccess,replyScenarioReadPolicy} from './reply-context-scenario.ts';
import type {ReplyHistory} from './reply-history.ts';
export interface PreparationController {
 assistant:Pick<ReplyAssistantGuards,'readContinuationBasis'>;
 discussion:Pick<PostgresReplyDiscussionContext,'read'|'validateCurrent'|'readPreparation'|'validatePreparation'|'preparationDependencies'>;
 bindPrepared(input:{context:BuiltReplyContext;discussion:ReplyDiscussionContext|null;preferences:ReplyPreferenceSnapshot;skillRevision:string;contextOptions?:ReplyContextOptions}):void;
}
export interface PreparedReply {
 request:ReplyStoreRequest;command:ReplyRequestInput;context:BuiltReplyContext;discussion:ReplyDiscussionContext|null;
 historyBudget?:ContextMetadata;preferences:ReplyPreferenceSnapshot;skillRevision:string;storeContext:ReplyAssistantContext;contextOptions:ReplyContextOptions;frozen:boolean;
}
export interface ReplyPreparationOptions {
 transaction<T>(read:(client:Client)=>Promise<T>):Promise<T>;
 controller:PreparationController;
 requireCurrent(client:Client):Promise<void>;
 explored?:ReplyExploredContextValidator;
}
const versionIds=(material:BuiltReplyContext['layered_context'])=>material?[...material.snapshot.scenarios.map(item=>item.version_id),...(material.snapshot.profile_version_id?[material.snapshot.profile_version_id]:[])].sort():[];
/** 实际正文工具与零HTTP预检共用完整schema，预检不构造虚假的C请求。 */
export function createReplyScenarioReadTool(execute:(args:Record<string,unknown>,execution:ToolRunContext)=>Promise<string>):ToolDefinition{
 return defineTool({name:'read_scenario',description:'按本次目录稳定scenario_id与零基paragraph_index读取完整单段；不接受身份、路径或版本。',parameters:{scenario_id:{type:'string',required:true},paragraph_index:{type:'integer',required:true}},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute});
}
export function preparedStoreContext(prepared:Omit<PreparedReply,'storeContext'>,inputBudget?:Record<string,unknown>):ReplyAssistantContext{
 const c=prepared.context,basis=c.continuation_basis;
 const evidence=structuredClone(c.evidence);
 const snapshot:Record<string,unknown>={...(prepared.command.allow_incomplete_history?{history_coverage_warning:'历史覆盖不完整：用户选择基于已同步部分继续，不能据此声称拥有完整语境。'}:{}),scope:structuredClone(c.scope),current_text:c.current_text,direction:structuredClone(c.direction),risk_notes:[...c.risk_notes],skill_library_revision:Number(prepared.skillRevision),memory_revision:c.memory_revision,index_revision:c.index_revision,
  layered_context:c.layered_context?JSON.parse(c.layered_context.payload_json):null,owner_layered_context:c.owner_layered_context?JSON.parse(c.owner_layered_context.payload_json):null,
  layered_status:c.layered_status,owner_layered_status:c.owner_layered_status,layered_read_failed:c.layered_read_failed??false,owner_layered_read_failed:c.owner_layered_read_failed??false,
  layered_scenario_reads:structuredClone(c.layered_scenario_reads??[]),owner_layered_scenario_reads:structuredClone(c.owner_layered_scenario_reads??[]),layered_version_ids:versionIds(c.layered_context),owner_layered_version_ids:versionIds(c.owner_layered_context),overview_read_failed:c.overview_read_failed??false,
  expression_preferences:prepared.preferences.preferences.map(item=>({preference_id:item.preference_id,text:item.text,revision:item.revision,scope:structuredClone(item.scope)})),expression_preference_revision:prepared.preferences.revision,
  tool_calls:structuredClone(c.tool_calls??[]),evidence,history_message_ids:c.history_message_ids};
 const retrieval=retrievalReceiptPayload(c);if(retrieval){snapshot.retrieval=retrieval;snapshot.navigation_dependency_ids=replyGenerationNavigationDependencies(c);}
 snapshot.navigation_dependency_ids=replyGenerationNavigationDependencies(c);
 if(basis)snapshot.continuation_basis={candidate_id:basis.candidate_id,basis_revision_sha256:basis.basis_revision_sha256,basis_changes:structuredClone(basis.basis_changes)};
 if(prepared.discussion)snapshot.assistant_discussion_snapshot=structuredClone(prepared.discussion.snapshot);
 if(prepared.historyBudget)snapshot.history_tool_budget=structuredClone(prepared.historyBudget);
 if(inputBudget)snapshot.input_budget=structuredClone(inputBudget);
 return {evidence:structuredClone(c.evidence),snapshot,skill_library_revision:Number(prepared.skillRevision),continuation_basis:basis??null,assistant_discussion_snapshot:prepared.discussion?.snapshot??null};
}
export class ReplyPreparation {
 private readonly options:ReplyPreparationOptions;
 private readonly accesses=new WeakMap<PreparedReply,{contact?:ReplyScenarioAccess;owner?:ReplyScenarioAccess}>();
 private readonly historyFinished=new WeakSet<ReplyHistory>();
 constructor(options:ReplyPreparationOptions){this.options=options;}
 private async lock(client:Client,owner:string){await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${owner}`]);}
 async prepare(client:Client,input:{request:ReplyStoreRequest;command:ReplyRequestInput;skillRevision:string;history_message_ids?:string[]|null}):Promise<PreparedReply>{
  const {request,command}=input;
  if(request.contact_id!==command.contact_id||request.idempotency_key!==command.idempotency_key||request.continued_from_candidate_id!==command.continued_from_candidate_id)throw new ReplyContextError('准备请求身份不一致。');
  await this.lock(client,request.owner_id);await this.options.requireCurrent(client);
  const revision=String((await client.query('SELECT revision FROM public.skill_library WHERE owner_id=$1',[request.owner_id])).rows[0]?.revision??0);
  if(revision!==input.skillRevision||!Number.isSafeInteger(Number(revision))||Number(revision)<0)throw new ReplyContextError('Skill目录修订已变化或无法表示。');
  const contextOptions:ReplyContextOptions={readContinuationBasis:(...args)=>this.options.controller.assistant.readContinuationBasis(...args)};
  const turn=(await client.query('SELECT state,input_payload,prepared_context::text AS prepared_context FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND idempotency_key=$3',[request.owner_id,request.contact_id,request.idempotency_key])).rows[0];
  if(turn?.prepared_context!==null&&turn?.prepared_context!==undefined&&(turn.input_payload===null||['redacted','unavailable'].includes(turn.state)))throw new ReplyContextError('固定上下文已失效。');
  const restored=turn?.prepared_context?await new ReplyPreparedContexts({command,discussion:this.options.controller.discussion,assistant:this.options.controller.assistant,explored:this.options.explored}).restore(client,request,parseJson(turn.prepared_context),request.request_id):null;
  const context=restored?.context??await new PostgresReplyContext(client,contextOptions).build({owner_id:request.owner_id,contact_id:request.contact_id,reply_request_id:request.request_id,conversation_binding_id:request.conversation_binding_id,request:command,history_message_ids:input.history_message_ids});
  if(!restored&&command.suggestion){if(!this.options.explored)throw new ReplyContextError('探索复验端口不可用。');await this.options.explored.captureExploredDependencies(client,context);}
  const discussion=restored?restored.discussion:await this.options.controller.discussion.read(client,request);
  const preferences=restored?restored.preferences:await selectApplicablePreferences(client,request.owner_id,request.contact_id,command.content.type);
  const base={request,command,context,discussion,preferences,skillRevision:revision,contextOptions,frozen:restored!==null};
  const prepared:PreparedReply={...base,storeContext:preparedStoreContext(base)};
  this.refresh(prepared);return prepared;
 }
 private refresh(prepared:PreparedReply,inputBudget?:Record<string,unknown>):ReplyStoreContext{
  prepared.storeContext=preparedStoreContext(prepared,inputBudget??prepared.storeContext?.snapshot.input_budget as Record<string,unknown>|undefined);
  this.options.controller.bindPrepared({context:prepared.context,discussion:prepared.discussion,preferences:prepared.preferences,skillRevision:prepared.skillRevision,contextOptions:prepared.contextOptions});
  return prepared.storeContext;
 }
 async validateCurrent(client:Client,prepared:PreparedReply):Promise<void>{
  await this.lock(client,prepared.request.owner_id);await this.options.requireCurrent(client);
  await new PostgresReplyContext(client,prepared.contextOptions).validateCurrent(prepared.context);
  if(prepared.command.suggestion){if(!this.options.explored)throw new ReplyContextError('探索复验端口不可用。');await this.options.explored(client,prepared.context);}
  await this.options.controller.discussion.validateCurrent(client,prepared.request,prepared.discussion);
  if(!isLegacyEmptyPreferences(prepared.preferences))await validatePreferenceSnapshot(client,prepared.request.owner_id,prepared.request.contact_id,prepared.command.content.type,prepared.preferences);
  const revision=String((await client.query('SELECT revision FROM public.skill_library WHERE owner_id=$1',[prepared.request.owner_id])).rows[0]?.revision??0);if(revision!==prepared.skillRevision)throw new ReplyContextError('Skill目录修订已变化。');
 }
 scenarioTools(prepared:PreparedReply):ToolDefinition[]{
  let accesses=this.accesses.get(prepared);
  if(!accesses){accesses={};for(const {side,material} of replyScenarioReadPolicy(prepared.context).reads)accesses[side]=new ReplyScenarioAccess(material);this.accesses.set(prepared,accesses);}
  const sides=Object.entries(accesses) as ['contact'|'owner',ReplyScenarioAccess][];if(!sides.length)return [];
  return [createReplyScenarioReadTool(async(args,execution)=>{
   execution.signal.throwIfAborted();
   const selected=sides.find(([side])=>{const material=side==='contact'?prepared.context.layered_context:prepared.context.owner_layered_context;return JSON.parse(material!.payload_json).directory.some((entry:ContextMetadata)=>entry.scenario_id===args.scenario_id);})??sides[0];
   const receipt=await this.options.transaction(async client=>{await this.validateCurrent(client,prepared);execution.signal.throwIfAborted();const value=await selected[1].read(client,args);execution.signal.throwIfAborted();return value;});
   this.updateScenarioReceipts(prepared);return JSON.stringify(receipt);
  })];
 }
 updateScenarioReceipts(prepared:PreparedReply):ReplyStoreContext{
  const sides=this.accesses.get(prepared);
  if(sides){prepared.context.layered_scenario_reads=sides.contact?.receipts??[];prepared.context.owner_layered_scenario_reads=sides.owner?.receipts??[];
   prepared.context.tool_calls=[...(prepared.context.tool_calls??[]).filter(call=>call.tool_name!=='read_scenario'),...[...prepared.context.layered_scenario_reads,...prepared.context.owner_layered_scenario_reads].map(receipt=>({tool_name:'read_scenario',status:receipt.status==='succeeded'?'succeeded':receipt.status==='budget_exceeded'?'budget_exceeded':'failed',evidence_ids:[],latency_ms:null}))];}
  return this.refresh(prepared);
 }
 finalizeHistory(prepared:PreparedReply,history:ReplyHistory):ReplyStoreContext{
  if(this.historyFinished.has(history))throw new ReplyContextError('历史工具结果已结算。');
  if(!allowsHistory(prepared.command))throw new ReplyContextError('本次没有历史读取权限。');
  const ids=new Set(prepared.context.evidence.map(item=>item.evidence_id)),additional=[];
  for(const item of history.evidence){if(item.scope.owner_id!==prepared.request.owner_id||item.scope.contact_id!==prepared.request.contact_id)throw new ReplyContextError('历史工具结果超出范围。');if(!ids.has(item.evidence_id)){additional.push(structuredClone(item));ids.add(item.evidence_id);}}
  const budget=prepared.context.retrieval?.source_messages??prepared.historyBudget??{call_limit:3,item_limit:16,token_limit:2048,used_calls:0,used_count:0,used_tokens:0,exhausted:false};
  if(budget){const usedCount=budget.used_count+history.evidence.length;if(usedCount>budget.item_limit||history.token_count>budget.token_limit||history.token_count<budget.used_tokens)throw new ReplyContextError('历史工具累计预算超出限制。');}
  prepared.context.evidence.push(...additional);
  prepared.context.tool_calls=[...prepared.context.tool_calls??[],...structuredClone(history.tool_calls)];
  if(budget){budget.used_calls=Math.min(budget.call_limit,budget.used_calls+history.tool_calls.length);budget.used_count+=history.evidence.length;budget.used_tokens=history.token_count;if(history.tool_calls.some(call=>call.status==='budget_exceeded')){budget.exhausted=true;if(prepared.context.retrieval&&prepared.context.retrieval.status!=='unavailable')prepared.context.retrieval.status='budget_exhausted';}}
  prepared.historyBudget=structuredClone(budget);
  this.historyFinished.add(history);return this.refresh(prepared);
 }
 finalize(prepared:PreparedReply,inputBudget?:Record<string,unknown>):ReplyStoreContext{return this.refresh(prepared,inputBudget);}
}
