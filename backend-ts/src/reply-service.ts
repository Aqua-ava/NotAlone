/** 回复生成总装：每轮只持有一个前台许可，所有来源复验和保存仍由业务事务负责。 */
import type {Context} from '@deepseek-ai/cordis';
import type {Client} from 'pg';
import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {ReplyError,normalizeReplyInput,parseReplyRequest,type ReplyCandidateInput,type ReplyRequestInput} from './reply-contract.ts';
import {requireReplyScope,type VerifiedReplyScope} from './reply-scope.ts';
import {PostgresReplyStore,ReplyStoreError,type ReplyStoreRequest,type ReplyStoreResult} from './reply-store.ts';
import {createReplyGenerationGuards,type ReplyGenerationGuardOptions} from './reply-generation-guards.ts';
import type {AuthenticatedContinuation} from './reply-assistant-guards.ts';
import {ReplyPreparation,createReplyScenarioReadTool,type PreparedReply} from './reply-preparation.ts';
import {ReplyPreparedContexts} from './reply-prepared-context.ts';
import {prepareAssistantReply} from './reply-preflight-prepared.ts';
import {preflightReplyAgent,fitPreparedReplyBudget} from './reply-preflight.ts';
import {PostgresSkillPort,SkillPortError} from './skill-port.ts';
import {SkillFiles} from './skill-files.ts';
import {createReplySkillGuards} from './reply-skill-guards.ts';
import {ReplySkillSession} from './reply-skill-runtime.ts';
import {ReplyHistory} from './reply-history.ts';
import {allowsHistory,recentOnly,ReplyContextError} from './reply-context.ts';
import {generateReplyLoop,registerReplyAgentSetup} from './reply-loop.ts';
import {replyPayloadText} from './reply-payload.ts';
import {replyPhysicalLimit,replyScenarioReadPolicy} from './reply-context-scenario.ts';
import {replyGeneratedPayload} from './reply-result.ts';
import {replySystemPrompt} from './reply-system-prompt.ts';
import type {ModelPermitArbiter} from './model-permits.ts';
import {modelLedgerInputBudget,type PostgresModelLedger} from './model-ledger.ts';
import type {installModelProvider} from './model-provider.ts';
import {ModelInputBudgetError,type MessagesBudgetProfile,type MessagesBudgetReceipt} from './model-input-budget.ts';
import {readReplyBasisChanges} from './reply-source-guards.ts';
import {createReplyExploredContextValidator} from './reply-exploration-guards.ts';
import {exploredSkillUse} from './exploration-skill-use.ts';
import {replyCandidateLimit} from './reply-candidate-admissibility.ts';
import {createEvidenceAliases} from './reply-evidence-alias.ts';

