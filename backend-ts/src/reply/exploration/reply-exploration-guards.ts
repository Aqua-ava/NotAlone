/** 已确认探索的原任务/输入/选择身份与来源守卫；不拥有A指针或C写入。 */
import type {Client} from 'pg';
import type {BuiltReplyContext} from '../context/reply-context-types.ts';
import {normalizeReplyInput,type ReplyRequestInput} from '../generation/reply-contract.ts';
import {requireReplyScope,type VerifiedReplyScope} from '../generation/reply-scope.ts';
import {ReplyStoreError} from '../generation/reply-store.ts';
import {ReplyAssistantGuards,type AuthenticatedContinuation,type ReplyAssistantPorts} from '../generation/reply-assistant-guards.ts';
import {inputRows,generationDependencies,canonical} from '../generation/reply-assistant-erasure.ts';
import * as sources from '../generation/reply-source-guards.ts';
import {requireCurrentReplyMemory} from '../context/reply-context-guards.ts';
import {SkillFiles} from '../../skills/skill-files.ts';
import {createReplySkillGuards} from '../generation/reply-skill-guards.ts';
import {requireExplorationEvidence} from './reply-exploration-evidence.ts';
import {canonicalJSON} from '../../memory/overview/contact-overview-evidence.ts';
type Row=Record<string,any>;
export interface ReplyExplorationOptions {scope:VerifiedReplyScope;input:ReplyRequestInput;skillsRoot:string;authenticatedContinuation?:AuthenticatedContinuation}
export interface ReplyExploredContextValidator {
 (client:Client,context:BuiltReplyContext):Promise<void>;
 captureExploredDependencies(client:Client,context:BuiltReplyContext):Promise<void>;
}
const reject=():never=>{throw new ReplyStoreError('exploration_stale');};
const equal=(a:any,b:any)=>canonical(a)===canonical(b);
const trim=(v:any)=>typeof v==='string'?v.trim():v==null?'':reject();
export function createReplyExploredContextValidator(options:ReplyExplorationOptions):ReplyExploredContextValidator{
 const scope=structuredClone(options.scope),input=structuredClone(options.input),auth=options.authenticatedContinuation?structuredClone(options.authenticatedContinuation):undefined;
 const contactScope={owner_id:scope.owner_id,contact_id:scope.contact_id},files=new SkillFiles(options.skillsRoot);
 const saved=createReplySkillGuards({files,requireDiscussionDependencies:async(c,owner,contact,id)=>{const dependencies=await assistant.requireReplyDiscussionById(c,{owner_id:owner,contact_id:contact},id);if(dependencies===null)reject();return dependencies!;}});
 const ports:ReplyAssistantPorts={...sources,requireCurrentReplyMemory,requireReplySourcesCurrent:(c,s,id,h)=>sources.requireReplySourcesCurrent(c,s,id,h,(c,s,id)=>assistant.requireReplyDiscussionById(c,s,id)),readReplyBasisChanges:(c,s,id)=>sources.readReplyBasisChanges(c,s,id,saved.savedSkillPolicyChange),requireSavedSkillPolicy:saved.requireSavedSkillPolicy,requireActiveBinding:async c=>{await requireReplyScope(c,scope,input);return scope.conversation_binding_id;},navigationDependencyIds:c=>c.snapshot.navigation_dependency_ids as string[]??[]};
 const assistant=new ReplyAssistantGuards(ports);
 async function currentInput(client:Client,session:string,id:string){
  const pointer=(await client.query('SELECT current_input_version_id FROM assistant_session WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,session])).rows[0];
  const row=(await inputRows(client,scope.owner_id,scope.contact_id,session)).find(r=>r.id===id);if(!row||pointer?.current_input_version_id!==id||row.state!=='active'||row.conversation_binding_id!==scope.conversation_binding_id)reject();
  if(row!.input_type==='generation'){
   if(!['running','failed','completed'].includes(row!.turn_state)||row!.input_payload===null||row!.turn_state==='completed'&&!row!.reply_request_id)reject();
   await sources.requireDependencies(client,contactScope,row!.turn_dependencies??[],true);
   const deps=await generationDependencies(client,scope.owner_id,scope.contact_id,row!);await sources.requireGenerationMemoryDependencies(client,contactScope,deps);
   if(row!.reply_request_id){await ports.requireReplySourcesCurrent(client,contactScope,row!.reply_request_id,true);await assistant.requireReplyDiscussionById(client,contactScope,row!.reply_request_id);}
  }else{if(row!.input_type==='candidate_carry')reject();await sources.requireDependencies(client,contactScope,row!.dependency_ids,false);}
  return row!;
 }
 async function read(client:Client){
  if(!input.suggestion)return null;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${scope.owner_id}`]);await requireReplyScope(client,scope,input);
  const reference=input.suggestion,row=(await client.query(`SELECT *,root_created_at+interval '15 minutes'<=clock_timestamp() AS expired FROM reply_exploration WHERE owner_id=$1 AND contact_id=$2 AND id=$3 FOR UPDATE`,[scope.owner_id,scope.contact_id,reference.task_id])).rows[0];
  if(!row||['redacted','expired'].includes(row.state))reject();if(row.expired)throw new ReplyStoreError('exploration_expired');
  const payload=row.input_payload,c=input.content;
  if(!payload||!['response_exploration','purpose_exploration'].includes(payload.type)||typeof payload.skill_selection_complete!=='boolean'&&payload.skill_selection_complete!==undefined||!['auto','disabled','user'].includes(payload.skill_mode)||['purpose_hint','correction','requirements','answer','confirmed_intent'].some(k=>payload[k]!==undefined&&(typeof payload[k]!=='string'||[...payload[k]].length>4096)))reject();
  const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
  if(['correction','requirements','answer','confirmed_intent'].some(k=>typeof payload[k]!=='string')||!Object.hasOwn(payload,'skill_version_id')||(payload.skill_mode==='user'?!uuid(payload.skill_version_id):payload.skill_version_id!==null)||payload.type==='response_exploration'&&!uuid(payload.target_message_id)||payload.type==='purpose_exploration'&&payload.target_message_id!=null||payload.skill_scene!=null&&(typeof payload.skill_scene!=='string'||!payload.skill_scene.trim()||payload.skill_scene!==payload.skill_scene.trim()||[...payload.skill_scene].length>256))reject();
  const historical=!!auth&&row.request_key!==input.idempotency_key;
  const records=await inputRows(client,scope.owner_id,scope.contact_id,row.session_id),original=records.find(r=>r.id===row.input_version_id);
  if(!original||original.state!=='active'||original.input_type==='generation'||original.input_type==='candidate_carry'||original.content===null||original.conversation_binding_id!==scope.conversation_binding_id)reject();
  await sources.requireDependencies(client,contactScope,original!.dependency_ids,false);
  const turn=(await client.query('SELECT * FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND idempotency_key=$4',[scope.owner_id,scope.contact_id,row.session_id,historical?input.idempotency_key:row.request_key])).rows[0];
  if(!turn||turn.state==='redacted'||turn.input_payload===null)reject();
  if(!historical){const pointer=(await client.query('SELECT current_input_version_id FROM assistant_session WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,row.session_id])).rows[0]?.current_input_version_id;await currentInput(client,row.session_id,pointer===row.input_version_id?row.input_version_id:turn.input_version_id);}
  else await currentInput(client,row.session_id,turn.input_version_id);
  await assistant.prepareAssistantReplyStart(client,{...scope,idempotency_key:input.idempotency_key,normalized_input:normalizeReplyInput(input),continued_from_candidate_id:input.continued_from_candidate_id},auth);
  const scene=payload.type==='response_exploration'?'reply_to_message':'initiate_conversation',field=scene==='reply_to_message'?'direction':'purpose';
  if(!['selected','confirmed'].includes(row.state)||!row.selected_intent||!row.selection_id||!['direct_input','confirmed_suggestion'].includes(row.selection_source)||!row.result_payload||row.result_payload.question!==null||!Array.isArray(row.result_payload.ambiguities)||row.result_payload.ambiguities.length||reference.input_version!==row.input_version_id||reference.suggestion_id!==row.selection_id||!historical&&input.idempotency_key!==row.request_key||c.type!==scene||input.skill_version_id!==row.skill_version_id||(row.skill_version_id===null)!==input.skill_disabled||!historical&&input.continued_from_candidate_id!==null||trim(c[field])!==row.selected_intent||c[field+'_source']!==row.selection_source||scene==='reply_to_message'&&c.target_message_id!==payload.target_message_id||trim(c.understanding_correction)!==trim(payload.correction)||!historical&&trim(c.user_instruction)!==trim(payload.requirements)||trim(c.clarification_answer)!==trim(payload.answer))reject();
  if(historical){
   const first=(await client.query(`SELECT t.input_payload,t.conversation_binding_id,t.reply_request_id FROM assistant_session_turn t JOIN reply_request r ON r.owner_id=t.owner_id AND r.contact_id=t.contact_id AND r.id=t.reply_request_id AND r.conversation_binding_id=t.conversation_binding_id AND r.idempotency_key=t.idempotency_key WHERE t.owner_id=$1 AND t.contact_id=$2 AND t.session_id=$3 AND t.idempotency_key=$4 AND t.state='completed' AND r.state='completed'`,[scope.owner_id,scope.contact_id,row.session_id,row.request_key])).rows[0];
   if(!first?.input_payload||!equal(first.input_payload.content?.suggestion,reference)||auth!.continuation.intention_changed!==false||!Array.isArray(auth!.continuation.effective_requirements)||!auth!.continuation.effective_requirements.every(v=>typeof v==='string'&&v.trim())||c.user_instruction!==(auth!.continuation.effective_requirements.length?auth!.continuation.effective_requirements.join('；'):null)||!equal(turn.input_payload.continuation,auth!.continuation))reject();
   await ports.requireReplySourcesCurrent(client,contactScope,first.reply_request_id,true);await saved.requireSavedSkillPolicy(client,contactScope,first.reply_request_id);await sources.requireGenerationMemoryDependencies(client,contactScope,await generationDependencies(client,scope.owner_id,scope.contact_id,{turn_dependencies:[],reply_request_id:first.reply_request_id}));
  }
  const revision=String((await client.query('SELECT revision FROM skill_library WHERE owner_id=$1',[scope.owner_id])).rows[0]?.revision??0);if(revision!==String(row.skill_library_revision))reject();
  if(row.skill_version_id){const version=(await client.query(`SELECT v.*,s.owner_id,s.name FROM reply_skill_version v JOIN reply_skill s ON s.id=v.skill_id WHERE s.owner_id=$1 AND(s.contact_id IS NULL OR s.contact_id=$2) AND s.status='active' AND v.id=$3 AND v.status='active' AND v.enabled AND v.is_current AND v.content_path IS NOT NULL AND v.directory_available`,[scope.owner_id,scope.contact_id,row.skill_version_id])).rows[0];if(!version)reject();files.readManifest(version);files.readContent(version);}
  // 两组分别恢复，再按旧意愿→当前的同ID覆盖顺序合并；每组仍保持14条格式上限。
  const intent=await requireExplorationEvidence(client,contactScope,row.intent_snapshots),current=await requireExplorationEvidence(client,contactScope,row.snapshots);
  return {row,evidence:[...new Map([...intent,...current].map(e=>[e.evidence_id,e])).values()]};
 }
 const validate:ReplyExploredContextValidator=Object.assign(async(client:Client,context:BuiltReplyContext)=>{
  if(!equal(context.scope,contactScope)||context.conversation_binding_id!==scope.conversation_binding_id||!equal(context.command.content,input.content))reject();const task=await read(client);if(!task)return;
  for(const actual of task.evidence){const existing=context.evidence.find(e=>e.evidence_id===actual.evidence_id);if(!existing||canonicalJSON({...actual,selection_reason:existing.selection_reason,model_visible:existing.model_visible,navigation:existing.navigation})!==canonicalJSON(existing))reject();}
 },{captureExploredDependencies:async(client:Client,context:BuiltReplyContext)=>{if(!equal(context.scope,contactScope)||context.conversation_binding_id!==scope.conversation_binding_id)reject();const task=await read(client);if(!task)return;for(const e of task.evidence)if(!context.evidence.some(existing=>existing.evidence_id===e.evidence_id))context.evidence.push(e);await validate(client,context);}});
 return validate;
}
