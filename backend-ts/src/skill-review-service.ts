/** 同一生产上下文下的旧策略／无策略与隔离草稿对照，不临时发布。 */
import type {Context} from '@deepseek-ai/cordis';
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import type {ModelPermitArbiter} from './model-permits.ts';
import type {PostgresModelLedger} from './model-ledger.ts';
import type {installModelProvider} from './model-provider.ts';
import type {ReplyServiceModel} from './reply-service.ts';
import {PostgresReplyContext,type BuiltReplyContext} from './reply-context.ts';
import {parseReplyRequest,type ReplyRequestInput} from './reply-contract.ts';
import {PostgresSkillPort,type SkillUse} from './skill-port.ts';
import {ReplySkillSession} from './reply-skill-runtime.ts';
import type {SkillEntry,SkillReadPort,SkillScope} from './skill-runtime.ts';
import {generateReplyLoop} from './reply-loop.ts';
import {replyPayloadText} from './reply-payload.ts';
import {replySystemPrompt} from './reply-system-prompt.ts';
import {createEvidenceAliases} from './reply-evidence-alias.ts';
import {selectApplicablePreferences,type PreferenceSnapshot} from './preference-service.ts';
import {skillDigest} from './skill-execution-view.ts';
import {
  SkillLearningInvalid,type ReviewInput,
  type SkillLearningScope,type SkillPublicationScope,
} from './skill-learning-contract.ts';
import type {SkillLearningDraftRow} from './skill-learning-store.ts';
import {
  type DraftExecutionProjection,type SkillReviewStore,
} from './skill-review-store.ts';
import type {ReviewLayeredMaterial} from './skill-review-sources.ts';
type Transaction=<T>(operation:(client:pg.Client)=>Promise<T>)=>Promise<T>;
export interface SkillReviewServiceOptions {
  ctx:Context;
  transaction:Transaction;
  review:SkillReviewStore;
  filesRoot:string;
  provider:Pick<ReturnType<typeof installModelProvider>,'beginCall'>;
  arbiter:Pick<ModelPermitArbiter,'acquire'>;
  ledger:Pick<PostgresModelLedger,'reserve'|'record'>;
  model:ReplyServiceModel;
}
function digestValue(value:unknown):unknown{
  if(typeof value==='bigint')return Number(value);
  if(Array.isArray(value))return value.map(digestValue);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,item])=>[key,digestValue(item)]));
  return value;
}
function contextFingerprint(context:BuiltReplyContext,preferences:PreferenceSnapshot,libraryRevision:number,scene:string|null):string{
  const evidence=context.evidence.map(item=>{
    const value=structuredClone(item) as any;
    delete value.freshness_sha256;
    if(['user_draft','user_purpose'].includes(item.kind))delete value.evidence_id;
    return value;
  });
  return skillDigest({text:context.current_text,evidence,binding:context.conversation_binding_id,
    scene,library:libraryRevision,memory:context.memory_revision,
    index:context.index_revision,preferences:digestValue(preferences.preferences),
    preference_revision:preferences.revision===null?null:Number(preferences.revision),
    layered:{contact:context.layered_context,owner:context.owner_layered_context}});
}
export async function prepareReviewContext(
  transaction:Transaction,scope:SkillLearningScope,input:ReviewInput,
){
  const binding=(await transaction(client=>client.query(`SELECT id FROM public.conversation_binding
    WHERE owner_id=$1 AND contact_id=$2 AND status='active' ORDER BY created_at,id LIMIT 1`,
  [scope.owner_id,scope.contact_id]))).rows[0]?.id as string|undefined;
  if(!binding)throw new SkillLearningInvalid();
  const request=parseReplyRequest({contact_id:scope.contact_id,idempotency_key:randomUUID(),
    content:{type:'rewrite_draft',input_kind:'draft',draft_text:input.incoming_text,
      user_instruction:`审核演示输入，不证明收到或发送。用户本次明确意图：${input.intent}`,
      include_relationship_context:true,excluded_message_ids:[]},
    skill_version_id:null,skill_disabled:false,scene:input.scene});
  const built=await transaction(async client=>{
    const context=await new PostgresReplyContext(client).build({owner_id:scope.owner_id,contact_id:scope.contact_id,
      reply_request_id:request.idempotency_key,conversation_binding_id:binding,request});
    await new PostgresReplyContext(client).validateCurrent(context);
    const preferences=await selectApplicablePreferences(client,scope.owner_id,scope.contact_id,request.content.type);
    const libraryRevision=Number((await client.query('SELECT revision FROM public.skill_library WHERE owner_id=$1',
      [scope.owner_id])).rows[0]?.revision??0);
    const dependencies=new Set<string>();
    for(const item of context.evidence){
      if(!['user_draft','user_purpose'].includes(item.kind))dependencies.add(item.evidence_id);
      for(const id of item.source_ids)dependencies.add(id);
      for(const id of item.navigation?.dependency_ids??[])dependencies.add(id);
    }
    for(const preference of preferences.preferences as any[]){
      dependencies.add(preference.preference_id);for(const id of preference.source_ids??[])dependencies.add(id);
    }
    const navigation=context.evidence.flatMap(item=>item.navigation?[{
      scope_kind:item.navigation.scope_kind,memory_id:item.navigation.memory_id,
      memory_revision:item.navigation.memory_revision,dependency_ids:[...item.navigation.dependency_ids].sort(),
    }]:[]);
    const layered:ReviewLayeredMaterial[]=[];
    if(context.layered_context)layered.push({scope:{owner_id:scope.owner_id,contact_id:scope.contact_id},
      snapshot:context.layered_context.snapshot});
    if(context.owner_layered_context)layered.push({scope:{owner_id:scope.owner_id,contact_id:null},
      snapshot:context.owner_layered_context.snapshot});
    const revisions={library:libraryRevision,memory:context.memory_revision,index:context.index_revision,
      preferences:preferences.revision===null?null:Number(preferences.revision),binding_id:binding};
    return {binding,request,context,preferences,
      fingerprint:contextFingerprint(context,preferences,libraryRevision,request.scene),
      dependencies:[...dependencies].sort(),layered,revisions,navigation};
  });
  return built;
}
class BeforePort implements SkillReadPort {
  private readonly port:PostgresSkillPort;
  private readonly targetVersion:string|null;
  constructor(port:PostgresSkillPort,targetVersion:string|null){
    this.port=port;this.targetVersion=targetVersion;
  }
  dispose(){this.port.dispose();}
  async catalog(scope:SkillScope,signal?:AbortSignal){
    const catalog=await this.port.catalog(scope,signal);
    return {...catalog,entries:this.targetVersion?catalog.entries.filter(entry=>entry.versionId===this.targetVersion):[]};
  }
  loadVersion(...args:Parameters<SkillReadPort['loadVersion']>){return this.port.loadVersion(...args);}
  resource(...args:Parameters<SkillReadPort['resource']>){return this.port.resource(...args);}
  async validate(scope:SkillScope,revision:string,selected:SkillEntry|null,signal?:AbortSignal){
    if(selected&&selected.versionId!==this.targetVersion)throw new SkillLearningInvalid();
    await this.port.validate(scope,revision,selected,signal);
  }
  captureUse(...args:Parameters<NonNullable<SkillReadPort['captureUse']>>){return this.port.captureUse!(...args);}
}
class DraftPort implements SkillReadPort {
  private readonly scope:SkillLearningScope;
  private readonly draft:SkillLearningDraftRow;
  private readonly comparisonId:string;
  private readonly runToken:string;
  private readonly fingerprint:string;
  private readonly libraryRevision:string;
  private readonly projection:DraftExecutionProjection;
  private readonly review:SkillReviewStore;
  private readonly validateCurrent:()=>Promise<void>;
  constructor(
    scope:SkillLearningScope,
    draft:SkillLearningDraftRow,
    comparisonId:string,
    runToken:string,
    fingerprint:string,
    libraryRevision:string,
    projection:DraftExecutionProjection,
    review:SkillReviewStore,
    validateCurrent:()=>Promise<void>,
  ){
    this.scope=scope;this.draft=draft;this.comparisonId=comparisonId;this.runToken=runToken;
    this.fingerprint=fingerprint;this.libraryRevision=libraryRevision;this.projection=projection;
    this.review=review;this.validateCurrent=validateCurrent;
  }
  private entry(scope:SkillScope):SkillEntry {
    if(scope.ownerId!==this.scope.owner_id||scope.contactId!==this.scope.contact_id)
      throw new SkillLearningInvalid();
    return {skillId:this.draft.logical_skill_id,versionId:this.comparisonId,name:this.projection.name,
      description:this.projection.description,contentHash:this.projection.contentHash,resourcePaths:[]};
  }
  async catalog(scope:SkillScope){return {revision:this.libraryRevision,entries:[this.entry(scope)]};}
  async loadVersion(scope:SkillScope,entry:SkillEntry){
    if(entry.versionId!==this.comparisonId)throw new SkillLearningInvalid();
    await this.validate(scope,this.entry(scope).versionId,entry);
    return {content:this.projection.content,contentHash:this.projection.contentHash};
  }
  async resource():Promise<never>{throw new SkillLearningInvalid();}
  async validate(_scope:SkillScope,_revision:string,selected:SkillEntry|null){
    await this.validateCurrent();
    await this.review.validateComparison(this.scope,this.comparisonId,this.runToken,this.fingerprint);
    if(selected&&selected.versionId!==this.comparisonId)throw new SkillLearningInvalid();
  }
  async captureUse(scope:SkillScope,entry:SkillEntry,_revision:string,metadata:Record<string,any>):Promise<SkillUse>{
    await this.validate(scope,this.entry(scope).versionId,entry);
    const strategy=this.draft.strategy;
    if(!strategy)throw new SkillLearningInvalid();
    return {skill_id:this.draft.logical_skill_id,version_id:this.comparisonId,name:this.projection.name,
      selection_method:metadata.selection_method??'auto',selection_reason:metadata.selection_reason??'',
      resource_paths:[],load_state:'loaded',version_number:0,
      scope_kind:strategy.scope_suggestion.contact_id?'contact':
        strategy.scope_suggestion.kind==='scene'?'scene':'owner',
      scope_contact_id:strategy.scope_suggestion.contact_id??null,
      scope_scene:strategy.scene??null,execution_view:this.projection.execution_view};
  }
}
function previewPayload(candidates:readonly {text:string;basis:string;risk_notes:string[]}[],use:SkillUse|null){
  if(!use)return {name:null,version_id:null,load_state:'not_used',candidates:candidates.map(item=>({
    text:item.text,basis:item.basis,risk_notes:[...item.risk_notes]}))};
  return {name:use.name,version_id:use.version_id,load_state:use.load_state,...(use.execution_view?{execution_view:use.execution_view}:{}),
    candidates:candidates.map(item=>({text:item.text,basis:item.basis,risk_notes:[...item.risk_notes]}))};
}
export class SkillReviewService {
  private readonly options:SkillReviewServiceOptions;
  constructor(options:SkillReviewServiceOptions){
    if(!isAbsolute(options.filesRoot))throw new Error('skill_review_files_root_invalid');
    this.options=options;
  }
  read(scope:SkillLearningScope,draftId:string){return this.options.review.read(scope,draftId);}
  edit(scope:SkillLearningScope,command:{draftId:string;expectedRevision:number;operationKey:string;strategy:Record<string,unknown>}){
    return this.options.review.change(scope,command);
  }
  decision(scope:SkillLearningScope,command:{draftId:string;expectedRevision:number;operationKey:string;decision:'reject'|'defer'}){
    return this.options.review.change(scope,command);
  }
  approve(scope:SkillLearningScope,command:{draftId:string;expectedRevision:number;operationKey:string;
    comparisonId:string;scopeConfirmation:SkillPublicationScope}){
    return this.options.review.approve(scope,command);
  }
  private async generate(session:ReplySkillSession,context:BuiltReplyContext,preferences:PreferenceSnapshot,
    request:ReplyRequestInput,signal:AbortSignal,comparisonId:string,side:'before'|'after',
    requireCurrent:()=>Promise<void>):Promise<{candidates:readonly {text:string;basis:string;risk_notes:string[]}[];use:SkillUse|null}> {
    const model=this.options.model;
    const sideRequest={...request,idempotency_key:randomUUID()};
    const aliases=createEvidenceAliases();
    let use:SkillUse|null=null;
    const result=await generateReplyLoop(this.options.ctx,{owner_id:context.scope.owner_id,contact_id:context.scope.contact_id,
      request_id:sideRequest.idempotency_key,...model,physical_limit:model.physical_limit,deadline_ms:model.deadline_ms,
      prompt:replyPayloadText({request:sideRequest,context,preferences:preferences.preferences,discussion:null,aliases}),
      system_prompt:replySystemPrompt(context,null)},
    {provider:this.options.provider,budgetProfile:model.budgetProfile,
      acquire:async signal=>{const permit=await this.options.arbiter.acquire('foreground',signal);
        return {id:permit.id,settle:async()=>permit.settle()};},
      requireCurrent,
      reserve:async receipt=>this.options.ledger.reserve(receipt,model.physical_limit),
      record:async receipt=>{await this.options.ledger.record(receipt);
        const entryId=receipt.ledger_entry_id??receipt.attempt_id;
        if(['response_observed','http_accepted'].includes(receipt.dispatch))
          await this.options.review.recordCall(
            {owner_id:context.scope.owner_id,contact_id:context.scope.contact_id},comparisonId,side,entryId);},
      persist:async _candidates=>{use=session.use},
      evidenceIds:()=>new Set(context.evidence.map(item=>item.evidence_id)),
      tools:session.tools(),skillSession:session,aliases},signal);
    return {candidates:result.candidates,use};
  }
  async compare(scope:SkillLearningScope,command:{
    draftId:string;expectedRevision:number;operationKey:string;input:ReviewInput;scopeConfirmation:SkillPublicationScope;
  },signal:AbortSignal){
    signal.throwIfAborted();
    const built=await prepareReviewContext(this.options.transaction,scope,command.input);
    const started=await this.options.review.beginComparison(scope,{draftId:command.draftId,
      expectedRevision:command.expectedRevision,operationKey:command.operationKey,input:command.input,
      scopeConfirmation:command.scopeConfirmation,contextFingerprint:built.fingerprint,
      contextDependencies:built.dependencies,contextRevisions:built.revisions,navigation:built.navigation,
      layered:built.layered});
    if(started.replay)return this.options.review.read(scope,command.draftId);
    const draft=started.draft,comparison=started.comparison;
    const validate=async()=>{
      await this.options.transaction(async client=>{
        await new PostgresReplyContext(client).validateCurrent(built.context);
        const preferences=await selectApplicablePreferences(client,scope.owner_id,scope.contact_id,built.context.command.content.type);
        if(skillDigest(digestValue(preferences))!==skillDigest(digestValue(built.preferences)))throw new SkillLearningInvalid();
      });
      await this.options.review.validateComparison(scope,comparison.id,comparison.run_token,built.fingerprint);
    };
    try{
      await validate();
      const execution=await this.options.review.validateComparison(scope,comparison.id,comparison.run_token,built.fingerprint,true);
      if(!('projection' in execution)||!execution.projection)throw new SkillLearningInvalid();
      const target=draft.target_versions?.[0]?.version_id??null;
      const production=new PostgresSkillPort({read:this.options.transaction},this.options.filesRoot);
      const beforeSession=await ReplySkillSession.open(new BeforePort(production,target),
        {ownerId:scope.owner_id,contactId:scope.contact_id,scene:command.input.scene},
        {skill_version_id:target,skill_disabled:false},signal);
      const before=await this.generate(beforeSession,built.context,built.preferences,built.request,signal,comparison.id,'before',validate);
      await validate();
      if(target&&(!before.use||before.use.version_id!==target))throw new SkillLearningInvalid();
      const draftPort=new DraftPort(scope,draft,comparison.id,comparison.run_token,built.fingerprint,String(comparison.library_revision),
        execution.projection,this.options.review,validate);
      const afterSession=await ReplySkillSession.open(draftPort,
        {ownerId:scope.owner_id,contactId:scope.contact_id,scene:command.input.scene},
        {skill_version_id:comparison.id,skill_disabled:false},signal);
      const after=await this.generate(afterSession,built.context,built.preferences,built.request,signal,comparison.id,'after',validate);
      await validate();
      if(!after.use||after.use.version_id!==comparison.id)throw new SkillLearningInvalid();
      return await this.options.review.finishComparison(scope,comparison.id,comparison.run_token,built.fingerprint,{
        before:previewPayload(before.candidates,before.use),
        after:previewPayload(after.candidates,after.use),
      });
    }catch(error){
      try{await validate();}catch{}
      await this.options.review.failComparison(scope,comparison.id,comparison.run_token).catch(()=>{});
      throw error;
    }
  }
}
