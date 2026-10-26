/** B 的确认命令只组装到既有 A 生命周期；不另建候选或模型执行链。 */
import type {Client} from 'pg';
import type {VerifiedReplyScope} from '../generation/reply-scope.ts';
import {requireReplyScope} from '../generation/reply-scope.ts';
import {PostgresExplorationStore} from '../exploration/exploration-store.ts';
import {ExplorationEvidence} from '../exploration/exploration-evidence.ts';
import {ExplorationStale,ExplorationError,hasConfirmedIntent,type ExplorationTask} from '../exploration/exploration-contract.ts';
import {PostgresSkillPort} from '../../skills/skill-port.ts';
import {createExplorationSkillSourceValidator} from '../exploration/exploration-skill-sources.ts';
import {parseExplorationEnvelope,type ExplorationHttpService} from '../exploration/exploration-http.ts';
import {record,replyUuid,ReplyError,type ReplyRequestInput} from '../generation/reply-contract.ts';
import type {AuthenticatedContinuation} from '../generation/reply-assistant-guards.ts';
import type {AssistantGenerationStore} from './assistant-generation-store.ts';
import {generationRequest,AssistantGenerationError} from './assistant-generation-store.ts';
import type {AssistantGenerationLifecycle,AssistantGenerationHandleInput,AssistantGenerationResponse} from './assistant-generation-lifecycle.ts';
type Row=Record<string,any>;
const scopeOf=(scope:VerifiedReplyScope)=>({owner_id:scope.owner_id,contact_id:scope.contact_id});
const stale=():never=>{throw new ExplorationStale();};
const trim=(v:unknown)=>typeof v==='string'?v.trim():v==null?'':stale();
export function generationExplorationStore(store:AssistantGenerationStore,scope:VerifiedReplyScope){
 return new PostgresExplorationStore({transaction:work=>store.transaction(scope,work),evidence:new ExplorationEvidence(),skills_root:store.options.skillsRoot,guards:{
  active_binding:async(client,s)=>{if(s.owner_id!==scope.owner_id||s.contact_id!==scope.contact_id)stale();const rows=(await client.query(scope.confirmation==='manual'?'SELECT id FROM manual_contact_confirmation WHERE owner_id=$1 AND contact_id=$2 AND id=$3 FOR SHARE':"SELECT id FROM conversation_binding WHERE owner_id=$1 AND contact_id=$2 AND id=$3 AND status='active' FOR SHARE",[scope.owner_id,scope.contact_id,scope.conversation_binding_id])).rows;if(rows.length!==1)stale();return scope.conversation_binding_id;},
  require_current_input:async(client,_s,session,input)=>{await store.current(client,scope,session,input);},
  require_skill:async(client,s,revision,id,scene)=>{
   const port=new PostgresSkillPort({read:work=>work(client)},store.options.skillsRoot,{requireDiscussionDependencies:createExplorationSkillSourceValidator(store.options.skillsRoot)});
   try{const skillScope={ownerId:s.owner_id,contactId:s.contact_id,scene:scene??''},catalog=await port.catalog(skillScope);if(catalog.revision!==String(revision))stale();const entry=id?catalog.entries.find(e=>e.versionId===id):null;if(id&&!entry)stale();if(entry)await port.loadVersion(skillScope,entry,catalog.revision);await port.validate(skillScope,catalog.revision,entry??null);}finally{port.dispose();}
  },
 }});
}
export async function prepareExploredGeneration(store:AssistantGenerationStore,client:Client,scope:VerifiedReplyScope,session:string,input:ReplyRequestInput,auth?:AuthenticatedContinuation):Promise<string[]>{
 if(!input.suggestion)return [];
 const reference=input.suggestion,explored=generationExplorationStore(store,scope),raw=(await client.query('SELECT request_key FROM reply_exploration WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,reference.task_id])).rows[0];
 const historical=!!auth&&raw?.request_key!==input.idempotency_key,task=await explored.read_in_transaction(client,scopeOf(scope),reference.task_id,historical?'history':'current');
 const c=input.content,scene=task.content.type==='response_exploration'?'reply_to_message':'initiate_conversation',field=scene==='reply_to_message'?'direction':'purpose';
 if(task.session_id!==session||!['selected','confirmed'].includes(task.state)||!hasConfirmedIntent(task)||!task.result||task.result.question!==null||task.result.ambiguities.length||reference.input_version!==task.input_version_id||reference.suggestion_id!==task.selection_id||!historical&&input.idempotency_key!==task.request_key||c.type!==scene||input.skill_version_id!==task.skill_version_id||(task.skill_version_id===null)!==input.skill_disabled||!historical&&input.continued_from_candidate_id!==null||trim(c[field])!==task.selected_intent||c[field+'_source']!==task.selection_source||scene==='reply_to_message'&&c.target_message_id!==task.content.target_message_id||trim(c.understanding_correction)!==task.content.correction.trim()||!historical&&trim(c.user_instruction)!==task.content.requirements.trim()||trim(c.clarification_answer)!==task.content.answer.trim())stale();
 if(historical){
  const original=(await client.query("SELECT * FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND idempotency_key=$4 AND state='completed'",[scope.owner_id,scope.contact_id,session,task.request_key])).rows[0];
  if(!original?.reply_request_id||auth!.continuation.intention_changed!==false||!Array.isArray(auth!.continuation.effective_requirements)||c.user_instruction!==(auth!.continuation.effective_requirements.length?auth!.continuation.effective_requirements.join('；'):null))stale();
  await store.guards.ports.requireReplySourcesCurrent(client,scope,original.reply_request_id,true);await store.guards.ports.requireSavedSkillPolicy(client,scope,original.reply_request_id);
 }
 return new ExplorationEvidence().dependencies([...task.intent_snapshots,...task.snapshots],scopeOf(scope));
}
export function exploredGenerationRequest(scope:VerifiedReplyScope,task:ExplorationTask):Row {
 if(!hasConfirmedIntent(task)||!task.selection_id||!['selected','confirmed'].includes(task.state)||!task.result||task.result.question!==null||task.result.ambiguities.length)stale();
 const type=task.content.type==='response_exploration'?'reply_to_message':'initiate_conversation',field=type==='reply_to_message'?'direction':'purpose';
 return {contact_id:scope.contact_id,idempotency_key:task.request_key,content:{type,[field]:task.selected_intent,[field+'_source']:task.selection_source,...(type==='reply_to_message'?{target_message_id:task.content.target_message_id}:{}),understanding_correction:task.content.correction||null,user_instruction:task.content.requirements||null,clarification_answer:task.content.answer||null},suggestion:{task_id:task.exploration_id,input_version:task.input_version_id,suggestion_id:task.selection_id},skill_disabled:task.skill_version_id===null,skill_version_id:task.skill_version_id,scene:task.content.skill_scene??null,expected_input_version_id:task.input_version_id};
}
export async function handleAssistantExplorationGeneration(lifecycle:AssistantGenerationLifecycle,store:AssistantGenerationStore,input:AssistantGenerationHandleInput,exploration:ExplorationHttpService):Promise<AssistantGenerationResponse|null>{
 const parts=new URL(input.path,'http://localhost').pathname.split('/').filter(Boolean);
 if(parts.length!==8||parts[0]!=='api'||parts[1]!=='contacts'||parts[3]!=='assistant-sessions'||parts[5]!=='explorations'||!['confirm','answer','prepare-confirm','prepare-answer'].includes(parts[7]))return null;
 if(input.method!=='POST')return {status:405,payload:{error:'method_not_allowed'}};
 const contact=replyUuid(parts[2]),session=replyUuid(parts[4]),id=replyUuid(parts[6]),prepare=parts[7].startsWith('prepare-'),action=parts[7].replace('prepare-','');
 if(contact!==input.scope.contact_id)throw new ReplyError('exploration_request_invalid',400);
 if(!record(input.body)||input.body.generate!==undefined&&typeof input.body.generate!=='boolean'||prepare&&input.body.generate!==true)throw new ReplyError('exploration_request_invalid',400);
 const request:Row={...input.body,exploration_id:id,selection_only:input.body.generate!==true};delete request.generate;
 parseExplorationEnvelope({owner_id:input.scope.owner_id,contact_id:contact,session_id:session,action,request},input.scope.owner_id);
 const scope=scopeOf(input.scope),result=await exploration.execute(scope,session,action,request,input.signal,{manual_input:input.scope.confirmation==='manual'});
 if(!record(result)||!['generation_command','replay_command'].includes(result.kind as string))return {status:200,payload:result};
 const explored=generationExplorationStore(store,input.scope);
 let body:unknown,task:ExplorationTask|undefined,explorationId:string;
 if(result.kind==='replay_command'){
  const completed=action==='confirm'?await explored.replay_confirmation(scope,session,id,request.input_version_id,{suggestion_id:request.suggestion_id??null,direct_intent:request.direct_intent??null}):await explored.replay_answer(scope,session,id,request.input_version_id,{question_id:request.question_id,answer:request.answer,operation_key:request.operation_key});
  if(!completed)stale();explorationId=completed!.exploration_id;body=generationRequest(input.scope,completed!.request_key,completed!.input_payload);
 }else{
  explorationId=replyUuid(result.exploration_id);task=await store.transaction(input.scope,client=>explored.read_in_transaction(client,scope,explorationId));
  if(task.session_id!==session||result.request_key!==task.request_key||result.input_version_id!==task.input_version_id)stale();body=exploredGenerationRequest(input.scope,task);
 }
 try{
  if(prepare)return {status:200,payload:{kind:'prepared',exploration_id:explorationId,generation:await lifecycle.prepare(input.scope,session,body,input.signal)}};
  const turn=await lifecycle.generate(input.scope,session,body,input.signal);if(task)await explored.finish(task);
  const c=(turn as Row).input.content,intent=c.type==='reply_to_message'?c.direction:c.purpose;return {status:200,payload:{kind:'generated',turn,confirmed_intent:intent,exploration_id:explorationId}};
 }catch(error){if(error instanceof AssistantGenerationError&&error.no_generation)return {status:error.status,payload:{error:error.code,reason:error.reason,no_generation:error.no_generation,exploration_preparation:{exploration_id:id,input_version_id:request.input_version_id,action:parts[7]}}};throw error;}
}