export interface ReplyServiceModel {
 provider:string;model:string;maxTokens:number;temperature:number;reasoningEffort:'off'|'low'|'high'|'max';
 physical_limit:number;deadline_ms:number;warning_ratio:number;budgetProfile:MessagesBudgetProfile;
}
export interface ReplyServiceOptions {
 ctx:Context;
 transaction<T>(operation:(client:Client)=>Promise<T>):Promise<T>;
 provider:Pick<ReturnType<typeof installModelProvider>,'beginCall'>;
 arbiter:Pick<ModelPermitArbiter,'acquire'>;
 ledger:Pick<PostgresModelLedger,'reserve'|'record'>;
 skillsRoot:string;
 model:ReplyServiceModel;
}
export interface ReplyInternalContext {
 authenticatedContinuation?:AuthenticatedContinuation;
 history_message_ids?:string[]|null;
 validateExploredContext?:ReplyGenerationGuardOptions['validateExploredContext'];
}
type ReplyBudgetState=Pick<PreparedReply,'context'|'discussion'|'preferences'|'skillRevision'|'historyBudget'>;
function replyResources(options:ReplyServiceOptions,transaction:ReplyServiceOptions['transaction'],scope:VerifiedReplyScope,input:ReplyRequestInput,internal:ReplyInternalContext,selectedSkillFailure?:ReplyGenerationGuardOptions['selectedSkillFailure']){
 let controller:ReturnType<typeof createReplyGenerationGuards>;
 const discussionValidator=async(client:Client,owner:string,contact:string,request:string)=>{
  const ids=await controller.assistant.requireReplyDiscussionById(client,{owner_id:owner,contact_id:contact},request);
  if(ids===null)throw new ReplyStoreError('reply_context_invalidated');return ids;
 };
 const skillPort=new PostgresSkillPort({read:transaction},options.skillsRoot,{requireDiscussionDependencies:discussionValidator});
 try{
  const explored=input.suggestion?createReplyExploredContextValidator({scope,input,skillsRoot:options.skillsRoot,authenticatedContinuation:internal.authenticatedContinuation}):undefined;
  const validateExploredContext=explored?async(client:Client,context:Parameters<typeof explored>[1])=>{await explored(client,context);await internal.validateExploredContext?.(client,context);}:internal.validateExploredContext;
  const savedSkill=createReplySkillGuards({files:new SkillFiles(options.skillsRoot),requireDiscussionDependencies:discussionValidator});
  controller=createReplyGenerationGuards({scope,input,authenticatedContinuation:internal.authenticatedContinuation,skillPort,savedSkill,validateExploredContext,selectedSkillFailure});
  return {controller,skillPort,savedSkill,explored};
 }catch(error){skillPort.dispose();throw error;}
}
function publicBudget(budget:MessagesBudgetReceipt,warningRatio:number):Record<string,unknown>{
 const total=budget.input_tokens+budget.maxTokens+budget.safety_margin_tokens;
 const exceeded=total>budget.context_window_tokens;
 return {state:exceeded?'exceeded':total>=Math.ceil(budget.context_window_tokens*warningRatio)?'warning':'ready',allowed:!exceeded,model_id:budget.model,
  context_window_tokens:budget.context_window_tokens,input_tokens:budget.input_tokens,output_reserve_tokens:budget.maxTokens,total_tokens:total,
  measurement_kind:budget.measurement_kind,measurement_id:budget.measurement_id,reason:exceeded?'context_window_exceeded':null,safety_margin_tokens:budget.safety_margin_tokens};
}
class ReplyInputBudgetError extends ReplyError {
 readonly input_budget:Record<string,unknown>;
 constructor(error:ModelInputBudgetError,model:ReplyServiceModel){
  super(error.code==='reply_budget_exceeded'?'input_budget_exceeded':'input_budget_unavailable',409);
  this.input_budget=error.receipt?publicBudget(error.receipt,model.warning_ratio):{state:'unavailable',allowed:false,model_id:model.model,
   context_window_tokens:model.budgetProfile.context_window_tokens,input_tokens:null,output_reserve_tokens:model.maxTokens,total_tokens:null,
   measurement_kind:null,measurement_id:null,reason:'measurement_unavailable',safety_margin_tokens:model.budgetProfile.safety_margin_tokens};
 }
}
function candidateRows(candidates:readonly ReplyCandidateInput[]){
 return candidates.map(candidate=>({candidate_id:randomUUID(),text:candidate.text,basis:candidate.basis,citation_ids:[...candidate.citation_ids],risk_notes:[...candidate.risk_notes],
  messages:(candidate.messages.length?candidate.messages:[candidate.text]).map(text=>({message_id:randomUUID(),text}))}));
}
function failure(error:unknown,signal:AbortSignal,model:ReplyServiceModel):ReplyError{
 if(error instanceof ReplyError)return error;
 if(signal.aborted)return new ReplyError('reply_cancelled',409);
 if(error instanceof ModelInputBudgetError)return new ReplyInputBudgetError(error,model);
 if(error instanceof ReplyStoreError)return new ReplyError(error.code,error.code==='reply_not_found'?404:409);
 if(error instanceof ReplyContextError)return new ReplyError(error.code,error.status);
 if(error instanceof SkillPortError)return new ReplyError(error.code==='reply_input_invalidated'?error.code:'reply_context_unavailable',409);
 const code=(error as {code?:unknown})?.code;
 if(code==='reply_budget_exceeded'||code==='reply_budget_unavailable')return new ReplyError(code,502);
 if(code==='model_ledger_scope_deleted')return new ReplyError('reply_context_unavailable',409);
 return new ReplyError('reply_generation_failed',502);
}
export class ReplyGenerationService {
 private readonly options:ReplyServiceOptions;
 constructor(options:ReplyServiceOptions){
  const m=options.model;
  if(!isAbsolute(options.skillsRoot)||!m.provider?.trim()||!m.model?.trim()||!Number.isSafeInteger(m.maxTokens)||m.maxTokens<1||!Number.isSafeInteger(m.physical_limit)||m.physical_limit<1
    ||!Number.isSafeInteger(m.deadline_ms)||m.deadline_ms<1||m.deadline_ms>20000||!Number.isFinite(m.temperature)||m.temperature<0||m.temperature>2||!Number.isFinite(m.warning_ratio)||m.warning_ratio<=0||m.warning_ratio>=1
    ||!Number.isSafeInteger(m.budgetProfile.context_window_tokens)||!Number.isSafeInteger(m.budgetProfile.safety_margin_tokens)||m.budgetProfile.safety_margin_tokens<1||m.budgetProfile.context_window_tokens<=m.maxTokens+m.budgetProfile.safety_margin_tokens
    ||!['off','low','high','max'].includes(m.reasoningEffort))throw new ReplyError('reply_model_configuration_invalid',503);
  this.options={...options,model:structuredClone(m)};
 }
 private async measurePrepared(scope:VerifiedReplyScope,input:ReplyRequestInput,internal:ReplyInternalContext,state:ReplyBudgetState,transaction:ReplyServiceOptions['transaction'],requireCurrent:()=>Promise<void>,signal:AbortSignal):Promise<MessagesBudgetReceipt>{
  const model=this.options.model;
  // 官方预检销毁自己的scope；每次裁剪重测均使用独立Skill运行态。
  const {skillPort}=replyResources(this.options,transaction,scope,input,internal);
  let probeSkill:ReplySkillSession|undefined;
  try{
   const aliases=createEvidenceAliases();
   const skill=probeSkill=await ReplySkillSession.open(skillPort,{ownerId:scope.owner_id,contactId:scope.contact_id,scene:input.scene??''},input,signal,aliases);
   if(skill.revision!==state.skillRevision)throw new ReplyError('reply_context_invalidated',409);
   const history=allowsHistory(input)&&!recentOnly(input)?new ReplyHistory({transaction,scope,binding_id:scope.conversation_binding_id,
    initial_evidence_ids:state.context.evidence.map(e=>e.evidence_id),navigation_message_ids:state.context.evidence.flatMap(e=>e.navigation?.source_message_ids??[]),
    excluded_message_ids:input.content.excluded_message_ids as string[]??[],allowed_message_ids:state.context.history_message_ids,
    prior_budget:state.context.retrieval?.source_messages??state.historyBudget,requireCurrent:async()=>requireCurrent(),aliases}):null;
   const unavailable=async():Promise<never>=>{throw new ReplyError('reply_preflight_tool_execution_invalid',502);};
   const tools=[...history?.tools()??[],...(replyScenarioReadPolicy(state.context).reads.length?[createReplyScenarioReadTool(unavailable)]:[]),...skill.tools()];
   return await preflightReplyAgent(this.options.ctx,{
    binding:{provider:model.provider,model:model.model,maxTokens:model.maxTokens,temperature:model.temperature,reasoningEffort:model.reasoningEffort},profile:model.budgetProfile,
    prompt:replyPayloadText({request:input,context:state.context,preferences:state.preferences.preferences,discussion:state.discussion,authenticated:internal.authenticatedContinuation,aliases}),
    requireCurrent,validateRegistry:()=>skill.validateRegistry(signal),
    async setup(agentScope){await registerReplyAgentSetup(agentScope,{system_prompt:replySystemPrompt(state.context,state.discussion,aliases),temperature:model.temperature},{tools,skillSession:skill,executeOutput:unavailable,signal});},
   },signal);
  }finally{probeSkill?.close();skillPort.dispose();}
 }
 async prepare(scope:VerifiedReplyScope,body:unknown,signal:AbortSignal,internal:ReplyInternalContext={}){
  const input=parseReplyRequest(body,internal.authenticatedContinuation),verified=structuredClone(scope);
  const transaction:ReplyServiceOptions['transaction']=operation=>this.options.transaction(async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${verified.owner_id}`]);return operation(client);
  });
  signal.throwIfAborted();await transaction(client=>requireReplyScope(client,verified,input));
  const {controller,skillPort,explored}=replyResources(this.options,transaction,verified,input,internal);
  try{
   const prepared=new ReplyPreparedContexts({command:input,discussion:controller.discussion,assistant:controller.assistant,explored});
   const identity={owner_id:verified.owner_id,contact_id:verified.contact_id,conversation_binding_id:verified.conversation_binding_id,idempotency_key:input.idempotency_key};
   const result=await prepareAssistantReply({transaction,scope:verified,input,authenticatedContinuation:internal.authenticatedContinuation,assistant:controller.assistant,prepared,
    fitBudget:(state,options)=>fitPreparedReplyBudget(state,options,selected=>this.measurePrepared(verified,input,internal,selected,transaction,async()=>{
     signal.throwIfAborted();await transaction(async client=>{await requireReplyScope(client,verified,input);await prepared.validate(client,identity,selected);if(input.suggestion)await internal.validateExploredContext?.(client,selected.context);});signal.throwIfAborted();
    },signal)),
   },signal);
   return {receipt:result.receipt,...(result.budget?{input_budget:publicBudget(result.budget,this.options.model.warning_ratio)}:{})};
  }catch(error){throw failure(error,signal,this.options.model);}finally{skillPort.dispose();}
 }
 async generate(scope:VerifiedReplyScope,body:unknown,signal:AbortSignal,internal:ReplyInternalContext={}){
  const input=parseReplyRequest(body,internal.authenticatedContinuation),verified=structuredClone(scope),model=this.options.model;
  const transaction=<T>(operation:(client:Client)=>Promise<T>)=>this.options.transaction(async client=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${verified.owner_id}`]);
   return operation(client);
  });
  signal.throwIfAborted();
  await transaction(client=>requireReplyScope(client,verified,input));
  // 在领取租约之前等前台许可，排队不会耗尽30秒业务租约；loop不再重复领取。
  const round=await this.options.arbiter.acquire('foreground',signal);
  let settled=false,owned:ReplyStoreRequest|undefined,skill:ReplySkillSession|undefined;
  let activeStore:PostgresReplyStore|undefined,activeSkillPort:PostgresSkillPort|undefined;
  const settle=async()=>{if(!settled){settled=true;round.settle();}};
  try{
  const {controller,skillPort,savedSkill,explored}=replyResources(this.options,transaction,verified,input,internal,()=>skill?.selectedSkillFailure()??null);activeSkillPort=skillPort;
  const store=activeStore=new PostgresReplyStore({transaction,guards:controller.guards});
  const resultPayload=async(result:ReplyStoreResult)=>replyGeneratedPayload(result,verified.contact_id,await transaction(client=>readReplyBasisChanges(client,verified,result.reply_request_id,savedSkill.savedSkillPolicyChange)));
   const started=await store.start({...verified,idempotency_key:input.idempotency_key,normalized_input:normalizeReplyInput(input),continued_from_candidate_id:input.continued_from_candidate_id});
   if(started.state==='replayed')return await resultPayload(started.result!);
   if(started.state==='in_progress')throw new ReplyError('reply_in_progress',409);
   owned=started.request;
   const request=owned;
   const aliases=createEvidenceAliases();
   skill=await ReplySkillSession.open(skillPort,{ownerId:verified.owner_id,contactId:verified.contact_id,scene:input.scene??''},input,signal,aliases);
   const preparation=new ReplyPreparation({transaction,controller,explored,requireCurrent:async client=>{await store.requireCurrentInTransaction(client,request);await requireReplyScope(client,verified,input);}});
   const prepared:PreparedReply=await transaction(client=>preparation.prepare(client,{request,command:input,skillRevision:skill!.revision,history_message_ids:internal.history_message_ids}));
   const requireCurrent=async()=>{signal.throwIfAborted();await transaction(client=>preparation.validateCurrent(client,prepared));await skill!.runtime.validate(signal);signal.throwIfAborted();};
   const fitted=await fitPreparedReplyBudget(prepared,{frozen:prepared.frozen,signal},selected=>this.measurePrepared(verified,input,internal,selected,transaction,requireCurrent,signal));
   prepared.context=fitted.state.context;const physicalLimit=replyPhysicalLimit(prepared.context,model.physical_limit);preparation.finalize(prepared);
   await store.prepareContext(request,prepared.storeContext);
   const history=allowsHistory(input)&&!recentOnly(input)?new ReplyHistory({transaction,scope:verified,binding_id:verified.conversation_binding_id,
    initial_evidence_ids:prepared.context.evidence.map(e=>e.evidence_id),navigation_message_ids:prepared.context.evidence.flatMap(e=>e.navigation?.source_message_ids??[]),
    excluded_message_ids:input.content.excluded_message_ids as string[]??[],allowed_message_ids:prepared.context.history_message_ids,
    prior_budget:prepared.context.retrieval?.source_messages??prepared.historyBudget,
    requireCurrent:client=>preparation.validateCurrent(client,prepared),aliases}):null;
   const tools=[...history?.tools()??[],...preparation.scenarioTools(prepared,aliases),...skill.tools()];
   let saved:ReplyStoreResult|undefined;
   await generateReplyLoop(this.options.ctx,{...verified,request_id:request.request_id,...model,physical_limit:physicalLimit,candidate_limit:replyCandidateLimit(prepared.context),
    prompt:replyPayloadText({request:input,context:prepared.context,preferences:prepared.preferences.preferences,discussion:prepared.discussion,authenticated:internal.authenticatedContinuation,aliases}),
    system_prompt:replySystemPrompt(prepared.context,prepared.discussion,aliases)},
   {provider:this.options.provider,budgetProfile:model.budgetProfile,acquire:async()=>({id:round.id,settle}),requireCurrent,skillSession:skill,tools,aliases,
    evidenceIds:()=>new Set([...prepared.context.evidence.filter(e=>e.model_visible).map(e=>e.evidence_id),...history?.evidence.map(e=>e.evidence_id)??[]]),
    reserve:async(receipt,budget,limit)=>{await this.options.ledger.reserve({...receipt,input_budget:modelLedgerInputBudget(budget)},limit);},
    record:receipt=>this.options.ledger.record(receipt),
    persist:async(candidates,budgets,commitSignal)=>{
     if(history)preparation.finalizeHistory(prepared,history);preparation.updateScenarioReceipts(prepared);
     const finalBudget=budgets.at(-1);if(!finalBudget)throw new ReplyError('reply_budget_unavailable',502);
     const context=preparation.finalize(prepared,publicBudget(finalBudget,model.warning_ratio));
     const used=input.suggestion?await transaction(client=>exploredSkillUse(client,verified,input,skill!.use)):skill!.use;
     saved=await store.save(request,context,candidateRows(candidates),used as unknown as Record<string,unknown>|null,commitSignal);
    }},signal);
   if(!saved)throw new ReplyError('reply_persistence_unavailable',503);
   return await resultPayload(saved);
  }catch(error){
   let rejected=failure(error,signal,model);
   if(owned&&activeStore)try{await activeStore.fail(owned,rejected.code);}catch{rejected=new ReplyError('reply_persistence_unavailable',503);}
   throw rejected;
  }finally{skill?.close();activeSkillPort?.dispose();await settle();}
 }
}
