import {randomUUID} from 'node:crypto';
import {currentDiagnosticTrace,diagnose,newTraceId,withDiagnosticTrace} from '../../../diagnostics/context.ts';
import {observeReply,replyFailureReason,type ReplyDiagnosticPhase} from '../diagnostics.ts';
import {sha256} from '../../../platform/sha256.ts';
import type {SqliteStorage} from '../../../storage/sqlite/client.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import {RELATIONSHIP_RETRIEVAL_GUIDE,REPLY_SEARCH_BUDGET,type RelationshipSearchKind} from '../retrieval-policy.ts';
import type {HostReplyModelConfiguration} from '../../../host/host-reply-config.ts';
import type {installModelProvider} from '../../../platform/models/model-provider.ts';
import type {ModelPermitArbiter} from '../../../platform/models/model-permits.ts';
import {SqliteSkillLibrary,skillAnchor} from '../../../skills/sqlite/library.ts';
import {openSqliteSkillRun} from '../../../skills/sqlite/provider.ts';
import {inSkillGroup,skillRunGroup} from '../../../skills/sqlite/groups.ts';
import type {SkillRunProtection,SkillRunRevision} from '../../../skills/sqlite/contracts.ts';
import type {SqliteDiscussionService} from '../service.ts';
import type {SqliteDiscussionRuntime} from '../runtime.ts';
import type {DiscussionAttempt} from '../contracts.ts';
import {SqliteDiscussionSkillProtection} from '../skill-protection.ts';
import {runSingleDiscussionTurn} from '../generation.ts';
import {isSkillReadFailure} from '../skill-loop.ts';
import {encode} from '../requests.ts';
import type {FrozenReplyInput} from './input.ts';
import type {SqliteReplyCandidateService} from './service.ts';
import type {RetrievalIndexLifecycle} from '../../../retrieval/index-runtime.ts';
import type {ReplySearchTicket,ReplySearchResult} from './search.ts';
import {readReplyWorkspace,replyWorkspaceEntryText,replyWorkspaceFingerprint,type ReplyWorkspace,type ReplyWorkspaceSnapshot} from './workspace.ts';
const systemPrompt='你是面向用户真实联系人的中文关系沟通回复助手。只围绕本次已确认联系人。依据本次输入和获准资料生成1至3组可编辑候选，不虚构经历、情绪、立场或承诺。事实、推测和未确认候选必须区分。workspace suggest动作只代表用户要可选思路；未提供或未确认的草稿、立场和关系意图保持未知，候选不得写成用户已采纳的主张或承诺。workspace express动作只围绕本次想法组织表达；草稿是用户对助手的任务描述，不一定是要逐句发送的私聊原文。补充背景、写作要求和最近聊天各自标注，不相互冒充。一次性写作要求仅作用本次，不读取或形成长期表达偏好。最终消息始终由用户选择、修改并亲自发送。每组候选的parts默认只写1条完整消息；只有两种情况才拆成2条（最多2条）：该联系人最近聊天里确有连发短消息的习惯，或内容天然分成两层意思（如先回应、再另起一个问题）。同组多条会按顺序依次发送，不是备选。只输出JSON：{"candidates":[{"parts":["一条完整的消息"],"basis":[1]}]}。basis是每条候选必填的非空整数数组；示例中的1只演示格式，实际必须引用本次已编号材料，不得照抄无关编号。即使只依据用户本次请求，也要填写对应的材料编号。不得省略basis、臆造资料或把Skill选择当作已加载。';
const candidateSystemPrompt=systemPrompt+'\n\n'+RELATIONSHIP_RETRIEVAL_GUIDE;
export interface ReplyGenerationInput {contactId:string;discussionId:string;requestKey:string;text:string;confirmedContact:true;acceptIncomplete?:boolean;carriedSelectionId?:string;selectedPackageId?:string;contextMessageIds?:string[];workspace?:ReplyWorkspace;signal?:AbortSignal}
export type ReplyPreparationStage='accepted'|'context-frozen'|'runtime-available';
interface Options {storage:SqliteStorage;service:SqliteReplyCandidateService;discussions:SqliteDiscussionService;runtime:SqliteDiscussionRuntime;model:HostReplyModelConfiguration;provider:Pick<ReturnType<typeof installModelProvider>,'beginCall'>;arbiter:ModelPermitArbiter;library?:SqliteSkillLibrary;authorize:(contactId:string)=>Promise<void>;onPreparationStage?:(stage:ReplyPreparationStage)=>void;/** 共享的本机检索索引；缺少语义模型时仍可使用BM25。 */retrieval?:Pick<RetrievalIndexLifecycle,'queryVector'|'wake'>;/** 可信装配仅可缩短历史搜索预算，供有界验证使用；页面与Tool不接收此参数。 */historySearchTimeoutMs?:number}
/** 与11共享实际DSH执行、provider和arbiter；候选不创建第二套调用身份或账本。 */
export class SqliteReplyTurns {
 private readonly options:Options;private stopping=false;private readonly pending=new Set<Promise<unknown>>();private readonly controllers=new Set<AbortController>();
 constructor(options:Options){this.options=options;}
 private stage(stage:ReplyPreparationStage):void{try{this.options.onPreparationStage?.(stage);}catch{}}
 private digest(requestId:string,revision:SkillRunRevision){return sha256(encode({format:1,systemPrompt:candidateSystemPrompt,model:this.options.model,revision,requestId}));}
 private async search(attempt:DiscussionAttempt,contextId:string,kind:RelationshipSearchKind,query:string,signal:AbortSignal):Promise<ReplySearchResult>{
  const o=this.options;
  // epoch毫秒跨宿主与SQLite Worker共享；资格、推理lane与SQL排队共用同一个截止点。
  const budget=kind==='history'?Math.max(1,Math.floor(Math.min(o.historySearchTimeoutMs??REPLY_SEARCH_BUDGET.historyTimeoutMs,REPLY_SEARCH_BUDGET.historyTimeoutMs))):undefined;
  const deadlineAt=budget===undefined?undefined:Date.now()+budget,budgetSignal=budget===undefined?undefined:AbortSignal.timeout(budget);
  const searchSignal=budgetSignal?AbortSignal.any([signal,budgetSignal]):signal;
  const ticket=await o.storage.execute<ReplySearchTicket>('reply.beginSearch',{...attempt,contextId,kind,query});
  if(ticket.status!=='accepted')return ticket;
  const finishInput={...attempt,contextId,ticketId:ticket.ticketId,query,...(deadlineAt===undefined?{}:{deadlineAt})};
  const timedOut=()=>budgetSignal?.aborted===true||deadlineAt!==undefined&&Date.now()>=deadlineAt;
  try{
   signal.throwIfAborted();
   if(timedOut())return await o.storage.execute<ReplySearchResult>('reply.finishSearch',{...finishInput,error:'timeout'});
   searchSignal.throwIfAborted();
   const vector=await o.retrieval?.queryVector(query,searchSignal,{contactId:attempt.contactId,kind,generation:attempt.dataGeneration});
   signal.throwIfAborted();
   if(timedOut())return await o.storage.execute<ReplySearchResult>('reply.finishSearch',{...finishInput,error:'timeout'});
   return await o.storage.execute<ReplySearchResult>('reply.finishSearch',{...finishInput,...(vector?.vector?{queryVector:vector.vector}:{})});
  }catch(error){
   if(!signal.aborted&&timedOut())return await o.storage.execute<ReplySearchResult>('reply.finishSearch',{...finishInput,error:'timeout'});
   await o.storage.execute('reply.finishSearch',{...finishInput,error:'failed'}).catch(()=>{});
   throw error;
  }
 }
 async configurationFor(contactId:string,discussionId:string):Promise<string|null>{
  const o=this.options,scope={ownerId:o.service.ownerId,contactId,discussionId};
  const read=()=>o.storage.execute<{requestId:string;revision:SkillRunRevision}|null>('reply.configuration',scope);
  const current=await read();if(!current)return null;
  for(const anchor of current.revision.eligible)await o.library?.assertAnchor(anchor);
  const checked=await read();return checked?this.digest(checked.requestId,checked.revision):null;
 }
 generate(input:ReplyGenerationInput){
  return withDiagnosticTrace(currentDiagnosticTrace()??newTraceId(),()=>{
  const observe=observeReply(input.contactId);observe('preparing');
  if(this.stopping){observe('blocked','shutdown');return Promise.reject(new StorageFailure('reply_runtime_closed'));}
  const controller=new AbortController();this.controllers.add(controller);
  const pending=this.generateOwned({...input,signal:input.signal?AbortSignal.any([input.signal,controller.signal]):controller.signal},observe).then(value=>{observe('completed');return value;},error=>{
   const reasonCode=replyFailureReason(error);observe('failed',reasonCode);diagnose({event:'diagnostics.error',module:'reply',caller:'reply_generate',reasonCode,...(/^[a-f0-9]{8}/.test(input.contactId)?{contactPrefix:input.contactId.slice(0,8)}:{})});throw error;
  });
  this.pending.add(pending);const release=()=>{this.pending.delete(pending);this.controllers.delete(controller);};pending.then(release,release);return pending;
  });
 }
 async close(){this.stopping=true;for(const c of this.controllers)c.abort();await Promise.allSettled([...this.pending]);}
 private async generateOwned(input:ReplyGenerationInput,observe:(phase:ReplyDiagnosticPhase,reasonCode?:string)=>void){
  const o=this.options,ownerId=o.service.ownerId;
  if(input.confirmedContact!==true)throw new StorageFailure('discussion_identity_required');
  const workspace=input.workspace===undefined?undefined:readReplyWorkspace(input.workspace);
  if(workspace&&(input.text!==workspace.draftText||input.contextMessageIds!==undefined||input.carriedSelectionId!==undefined&&!workspace.includeRelationshipContext))throw new StorageFailure('reply_input_invalid');
  await o.authorize(input.contactId);input.signal?.throwIfAborted();
  const confirmationId=await o.storage.execute<string>('identity.manualConfirm',{ownerId,contactId:input.contactId,contextToken:input.requestKey,id:randomUUID(),at:Date.now()});
  const requestText=workspace?replyWorkspaceEntryText(workspace):input.text;
  const workspaceFingerprint=workspace?replyWorkspaceFingerprint(workspace,input.selectedPackageId,input.carriedSelectionId):undefined;
  const workspaceSnapshot:ReplyWorkspaceSnapshot|undefined=workspace?{...workspace,selectedPackageId:input.selectedPackageId??null,carriedSelectionId:input.carriedSelectionId??null}:undefined;
  const begin=()=>o.service.begin({contactId:input.contactId,discussionId:input.discussionId,requestKey:input.requestKey,text:requestText,acceptIncomplete:input.acceptIncomplete,carriedSelectionId:input.carriedSelectionId,includeRelationshipContext:workspace?workspace.includeRelationshipContext:undefined,workspaceFingerprint,identity:{kind:'manual',confirmationId}});
  const accepted=await begin();
  const attempt=accepted.attempt as DiscussionAttempt;
  if(accepted.replayed)return {discussionId:attempt.discussionId,replayed:true,segmented:false};
  const acceptedAt=Date.now();let modelExecutionStarted=false;
  this.stage('accepted');observe('preparing','request_started');
  o.service.phase(input.contactId,attempt.discussionId,input.requestKey,'preparing');
  try{
   const callId=randomUUID(),contextId=randomUUID();
   let skillDegraded=false,catalog:any[];
   if(o.library){
    try{catalog=await o.library.refresh(input.signal);}
    catch(error){
     if(input.selectedPackageId||!isSkillReadFailure(error))throw error;
     skillDegraded=true;catalog=await o.storage.execute<any[]>('skills.list',{ownerId});
    }
   }else catalog=await o.storage.execute<any[]>('skills.list',{ownerId});
   // 只有联系人所在分组绑定的 Skill 才可用；未分组联系人没有任何可用 Skill，分组之外的失效包也不影响本联系人。
   const group=o.library?await o.library.groupScope(input.contactId,input.signal):null;
   const scope=group??{groupId:null,revision:0n,packageIds:[]};
   const grouped=inSkillGroup(catalog,scope);
   const eligible=grouped.filter(p=>p.enabledState==='enabled'&&p.verificationState==='verified'&&p.currentRevisionNo!==null&&(!input.selectedPackageId||p.id===input.selectedPackageId));
   if(input.selectedPackageId&&!eligible.some(p=>p.id===input.selectedPackageId))throw new StorageFailure('discussion_skill_unavailable');
   // 本组任一已启用策略缺失、未核验或当前修订不可用时整体撤下，不带其余策略继续。
   if(!input.selectedPackageId&&grouped.some(p=>p.enabledState==='enabled'&&(p.verificationState!=='verified'||p.currentRevisionNo===null)))skillDegraded=true;
   const runnable=skillDegraded?[]:eligible;
   const revision:SkillRunRevision={packages:catalog.map(p=>({id:p.id,headRevision:p.headRevision})),eligible:o.library?runnable.map(skillAnchor):[],...(group?{group:skillRunGroup(input.contactId,group)}:{})};
   const readItems=async()=>{
    // 候选只使用本次请求的显式消息；旧讨论 entry 兼容槽不参与候选装配，避免把助手讨论正文或来源带入新候选。
    const history=workspace
     ?workspace.includeRelationshipContext?await o.storage.execute<any[]>('discussion.localMessages',{...attempt,limit:50,knownTimeOnly:true}):[]
     :await o.storage.execute<any[]>('discussion.localMessages',{...attempt,limit:50,knownTimeOnly:true});
    const recentIds=history.map((m:any)=>m.id);
    const messageIds=workspace?recentIds:input.contextMessageIds??recentIds;
    const messages=await o.storage.execute<any[]>('discussion.messages',{...attempt,messageIds});
    return messages.map(m=>({kind:'message',sourceContactId:input.contactId,messageId:m.id,recordId:m.record_id,acceptedRevision:m.interpretation_revision}));
   };
   const items=await readItems();
   const frozen=await o.storage.execute<FrozenReplyInput[]>('reply.freezeInput',{...attempt,contextId,skillRun:revision,items,workspace:workspaceSnapshot,queryText:input.text,at:Date.now()});
   this.stage('context-frozen');observe('preparing','context_frozen');
   const requestIntent=workspace?workspace.action==='suggest'?'本次工作区动作：帮我想想。用户没有提供草稿时尚未确认任何立场，所有说法都只是可选思路。':'本次工作区动作：帮我表达。只按本次想法整理，不添加用户未确认的立场。':'本次明确请求：'+input.text;
   const prompt=requestIntent+'\n\n实际输入材料（编号用于basis）：\n'+frozen.map(item=>`[${item.itemNo}] ${item.kind}\n${item.text}`).join('\n\n')+'\n\n输出检查：每条候选必须同时包含parts和basis两个字段；basis至少填写一个本次实际材料编号。只写parts的候选无法交付。';
   // 每次候选任务重建独立副本；旧候选只有显式选择才进入新输入。
   const configurationDigest=this.digest(attempt.requestId,revision);
   await o.storage.execute('discussion.prepareCall',{...attempt,contextId,callId,operationId:randomUUID(),provider:o.model.provider,requestKey:callId,inputSeal:sha256(prompt),model:o.model.model,configurationId:configurationDigest,inputCap:o.model.budgetProfile.context_window_tokens-o.model.maxTokens-o.model.budgetProfile.safety_margin_tokens,outputCap:o.model.maxTokens});
   if(skillDegraded)await o.storage.execute('discussion.skillUnavailable',{...attempt,contextId,callId});
   const base=new SqliteDiscussionSkillProtection({storage:o.storage,attempt,contextId,callId,authorize:()=>o.authorize(input.contactId)});
   // Skill 的中间步骤只核任务及修订；候选实际出站和保存各自原子复验完整资料。
   const protection:SkillRunProtection=base;
  // 正常候选由官方目录工具按需读取正文；显式兼容入口仍只预加载指定单包。
  const openSkillRun=o.library&&!skillDegraded?()=>input.selectedPackageId
   ?openSqliteSkillRun(o.library!,{contactId:input.contactId,callId},protection,{selectedPackageId:input.selectedPackageId,signal:input.signal})
   :openSqliteSkillRun(o.library!,{contactId:input.contactId,callId},protection,undefined,input.signal):undefined;
  modelExecutionStarted=true;
  await runSingleDiscussionTurn({runtime:o.runtime,storage:o.storage,attempt,contextId,callId,configurationDigest,prompt,rebuildPrompt:prompt,systemPrompt:candidateSystemPrompt,search:(contextId,kind,query,signal)=>this.search(attempt,contextId,kind,query,signal),model:o.model,provider:o.provider,arbiter:o.arbiter,skillRun:null,openSkillRun,skillProtection:protection,skillRevision:revision,commitAction:'reply.commitCandidates',dispatchAction:'reply.dispatchCall',onPhase:phase=>{observe(phase);o.service.phase(input.contactId,attempt.discussionId,input.requestKey,phase);},onRuntimeAvailable:()=>{this.stage('runtime-available');observe('ready','runtime_ready');},configurationForRevision:revision=>this.digest(attempt.requestId,revision),assertAuthorized:()=>o.authorize(input.contactId),signal:input.signal});
   return {discussionId:attempt.discussionId,replayed:false,segmented:accepted.segmented};
  }catch(error){
   const storageFailure=!modelExecutionStarted&&error instanceof StorageFailure&&error.code==='worker_failed'?o.storage.failureDiagnostic:null;
   const preparationCode=storageFailure?(storageFailure.cause==='action_timeout'?'discussion_preparation_timeout':'discussion_storage_interrupted'):null;
   if(preparationCode)o.service.preparationFailed({contactId:input.contactId,discussionId:attempt.discussionId,requestKey:input.requestKey,startedAt:acceptedAt},preparationCode);
   await o.storage.execute('reply.failPreparation',{...attempt,code:preparationCode??(input.signal?.aborted?'discussion_generation_cancelled':error instanceof StorageFailure?error.code:'discussion_generation_failed')}).catch(()=>{});
   throw preparationCode?new StorageFailure(preparationCode):error;
  }
  finally{o.service.phase(input.contactId,attempt.discussionId,input.requestKey,null);}
 }
}
