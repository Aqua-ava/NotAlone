import {randomUUID} from 'node:crypto';
import {sha256} from '../../platform/sha256.ts';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {SqliteSkillLibrary,skillAnchor} from '../../skills/sqlite/library.ts';
import {openSqliteSkillRun} from '../../skills/sqlite/provider.ts';
import {inSkillGroup,skillRunGroup} from '../../skills/sqlite/groups.ts';
import type {SkillRunRevision} from '../../skills/sqlite/contracts.ts';
import type {HostReplyModelConfiguration} from '../../host/host-reply-config.ts';
import type {installModelProvider} from '../../platform/models/model-provider.ts';
import type {ModelPermitArbiter} from '../../platform/models/model-permits.ts';
import {SqliteDiscussionService} from './service.ts';
import {OwnedWork} from './owned-work.ts';
import type {SqliteDiscussionRuntime} from './runtime.ts';
import {SqliteDiscussionSkillProtection} from './skill-protection.ts';
import {runSingleDiscussionTurn} from './generation.ts';
import {encode} from './requests.ts';
import type {DiscussionAttempt} from './contracts.ts';
const systemPrompt='你是中文关系沟通讨论助手。本次只围绕用户已确认的一位联系人讨论。区分用户想法、已有事实和推测；帮助澄清表达，不虚构经历、情绪或承诺。你不会发送任何外部消息，最终消息由用户本人选择、修改并亲自发送。历史助手发言不是联系人事实，一次性要求不自动成为长期偏好。';
/** 正常业务协调：实际请求、冻结来源、官方运行与SQLite提交分别有独立边界。 */
export class SqliteDiscussionTurns {
 private readonly work=new OwnedWork();
 private readonly storage:SqliteStorage;private readonly discussions:SqliteDiscussionService;private readonly runtime:SqliteDiscussionRuntime;private readonly model:HostReplyModelConfiguration;private readonly provider:Pick<ReturnType<typeof installModelProvider>,'beginCall'>;private readonly arbiter:ModelPermitArbiter;private readonly library?:SqliteSkillLibrary;private readonly authorize:(contactId:string)=>Promise<void>;
 constructor(options:{storage:SqliteStorage;discussions:SqliteDiscussionService;runtime:SqliteDiscussionRuntime;model:HostReplyModelConfiguration;provider:Pick<ReturnType<typeof installModelProvider>,'beginCall'>;arbiter:ModelPermitArbiter;library?:SqliteSkillLibrary;authorize:(contactId:string)=>Promise<void>}){this.storage=options.storage;this.discussions=options.discussions;this.runtime=options.runtime;this.model=options.model;this.provider=options.provider;this.arbiter=options.arbiter;this.library=options.library;this.authorize=options.authorize;}
 private digest(revision:SkillRunRevision):string{return sha256(encode({format:1,systemPrompt,model:this.model,revision}));}
 generate(input:{contactId:string;discussionId:string;requestKey:string;text:string;confirmedContact:true;contextMessageIds?:string[];signal?:AbortSignal}){
  if(this.work.closed)return Promise.reject(new StorageFailure('discussion_runtime_closed'));
  return this.work.run(input.signal,signal=>this.generateOwned({...input,signal}));
 }
 close():Promise<void>{return this.work.close();}
 private async generateOwned(input:{contactId:string;discussionId:string;requestKey:string;text:string;confirmedContact:true;contextMessageIds?:string[];signal?:AbortSignal}){
  if(Object.hasOwn(input,'selectedPackageId'))throw new StorageFailure('discussion_input_invalid');
  if(input.confirmedContact!==true)throw new StorageFailure('discussion_identity_required');
  input.signal?.throwIfAborted();await this.authorize(input.contactId);
  // 具名请求是用户明确点击产生；不同于打开App、回看或后台消息事件。
  const ownerId=this.discussions.ownerId;
  const confirmationId=await this.storage.execute<string>('identity.manualConfirm',{ownerId,contactId:input.contactId,contextToken:input.requestKey,id:randomUUID(),at:Date.now()});
  input.signal?.throwIfAborted();
  const accepted=await this.discussions.begin(input.contactId,input.requestKey,input.text,{kind:'manual',confirmationId},input.discussionId);
  const attempt=accepted.attempt as DiscussionAttempt;
  if(accepted.replayed)return {replayed:true,discussionId:attempt.discussionId,segmented:false};
  try{
  const callId=randomUUID(),contextId=randomUUID();
  const catalog=this.library?await this.library.refresh(input.signal):await this.storage.execute<any[]>('skills.list',{ownerId});
  // 只有联系人所在分组绑定的 Skill 才可用；未分组联系人没有任何可用 Skill。
  const group=this.library?await this.library.groupScope(input.contactId,input.signal):null;
  const eligible=inSkillGroup(catalog.filter(p=>p.enabledState==='enabled'&&p.verificationState==='verified'&&p.currentRevisionNo!==null),group??{groupId:null,revision:0n,packageIds:[]});
  const revision:SkillRunRevision={packages:catalog.map(p=>({id:p.id,headRevision:p.headRevision})),eligible:this.library?eligible.map(skillAnchor):[],...(group?{group:skillRunGroup(input.contactId,group)}:{})};
  const view=await this.discussions.view(input.contactId,attempt.discussionId);
  const entries=view.entries.filter((e:any)=>e.content_state==='available');
  const messages=await this.storage.execute<any[]>('discussion.messages',{...attempt,messageIds:input.contextMessageIds??[]});
  await this.storage.execute('discussion.freezeContext',{...attempt,contextId,skillRun:revision,items:[...messages.map(m=>({kind:'message',sourceContactId:input.contactId,messageId:m.id,recordId:m.record_id,acceptedRevision:m.interpretation_revision})),...entries.map((e:any)=>({kind:'entry',entryId:e.id}))],at:Date.now()});
  const inputSeal=sha256(encode({contextId,text:input.text,model:this.model,revision}));
  const configurationDigest=this.digest(revision);
  await this.storage.execute('discussion.prepareCall',{...attempt,contextId,callId,operationId:randomUUID(),provider:this.model.provider,requestKey:callId,inputSeal,
   model:this.model.model,configurationId:configurationDigest,inputCap:this.model.budgetProfile.context_window_tokens-this.model.maxTokens-this.model.budgetProfile.safety_margin_tokens,outputCap:this.model.maxTokens});
  const protection=new SqliteDiscussionSkillProtection({storage:this.storage,attempt,contextId,callId,authorize:()=>this.authorize(input.contactId)});
  const openSkillRun=this.library?()=>openSqliteSkillRun(this.library!,{contactId:input.contactId,callId},protection,input.signal):undefined;
  const background=messages.length?'本次明确引用的聊天资料：\n'+messages.map(m=>`${m.sender_role==='owner'?'我':'对方'}：${m.text_body}`).join('\n')+'\n\n':'';
  const rebuilt=background+entries.map((e:any)=>`${e.role==='user'?'用户':'助手'}：${e.body}`).join('\n\n');
  await runSingleDiscussionTurn({kind:'discussion',runtime:this.runtime,storage:this.storage,attempt,contextId,callId,configurationDigest,prompt:background+input.text,rebuildPrompt:rebuilt,systemPrompt,model:this.model,provider:this.provider,arbiter:this.arbiter,openSkillRun,skillProtection:protection,skillRevision:revision,configurationForRevision:revision=>this.digest(revision),assertAuthorized:()=>this.authorize(input.contactId),signal:input.signal});
  return {replayed:false,discussionId:attempt.discussionId,segmented:accepted.segmented};
  }catch(error){
   await this.storage.execute('discussion.cancel',{...attempt,at:Date.now()}).catch(()=>{});
   throw error;
  }
 }
}
