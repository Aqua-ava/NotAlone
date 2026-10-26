/** B探索的唯一业务责任方；A候选执行暂由既有讨论端口承接。 */
import {isDeepStrictEqual} from 'node:util';
import {ReplyError} from '../generation/reply-contract.ts';
import {PostgresExplorationStore} from './exploration-store.ts';
import {ExplorationEvidence} from './exploration-evidence.ts';
import {ExplorationError,ExplorationStale,hasConfirmedIntent,parseExplorationInput,type ExplorationScope,type ExplorationInput,type ExplorationTask,type ExplorationOpen,type EvidenceSnapshot} from './exploration-contract.ts';
import {createExplorationRuntime,type ExplorationRuntimeContext} from './exploration-runtime.ts';
import {PostgresSkillPort,SkillPortError} from '../../skills/skill-port.ts';
import type {SkillEntry,SkillScope} from '../../skills/skill-runtime.ts';
import type {ReplyServiceOptions} from '../generation/reply-service.ts';
import {ModelInputBudgetError} from '../../platform/models/model-input-budget.ts';
import {createExplorationSkillSourceValidator} from './exploration-skill-sources.ts';
interface Selection {catalog:{scope:ExplorationScope;revision:number;entries:{version_id:string;name:string;description:string;version_number:number}[]};entry:{version_id:string;name:string;version_number:number}|null;model_payload:Record<string,unknown>|null;validate():Promise<void>;dispose():void}
function content(value:Record<string,any>):ExplorationInput{return parseExplorationInput({correction:'',requirements:'',answer:'',confirmed_intent:'',skill_mode:'auto',skill_version_id:null,...value});}
function snapshots(task:ExplorationTask):EvidenceSnapshot[]{const map=new Map<string,EvidenceSnapshot>();for(const item of [...task.intent_snapshots,...task.snapshots]){if(map.has(item.evidence_id)&&!isDeepStrictEqual(map.get(item.evidence_id),item))throw new ExplorationStale();map.set(item.evidence_id,item);}if(map.size>14)throw new ExplorationStale();return [...map.values()];}
const clearIntent=(task:ExplorationTask)=>hasConfirmedIntent(task)&&!!task.result&&!task.result.question&&!task.result.ambiguities.length;
export class ExplorationService {
 private readonly options:ReplyServiceOptions;private readonly evidence=new ExplorationEvidence();
 private readonly store:PostgresExplorationStore;private readonly runtime:ReturnType<typeof createExplorationRuntime>;
 constructor(options:ReplyServiceOptions,manualInput=false){
  this.options=options;this.runtime=createExplorationRuntime({...options,model:{...options.model,physical_limit:2,deadline_ms:8000}});
  this.store=new PostgresExplorationStore({transaction:options.transaction,evidence:this.evidence,skills_root:options.skillsRoot,guards:{active_binding:async(client,scope)=>{
   if(!(await client.query('SELECT 1 FROM contact WHERE owner_id=$1 AND id=$2',[scope.owner_id,scope.contact_id])).rowCount)throw new ExplorationStale();
   const rows=(await client.query(manualInput?'SELECT id FROM manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2 FOR SHARE':"SELECT id FROM conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND status='active' FOR SHARE",[scope.owner_id,scope.contact_id])).rows;
   if(rows.length!==1)throw new ExplorationStale();return rows[0].id;
  },require_skill:async(client,scope,revision,id,scene)=>{
   const port=new PostgresSkillPort({read:fn=>fn(client)},options.skillsRoot,{requireDiscussionDependencies:createExplorationSkillSourceValidator(options.skillsRoot)});
   try{const skScope={ownerId:scope.owner_id,contactId:scope.contact_id,scene:scene??''},catalog=await port.catalog(skScope);if(catalog.revision!==String(revision))throw new ExplorationStale();const entry=id?catalog.entries.find(e=>e.versionId===id):null;if(id&&!entry)throw new ExplorationStale();if(entry)await port.loadVersion(skScope,entry,catalog.revision);await port.validate(skScope,catalog.revision,entry??null);}finally{port.dispose();}
  }}});
 }
 private async selection(scope:ExplorationScope,input:ExplorationInput,signal:AbortSignal):Promise<Selection>{
  const port=new PostgresSkillPort({read:this.options.transaction},this.options.skillsRoot,{requireDiscussionDependencies:createExplorationSkillSourceValidator(this.options.skillsRoot)}),skScope:SkillScope={ownerId:scope.owner_id,contactId:scope.contact_id,scene:input.skill_scene??''};
  try{
   const catalog=await port.catalog(skScope,signal);let entry:SkillEntry|null=null;
   if(input.skill_mode==='user'){entry=catalog.entries.find(e=>e.versionId===input.skill_version_id)??null;if(!entry)throw new ExplorationStale();}
   const ids=catalog.entries.map(e=>e.versionId),numbers=ids.length?await this.options.transaction(async c=>(await c.query('SELECT id,version_number FROM reply_skill_version WHERE id=ANY($1::uuid[])',[ids])).rows):[];
   const projected=catalog.entries.map(e=>({version_id:e.versionId,name:e.name,description:e.description,version_number:Number(numbers.find(n=>n.id===e.versionId)?.version_number)}));
   let model_payload:Record<string,unknown>|null=null;
   if(entry){const loaded=await port.loadVersion(skScope,entry,catalog.revision,signal);model_payload={version_id:entry.versionId,name:entry.name,content:loaded.content};}
   await port.validate(skScope,catalog.revision,entry,signal);
   return {catalog:{scope,revision:Number(catalog.revision),entries:projected},entry:entry?projected.find(e=>e.version_id===entry!.versionId)!:null,model_payload,validate:()=>port.validate(skScope,catalog.revision,entry,signal),dispose:()=>port.dispose()};
  }catch(error){port.dispose();throw error;}
 }
 private pinned(scope:ExplorationScope,task:ExplorationTask,signal:AbortSignal){return this.selection(scope,{...task.content,skill_mode:task.skill_version_id?'user':'disabled',skill_version_id:task.skill_version_id},signal);}
 private async validate(scope:ExplorationScope,task:ExplorationTask,signal:AbortSignal,checkSkill=true){
  signal.throwIfAborted();if(!isDeepStrictEqual(scope,task.scope))throw new ExplorationStale();
  await this.options.transaction(c=>this.evidence.validate(c,scope,snapshots(task)));
  if(checkSkill){const selected=await this.pinned(scope,task,signal);try{if(selected.catalog.revision!==task.skill_library_revision)throw new ExplorationStale();await selected.validate();}finally{selected.dispose();}}
 }
 private public(task:ExplorationTask):Record<string,any>{
  if(!task.result||!['ready','selected','confirmed'].includes(task.state))throw new ExplorationError();
  return {...task.result,kind:task.result.question?'clarification':'directions',session_id:task.session_id,exploration_id:task.exploration_id,input_version_id:task.input_version_id,skill_version_id:task.skill_version_id,skill_library_revision:task.skill_library_revision,confirmed_intent:hasConfirmedIntent(task)?task.selected_intent:null};
 }
 private async requireSession(scope:ExplorationScope,session:string,id:string){const task=await this.store.read(scope,id,'history');if(task.session_id!==session)throw new ExplorationStale();return task;}
 private async open(scope:ExplorationScope,request:ExplorationOpen,signal:AbortSignal):Promise<Record<string,any>>{
  const replay=await this.store.replay(scope,request);
  if(replay){await this.validate(scope,replay,signal);if(replay.state==='failed'){if(request.automatic)throw new ExplorationError();const selected=await this.pinned(scope,replay,signal);try{return await this.run(await this.store.retry(replay),selected,request.previous_id?await this.store.read(scope,request.previous_id,'history'):null,!!request.change_group,signal);}finally{selected.dispose();}}return this.public(replay);}
  const previous=request.previous_id?await this.store.read(scope,request.previous_id,request.automatic?'current':'continue'):null;
  let input=request.content;
  if(previous){
   if(previous.state==='paused')throw new ExplorationStale();await this.validate(scope,previous,signal,!!request.automatic);
   if(previous.session_id!==request.session_id||previous.content.type!==input.type||previous.content.target_message_id!==input.target_message_id||previous.content.purpose_hint!==input.purpose_hint)throw new ExplorationStale();
   input={...input,confirmed_intent:hasConfirmedIntent(previous)?previous.selected_intent??'':''};
  }
  if(request.automatic&&(!previous||previous.state!=='ready'||hasConfirmedIntent(previous)))throw new ExplorationStale();
  if(request.automatic&&previous!.automatic_call_count>=3)throw new ExplorationError();
  const selected=await this.selection(scope,input,signal);
  try{
   const captured=await this.options.transaction(c=>this.evidence.capture(c,scope,input));
   if(previous&&hasConfirmedIntent(previous))await this.options.transaction(c=>this.evidence.validate(c,scope,previous.intent_snapshots));
   signal.throwIfAborted();const task=await this.store.begin({scope,request:{...request,content:input},snapshots:captured,skill:selected,previous});
   return await this.run(task,selected,previous,!!request.change_group,signal);
  }finally{selected.dispose();}
 }
 private async run(initial:ExplorationTask,initialSelection:Selection,previous:ExplorationTask|null,changeGroup:boolean,signal:AbortSignal){
  let task=initial,selected=initialSelection,owned:Selection|undefined;
  const requireCurrent=async()=>{signal.throwIfAborted();const current=await this.store.read(task.scope,task.exploration_id);if(!isDeepStrictEqual(current,task)||current.state!=='running')throw new ExplorationStale();await this.validate(task.scope,task,signal);};
  const context=():ExplorationRuntimeContext=>({owner_id:task.scope.owner_id,contact_id:task.scope.contact_id,request_id:task.exploration_id,input:task.content as unknown as Record<string,unknown>,evidence:task.snapshots.map(({fingerprint,manual_contact,...item})=>item) as unknown as ExplorationRuntimeContext['evidence'],skill:selected.model_payload,previous_intents:changeGroup&&previous?.result&&previous.skill_library_revision===selected.catalog.revision&&previous.skill_version_id===(selected.entry?.version_id??null)?previous.result.options.map(o=>o.intent):[]});
  try{
   if(!task.skill_selection_complete){
    await requireCurrent();const version=await this.runtime.selectSkill(context(),{...task.scope,entries:selected.catalog.entries},{requireCurrent,validateSkill:()=>selected.validate()},signal);
    if(version!==null&&!selected.catalog.entries.some(e=>e.version_id===version))throw new ExplorationError();
    task=await this.store.pin_skill(task,version);owned=await this.pinned(task.scope,task,signal);selected=owned;
   }
   await requireCurrent();const result=await this.runtime.explore(context(),{requireCurrent,validateSkill:()=>selected.validate()},signal);
   await this.validate(task.scope,task,signal);await selected.validate();signal.throwIfAborted();
   const decorated={...result,evidence:task.snapshots.map(({fingerprint,manual_contact,...item})=>item),used_skill:selected.entry?{...selected.entry,selection_method:task.content.skill_mode==='auto'?'auto':'user'}:null,skill_choices:selected.catalog.entries.map(({description,...entry})=>entry)};
   return this.public(await this.store.complete(task,decorated));
  }catch(error){await this.store.fail(task);throw error;}finally{owned?.dispose();}
 }
 private generation(task:ExplorationTask){if(!clearIntent(task)||!['selected','confirmed'].includes(task.state))throw new ExplorationStale();return {kind:'generation_command',exploration_id:task.exploration_id,input_version_id:task.input_version_id,request_key:task.request_key,confirmed_intent:task.selected_intent};}
 private async confirm(scope:ExplorationScope,session:string,r:Record<string,any>,signal:AbortSignal){
  const choice={suggestion_id:r.suggestion_id??null,direct_intent:r.direct_intent==null?null:r.direct_intent.trim()};
  if(!r.selection_only){const completed=await this.store.replay_confirmation(scope,session,r.exploration_id,r.input_version_id,choice);if(completed)return {kind:'replay_command',exploration_id:completed.exploration_id};}
  await this.requireSession(scope,session,r.exploration_id);let task=await this.store.read(scope,r.exploration_id);await this.validate(scope,task,signal);
  task=await this.store.select(scope,r.exploration_id,r.input_version_id,choice);
  if(task.state==='paused')return {kind:'paused',exploration_id:task.exploration_id,input_version_id:task.input_version_id,confirmed_intent:task.selected_intent};
  return r.selection_only||!clearIntent(task)?this.public(task):this.generation(task);
 }
 private async answer(scope:ExplorationScope,session:string,r:Record<string,any>,signal:AbortSignal){
  if(typeof r.answer!=='string'||!r.answer.trim()||Array.from(r.answer.trim()).length>4096)throw new ExplorationError();
  if(!r.selection_only){const completed=await this.store.replay_answer(scope,session,r.exploration_id,r.input_version_id,{question_id:r.question_id,answer:r.answer,operation_key:r.operation_key});if(completed)return {kind:'replay_command',exploration_id:completed.exploration_id};}
  const task=await this.requireSession(scope,session,r.exploration_id);if(task.state==='paused')throw new ExplorationStale();await this.validate(scope,task,signal);
  if(task.input_version_id!==r.input_version_id||!task.result||task.result.question_id!==r.question_id)throw new ExplorationStale();
  const result=await this.open(scope,{session_id:session,content:{...task.content,answer:r.answer.trim(),confirmed_intent:hasConfirmedIntent(task)?task.selected_intent??'':''},operation_key:r.operation_key,expected_input_version_id:r.input_version_id,previous_id:task.exploration_id,question_id:r.question_id},signal);
  const next=await this.store.read(scope,result.exploration_id);return !r.selection_only&&hasConfirmedIntent(task)&&clearIntent(next)?this.generation(next):result;
 }
 async execute(scope:ExplorationScope,session:string|undefined,action:string,r:Record<string,any>,signal:AbortSignal,internal?:{manual_input:boolean}):Promise<unknown>{
  // 请求来历由认证桥传入；不能从库中是否存在manual记录反推本次授权。
  return new ExplorationService(this.options,internal?.manual_input??false).dispatch(scope,session,action,r,signal);
 }
 private async dispatch(scope:ExplorationScope,session:string|undefined,action:string,r:Record<string,any>,signal:AbortSignal):Promise<unknown>{
  try{
   signal.throwIfAborted();
   if(action==='open'){const c=content(r.content);if(c.answer||c.confirmed_intent)throw new ExplorationError();return await this.open(scope,{session_id:session!,content:c,operation_key:r.operation_key,expected_input_version_id:r.expected_input_version_id,previous_id:r.previous_id,automatic:r.automatic??false,change_group:r.change_group??false},signal);}
   if(action==='read'){const task=await this.store.read(scope,r.exploration_id);if(session&&task.session_id!==session)throw new ExplorationStale();await this.validate(scope,task,signal);return this.public(task);}
   if(action==='require_session'){await this.requireSession(scope,session!,r.exploration_id);return {kind:'belongs_to_session'};}
   if(action==='confirm')return await this.confirm(scope,session!,r,signal);
   if(action==='answer')return await this.answer(scope,session!,r,signal);
   if(action==='stop'){await this.requireSession(scope,session!,r.exploration_id);await this.store.stop(scope,r.exploration_id,r.input_version_id);return {kind:'paused',exploration_id:r.exploration_id,input_version_id:r.input_version_id};}
   if(action==='finish'){const task=await this.requireSession(scope,session!,r.exploration_id);if(task.input_version_id!==r.input_version_id||task.request_key!==r.request_key)throw new ExplorationStale();await this.store.finish(task);return {kind:'confirmed'};}
   if(action==='reconfirm'){
    const parent=await this.requireSession(scope,session!,r.exploration_id);await this.validate(scope,parent,signal);
    const task=await this.store.reconfirm(scope,session!,r.exploration_id,r.input_version_id,{expected_input_version_id:r.expected_input_version_id,request_key:r.request_key,suggestion_id:r.suggestion_id??null,direct_intent:r.direct_intent==null?null:r.direct_intent.trim()});
    if(!task.selection_id||!task.selection_source)throw new ExplorationStale();return {kind:'confirmed',session_id:session,exploration_id:task.exploration_id,input_version_id:task.input_version_id,request_key:task.request_key,suggestion_id:task.selection_id,direction_source:task.selection_source,skill_version_id:task.skill_version_id,skill_library_revision:task.skill_library_revision};
   }
   throw new ReplyError('exploration_request_invalid',400);
  }catch(error){
   if(error instanceof ModelInputBudgetError){
    const b=error.receipt,model=this.options.model,total=b?b.input_tokens+b.maxTokens+b.safety_margin_tokens:null;
    throw Object.assign(new ReplyError(error.code==='reply_budget_exceeded'?'input_budget_exceeded':'input_budget_unavailable',409),{input_budget:{state:b?'exceeded':'unavailable',allowed:false,model_id:model.model,context_window_tokens:b?.context_window_tokens??model.budgetProfile.context_window_tokens,input_tokens:b?.input_tokens??null,output_reserve_tokens:b?.maxTokens??model.maxTokens,total_tokens:total,measurement_kind:b?.measurement_kind??null,measurement_id:b?.measurement_id??null,reason:b?'context_window_exceeded':'measurement_unavailable',safety_margin_tokens:b?.safety_margin_tokens??model.budgetProfile.safety_margin_tokens}});
   }
   if(error instanceof ExplorationError||error instanceof SkillPortError||error instanceof ReplyError&&['exploration_output_invalid','exploration_timeout','exploration_tool_forbidden','exploration_inactive','exploration_budget_unavailable','exploration_skill_scope_invalid','reply_budget_exceeded'].includes(error.code))throw new ReplyError('exploration_rejected',409);throw error;
  }
 }
}
