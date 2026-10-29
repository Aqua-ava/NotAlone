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
const systemPrompt='你是面向用户真实联系人的中文关系沟通回复助手。只围绕本次已确认联系人。依据用户本次想法和资料生成1至3组可编辑候选，不虚构经历、情绪、立场或承诺。事实、推测和未确认候选必须区分。一次性写作要求仅作用本次，不读取或形成长期表达偏好。最终消息始终由用户选择、修改并亲自发送。只输出JSON：{"candidates":[{"parts":["第一条短消息","可选的第二条"],"basis":[实际输入材料编号]}]}。basis只能引用本次编号材料，必须至少一项；不得臆造资料或把Skill选择当作已加载。';
export interface ReplyGenerationInput {contactId:string;discussionId:string;requestKey:string;text:string;confirmedContact:true;acceptIncomplete?:boolean;carriedSelectionId?:string;selectedPackageId?:string;contextMessageIds?:string[];signal?:AbortSignal}
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
  await o.authorize(input.contactId);input.signal?.throwIfAborted();
  const confirmationId=await o.storage.execute<string>('identity.manualConfirm',{ownerId,contactId:input.contactId,contextToken:input.requestKey,id:randomUUID(),at:Date.now()});
  const accepted=await o.service.begin({...input,identity:{kind:'manual',confirmationId}}),attempt=accepted.attempt as DiscussionAttempt;
  if(accepted.replayed)return {discussionId:attempt.discussionId,replayed:true,segmented:false};
  try{
   const callId=randomUUID(),contextId=randomUUID();
   const catalog=o.library?await o.library.list():await o.storage.execute<any[]>('skills.list',{ownerId});
   const eligible=catalog.filter(p=>p.enabledState==='enabled'&&p.verificationState==='verified'&&p.currentRevisionNo!==null&&(!input.selectedPackageId||p.id===input.selectedPackageId));
   if(input.selectedPackageId&&!eligible.some(p=>p.id===input.selectedPackageId))throw new StorageFailure('discussion_skill_unavailable');
   const revision:SkillRunRevision={packages:catalog.map(p=>({id:p.id,headRevision:p.headRevision})),eligible:o.library?eligible.map(skillAnchor):[]};
   const view=await o.discussions.view(input.contactId,attempt.discussionId),entries=view.entries.filter((e:any)=>e.content_state==='available');
   const history=await o.storage.execute<any>('history.read',{ownerId,contactId:input.contactId,limit:20});
   const messageIds=input.contextMessageIds??history.messages.filter((m:any)=>m.kind==='text').map((m:any)=>m.id);
   const messages=await o.storage.execute<any[]>('discussion.messages',{...attempt,messageIds});
   const frozen=await o.storage.execute<FrozenReplyInput[]>('reply.freezeInput',{...attempt,contextId,skillRun:revision,items:[...messages.map(m=>({kind:'message',sourceContactId:input.contactId,messageId:m.id,recordId:m.record_id,acceptedRevision:m.interpretation_revision})),...entries.map((e:any)=>({kind:'entry',entryId:e.id}))],at:Date.now()});
   const prompt='本次明确请求：'+input.text+'\n\n实际输入材料（编号用于basis）：\n'+frozen.map(item=>`[${item.itemNo}] ${item.kind}\n${item.text}`).join('\n\n');
   // 每次候选任务重建独立副本；旧候选只有显式选择才进入新输入。
   const configurationDigest=this.digest(attempt.requestId,revision);
   await o.storage.execute('discussion.prepareCall',{...attempt,contextId,callId,operationId:randomUUID(),provider:o.model.provider,requestKey:callId,inputSeal:createHash('sha256').update(prompt).digest('hex'),model:o.model.model,configurationId:configurationDigest,inputCap:o.model.budgetProfile.context_window_tokens-o.model.maxTokens-o.model.budgetProfile.safety_margin_tokens,outputCap:o.model.maxTokens});
   const base=new SqliteDiscussionSkillProtection({storage:o.storage,attempt,contextId,callId,authorize:()=>o.authorize(input.contactId)});
   const assertInput=()=>o.storage.execute('reply.assertInput',{...attempt,contextId});
   const protection:SkillRunProtection={
    async assertCurrent(scope,runRevision,signal){await base.assertCurrent(scope,runRevision,signal);await assertInput();signal?.throwIfAborted();},
    async recordSelection(scope,selected,signal){await assertInput();await base.recordSelection(scope,selected,signal);},
    async recordInput(value,signal){await assertInput();await base.recordInput(value,signal);},
   };
   const skillRun=o.library?await openSqliteSkillRun(o.library,{contactId:input.contactId,callId},protection,input.selectedPackageId,input.signal):null;
   await runSingleDiscussionTurn({runtime:o.runtime,storage:o.storage,attempt,contextId,callId,configurationDigest,prompt,rebuildPrompt:prompt,systemPrompt,model:o.model,provider:o.provider,arbiter:o.arbiter,skillRun,skillProtection:protection,skillRevision:revision,commitAction:'reply.commitCandidates',signal:input.signal});
   return {discussionId:attempt.discussionId,replayed:false,segmented:accepted.segmented};
  }catch(error){await o.storage.execute('discussion.cancel',{...attempt,at:Date.now()}).catch(()=>{});throw error;}
 }
}
