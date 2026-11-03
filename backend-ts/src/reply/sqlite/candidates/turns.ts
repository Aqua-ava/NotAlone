import {createHash,randomUUID} from 'node:crypto';
import type {SqliteStorage} from '../../../storage/sqlite/client.ts';
import {StorageFailure} from '../../../storage/sqlite/contracts.ts';
import type {HostReplyModelConfiguration} from '../../../host/host-reply-config.ts';
import type {installModelProvider} from '../../../platform/models/model-provider.ts';
import type {ModelPermitArbiter} from '../../../platform/models/model-permits.ts';
import {SqliteSkillLibrary,skillAnchor} from '../../../skills/sqlite/library.ts';
import {openSqliteSkillRun} from '../../../skills/sqlite/provider.ts';
import type {SkillRunProtection,SkillRunRevision} from '../../../skills/sqlite/contracts.ts';
import type {SqliteDiscussionService} from '../service.ts';
import type {SqliteDiscussionRuntime} from '../runtime.ts';
import type {DiscussionAttempt} from '../contracts.ts';
import {SqliteDiscussionSkillProtection} from '../skill-protection.ts';
import {runSingleDiscussionTurn} from '../generation.ts';
import {encode} from '../requests.ts';
import type {FrozenReplyInput} from './input.ts';
import type {SqliteReplyCandidateService} from './service.ts';
import {readReplyWorkspace,replyWorkspaceEntryText,replyWorkspaceFingerprint,type ReplyWorkspace,type ReplyWorkspaceSnapshot} from './workspace.ts';
const systemPrompt='你是面向用户真实联系人的中文关系沟通回复助手。只围绕本次已确认联系人。依据本次输入和获准资料生成1至3组可编辑候选，不虚构经历、情绪、立场或承诺。事实、推测和未确认候选必须区分。workspace suggest动作只代表用户要可选思路；未提供或未确认的草稿、立场和关系意图保持未知，候选不得写成用户已采纳的主张或承诺。workspace express动作只围绕本次想法组织表达；草稿是用户对助手的任务描述，不一定是要逐句发送的私聊原文。补充背景、写作要求和最近聊天各自标注，不相互冒充。一次性写作要求仅作用本次，不读取或形成长期表达偏好。最终消息始终由用户选择、修改并亲自发送。只输出JSON：{"candidates":[{"parts":["第一条短消息","可选的第二条"],"basis":[实际输入材料编号]}]}。basis只能引用本次编号材料，必须至少一项；不得臆造资料或把Skill选择当作已加载。';
export interface ReplyGenerationInput {contactId:string;discussionId:string;requestKey:string;text:string;confirmedContact:true;acceptIncomplete?:boolean;carriedSelectionId?:string;selectedPackageId?:string;contextMessageIds?:string[];workspace?:ReplyWorkspace;signal?:AbortSignal}
interface Options {storage:SqliteStorage;service:SqliteReplyCandidateService;discussions:SqliteDiscussionService;runtime:SqliteDiscussionRuntime;model:HostReplyModelConfiguration;provider:Pick<ReturnType<typeof installModelProvider>,'beginCall'>;arbiter:ModelPermitArbiter;library?:SqliteSkillLibrary;authorize:(contactId:string)=>Promise<void>}
/** 与11共享实际DSH执行、provider和arbiter；候选不创建第二套调用身份或账本。 */
export class SqliteReplyTurns {
 private readonly options:Options;private stopping=false;private readonly pending=new Set<Promise<unknown>>();private readonly controllers=new Set<AbortController>();
 constructor(options:Options){this.options=options;}
 private digest(requestId:string,revision:SkillRunRevision){return createHash('sha256').update(encode({format:1,systemPrompt,model:this.options.model,revision,requestId})).digest('hex');}
 async configurationFor(contactId:string,discussionId:string):Promise<string|null>{
  const o=this.options,scope={ownerId:o.service.ownerId,contactId,discussionId};
  const read=()=>o.storage.execute<{requestId:string;revision:SkillRunRevision}|null>('reply.configuration',scope);
  const current=await read();if(!current)return null;
  for(const anchor of current.revision.eligible)await o.library?.assertAnchor(anchor);
  const checked=await read();return checked?this.digest(checked.requestId,checked.revision):null;
 }
 generate(input:ReplyGenerationInput){
  if(this.stopping)return Promise.reject(new StorageFailure('reply_runtime_closed'));
  const controller=new AbortController();this.controllers.add(controller);
  const pending=this.generateOwned({...input,signal:input.signal?AbortSignal.any([input.signal,controller.signal]):controller.signal});
  this.pending.add(pending);const release=()=>{this.pending.delete(pending);this.controllers.delete(controller);};pending.then(release,release);return pending;
 }
 async close(){this.stopping=true;for(const c of this.controllers)c.abort();await Promise.allSettled([...this.pending]);}
 private async generateOwned(input:ReplyGenerationInput){
  const o=this.options,ownerId=o.service.ownerId;
  if(input.confirmedContact!==true)throw new StorageFailure('discussion_identity_required');
  const workspace=input.workspace===undefined?undefined:readReplyWorkspace(input.workspace);
  if(workspace&&(input.text!==workspace.draftText||input.contextMessageIds!==undefined||input.carriedSelectionId!==undefined&&(!workspace.includeRelationshipContext||workspace.excludedMessageIds.length>0)))throw new StorageFailure('reply_input_invalid');
  await o.authorize(input.contactId);input.signal?.throwIfAborted();
  const confirmationId=await o.storage.execute<string>('identity.manualConfirm',{ownerId,contactId:input.contactId,contextToken:input.requestKey,id:randomUUID(),at:Date.now()});
  const requestText=workspace?replyWorkspaceEntryText(workspace):input.text;
  const workspaceFingerprint=workspace?replyWorkspaceFingerprint(workspace,input.selectedPackageId,input.carriedSelectionId):undefined;
  const workspaceSnapshot:ReplyWorkspaceSnapshot|undefined=workspace?{...workspace,selectedPackageId:input.selectedPackageId??null,carriedSelectionId:input.carriedSelectionId??null}:undefined;
  const begin=()=>o.service.begin({contactId:input.contactId,discussionId:input.discussionId,requestKey:input.requestKey,text:requestText,acceptIncomplete:input.acceptIncomplete,carriedSelectionId:input.carriedSelectionId,includeRelationshipContext:workspace?workspace.includeRelationshipContext&&workspace.excludedMessageIds.length===0:undefined,workspaceFingerprint,identity:{kind:'manual',confirmationId}});
  const accepted=await begin();
  const attempt=accepted.attempt as DiscussionAttempt;
  if(accepted.replayed)return {discussionId:attempt.discussionId,replayed:true,segmented:false};
  o.service.phase(input.contactId,attempt.discussionId,input.requestKey,'preparing');
  try{
   const callId=randomUUID(),contextId=randomUUID();
   const catalog=o.library?await o.library.refresh(input.signal):await o.storage.execute<any[]>('skills.list',{ownerId});
   const eligible=catalog.filter(p=>p.enabledState==='enabled'&&p.verificationState==='verified'&&p.currentRevisionNo!==null&&(!input.selectedPackageId||p.id===input.selectedPackageId));
   if(input.selectedPackageId&&!eligible.some(p=>p.id===input.selectedPackageId))throw new StorageFailure('discussion_skill_unavailable');
   const revision:SkillRunRevision={packages:catalog.map(p=>({id:p.id,headRevision:p.headRevision})),eligible:o.library?eligible.map(skillAnchor):[]};
   const readItems=async()=>{
    // 候选只使用本次请求的显式消息；旧讨论 entry 兼容槽不参与候选装配，避免把助手讨论正文或来源带入新候选。
    const history=workspace
     ?workspace.includeRelationshipContext?await o.storage.execute<any[]>('discussion.localMessages',{...attempt,limit:50,knownTimeOnly:true}):[]
     :await o.storage.execute<any[]>('discussion.localMessages',{...attempt,limit:20});
    const recentIds=history.filter((m:any)=>!workspace?.excludedMessageIds.includes(m.id)).map((m:any)=>m.id);
    const messageIds=workspace?recentIds:input.contextMessageIds??recentIds;
    const messages=await o.storage.execute<any[]>('discussion.messages',{...attempt,messageIds});
    return messages.map(m=>({kind:'message',sourceContactId:input.contactId,messageId:m.id,recordId:m.record_id,acceptedRevision:m.interpretation_revision}));
   };
   const items=await readItems();
   const frozen=await o.storage.execute<FrozenReplyInput[]>('reply.freezeInput',{...attempt,contextId,skillRun:revision,items,workspace:workspaceSnapshot,queryText:input.text,at:Date.now()});
   const requestIntent=workspace?workspace.action==='suggest'?'本次工作区动作：帮我想想。用户没有提供草稿时尚未确认任何立场，所有说法都只是可选思路。':'本次工作区动作：帮我表达。只按本次想法整理，不添加用户未确认的立场。':'本次明确请求：'+input.text;
   const prompt=requestIntent+'\n\n实际输入材料（编号用于basis）：\n'+frozen.map(item=>`[${item.itemNo}] ${item.kind}\n${item.text}`).join('\n\n');
   // 每次候选任务重建独立副本；旧候选只有显式选择才进入新输入。
   const configurationDigest=this.digest(attempt.requestId,revision);
   await o.storage.execute('discussion.prepareCall',{...attempt,contextId,callId,operationId:randomUUID(),provider:o.model.provider,requestKey:callId,inputSeal:createHash('sha256').update(prompt).digest('hex'),model:o.model.model,configurationId:configurationDigest,inputCap:o.model.budgetProfile.context_window_tokens-o.model.maxTokens-o.model.budgetProfile.safety_margin_tokens,outputCap:o.model.maxTokens});
   const base=new SqliteDiscussionSkillProtection({storage:o.storage,attempt,contextId,callId,authorize:()=>o.authorize(input.contactId)});
   // Skill 的中间步骤只核任务及修订；候选实际出站和保存各自原子复验完整资料。
   const protection:SkillRunProtection=base;
   const openSkillRun=o.library?()=>openSqliteSkillRun(o.library!,{contactId:input.contactId,callId},protection,input.selectedPackageId,input.signal):undefined;
   await runSingleDiscussionTurn({runtime:o.runtime,storage:o.storage,attempt,contextId,callId,configurationDigest,prompt,rebuildPrompt:prompt,systemPrompt,model:o.model,provider:o.provider,arbiter:o.arbiter,skillRun:null,openSkillRun,skillProtection:protection,skillRevision:revision,commitAction:'reply.commitCandidates',dispatchAction:'reply.dispatchCall',onPhase:phase=>o.service.phase(input.contactId,attempt.discussionId,input.requestKey,phase),configurationForRevision:revision=>this.digest(attempt.requestId,revision),assertAuthorized:()=>o.authorize(input.contactId),signal:input.signal});
   return {discussionId:attempt.discussionId,replayed:false,segmented:accepted.segmented};
  }catch(error){await o.storage.execute('reply.failPreparation',{...attempt,code:input.signal?.aborted?'discussion_generation_cancelled':error instanceof StorageFailure?error.code:'discussion_generation_failed'}).catch(()=>{});throw error;}
  finally{o.service.phase(input.contactId,attempt.discussionId,input.requestKey,null);}
 }
}
