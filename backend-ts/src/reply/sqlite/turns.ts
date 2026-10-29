import {createHash,randomUUID} from 'node:crypto';
import type {SqliteStorage} from '../../storage/sqlite/client.ts';
import {StorageFailure} from '../../storage/sqlite/contracts.ts';
import {SqliteSkillLibrary,skillAnchor} from '../../skills/sqlite/library.ts';
import {openSqliteSkillRun} from '../../skills/sqlite/provider.ts';
import type {SkillRunRevision} from '../../skills/sqlite/contracts.ts';
import type {HostReplyModelConfiguration} from '../../host/host-reply-config.ts';
import type {installModelProvider} from '../../platform/models/model-provider.ts';
import type {ModelPermitArbiter} from '../../platform/models/model-permits.ts';
import {SqliteDiscussionService} from './service.ts';
import type {SqliteDiscussionRuntime} from './runtime.ts';
import {SqliteDiscussionSkillProtection} from './skill-protection.ts';
import {runSingleDiscussionTurn} from './generation.ts';
import {encode} from './requests.ts';
import type {DiscussionAttempt} from './contracts.ts';
const systemPrompt='你是中文关系沟通讨论助手。本次只围绕用户已确认的一位联系人讨论。区分用户想法、已有事实和推测；帮助澄清表达，不虚构经历、情绪或承诺。你不会发送任何外部消息，最终消息由用户本人选择、修改并亲自发送。历史助手发言不是联系人事实，一次性要求不自动成为长期偏好。';
/** 正常业务协调：实际请求、冻结来源、官方运行与SQLite提交分别有独立边界。 */
export class SqliteDiscussionTurns {
 private stopping=false;private readonly pending=new Set<Promise<unknown>>();private readonly controllers=new Set<AbortController>();private closing?:Promise<void>;
 private readonly storage:SqliteStorage;private readonly discussions:SqliteDiscussionService;private readonly runtime:SqliteDiscussionRuntime;private readonly model:HostReplyModelConfiguration;private readonly provider:Pick<ReturnType<typeof installModelProvider>,'beginCall'>;private readonly arbiter:ModelPermitArbiter;private readonly library?:SqliteSkillLibrary;private readonly authorize:(contactId:string)=>Promise<void>;
 constructor(options:{storage:SqliteStorage;discussions:SqliteDiscussionService;runtime:SqliteDiscussionRuntime;model:HostReplyModelConfiguration;provider:Pick<ReturnType<typeof installModelProvider>,'beginCall'>;arbiter:ModelPermitArbiter;library?:SqliteSkillLibrary;authorize:(contactId:string)=>Promise<void>}){this.storage=options.storage;this.discussions=options.discussions;this.runtime=options.runtime;this.model=options.model;this.provider=options.provider;this.arbiter=options.arbiter;this.library=options.library;this.authorize=options.authorize;}
 private digest(revision:SkillRunRevision):string{return createHash('sha256').update(encode({format:1,systemPrompt,model:this.model,revision})).digest('hex');}
 async configurationFor(contactId:string,discussionId:string):Promise<string>{
  const view=await this.discussions.view(contactId,discussionId),last=[...view.entries].reverse().find((e:any)=>e.role==='assistant'&&e.content_state==='available');
  let selected:string|undefined;
  if(last){const trace=await this.discussions.trace(contactId,discussionId,last.origin_request_id);const selection=trace.events.find((e:any)=>e.kind==='skill_selection');if(selection)selected=JSON.parse(selection.payload).selected?.packageId;}
  const catalog=this.library?await this.library.list():await this.storage.execute<any[]>('skills.list',{ownerId:this.discussions.ownerId});
  const eligible=this.library?catalog.filter(p=>p.enabledState==='enabled'&&p.verificationState==='verified'&&p.currentRevisionNo!==null&&(!selected||p.id===selected)).map(skillAnchor):[];
  for(const anchor of eligible)await this.library!.assertAnchor(anchor);
  return this.digest({packages:catalog.map(p=>({id:p.id,headRevision:p.headRevision})),eligible});
 }
 generate(input:{contactId:string;discussionId:string;requestKey:string;text:string;confirmedContact:true;selectedPackageId?:string;contextMessageIds?:string[];signal?:AbortSignal}){
  if(this.stopping)return Promise.reject(new StorageFailure('discussion_runtime_closed'));
  const controller=new AbortController();this.controllers.add(controller);
  const pending=this.generateOwned({...input,signal:input.signal?AbortSignal.any([controller.signal,input.signal]):controller.signal});
  this.pending.add(pending);const release=()=>{this.pending.delete(pending);this.controllers.delete(controller);};pending.then(release,release);return pending;
 }
 close():Promise<void>{
  this.stopping=true;for(const controller of this.controllers)controller.abort();
  return this.closing??=Promise.allSettled([...this.pending]).then(()=>{});
 }
 private async generateOwned(input:{contactId:string;discussionId:string;requestKey:string;text:string;confirmedContact:true;selectedPackageId?:string;contextMessageIds?:string[];signal?:AbortSignal}){
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
  const catalog=this.library?await this.library.list():await this.storage.execute<any[]>('skills.list',{ownerId});
  const eligible=catalog.filter(p=>p.enabledState==='enabled'&&p.verificationState==='verified'&&p.currentRevisionNo!==null&&(!input.selectedPackageId||p.id===input.selectedPackageId));
  if(input.selectedPackageId&&!eligible.some(p=>p.id===input.selectedPackageId))throw new StorageFailure('discussion_skill_unavailable');
  const revision:SkillRunRevision={packages:catalog.map(p=>({id:p.id,headRevision:p.headRevision})),eligible:this.library?eligible.map(skillAnchor):[]};
  const view=await this.discussions.view(input.contactId,attempt.discussionId);
  const entries=view.entries.filter((e:any)=>e.content_state==='available');
  const messages=await this.storage.execute<any[]>('discussion.messages',{...attempt,messageIds:input.contextMessageIds??[]});
  await this.storage.execute('discussion.freezeContext',{...attempt,contextId,skillRun:revision,items:[...messages.map(m=>({kind:'message',sourceContactId:input.contactId,messageId:m.id,recordId:m.record_id,acceptedRevision:m.interpretation_revision})),...entries.map((e:any)=>({kind:'entry',entryId:e.id}))],at:Date.now()});
  const inputSeal=createHash('sha256').update(encode({contextId,text:input.text,model:this.model,revision})).digest('hex');
  const configurationDigest=this.digest(revision);
  await this.storage.execute('discussion.prepareCall',{...attempt,contextId,callId,operationId:randomUUID(),provider:this.model.provider,requestKey:callId,inputSeal,
   model:this.model.model,configurationId:configurationDigest,inputCap:this.model.budgetProfile.context_window_tokens-this.model.maxTokens-this.model.budgetProfile.safety_margin_tokens,outputCap:this.model.maxTokens});
  const protection=new SqliteDiscussionSkillProtection({storage:this.storage,attempt,contextId,callId,authorize:()=>this.authorize(input.contactId)});
  const skillRun=this.library?await openSqliteSkillRun(this.library,{contactId:input.contactId,callId},protection,input.selectedPackageId,input.signal):null;
  const background=messages.length?'本次明确引用的聊天资料：\n'+messages.map(m=>`${m.sender_role==='owner'?'我':'对方'}：${m.text_body}`).join('\n')+'\n\n':'';
  const rebuilt=background+entries.map((e:any)=>`${e.role==='user'?'用户':'助手'}：${e.body}`).join('\n\n');
  await runSingleDiscussionTurn({runtime:this.runtime,storage:this.storage,attempt,contextId,callId,configurationDigest,prompt:background+input.text,rebuildPrompt:rebuilt,systemPrompt,model:this.model,provider:this.provider,arbiter:this.arbiter,skillRun,skillProtection:protection,skillRevision:revision,signal:input.signal});
  return {replayed:false,discussionId:attempt.discussionId,segmented:accepted.segmented};
  }catch(error){
   await this.storage.execute('discussion.cancel',{...attempt,at:Date.now()}).catch(()=>{});
   throw error;
  }
 }
}
