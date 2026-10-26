/** 显式采用新消息继承同一持久输入的要求；不接受调用方上传累计要求。 */
import type {Client} from 'pg';
import {parseReplyRequest,replyUuid,record,type ReplyRequestInput} from '../generation/reply-contract.ts';
import type {VerifiedReplyScope} from '../generation/reply-scope.ts';
import {canonical} from '../generation/reply-assistant-erasure.ts';
import {AssistantGenerationStore,AssistantGenerationError,generationReject,generationRequest,type GenerationRow} from './assistant-generation-store.ts';
export interface AssistantAdoptionInput {input:ReplyRequestInput;submission:GenerationRow;message:string}
const invalid=():never=>{throw new AssistantGenerationError('assistant_session_request_invalid',undefined,400);};
export function parseAssistantGeneration(value:unknown):{input:ReplyRequestInput;adoption?:AssistantAdoptionInput}{
 if(!record(value))return invalid();
 const allowed=['contact_id','idempotency_key','content','expected_input_version_id','adopt_new_message_id','skill_version_id','skill_disabled','continued_from_candidate_id','suggestion','scene','allow_incomplete_history'];
 if(Object.keys(value).some(key=>!allowed.includes(key)))return invalid();
 const input=parseReplyRequest(value);if(!Object.hasOwn(value,'adopt_new_message_id'))return {input};
 const c=value.content;if(Object.keys(value).some(key=>!allowed.includes(key))||!record(c)||c.user_instruction!=null||c.suggestion!=null||value.suggestion!=null||value.continued_from_candidate_id!=null||!input.expected_input_version_id)return invalid();
 const message=replyUuid(value.adopt_new_message_id);
 const fields=c.type==='rewrite_draft'?['type','draft_text','user_instruction','include_relationship_context','input_kind','workspace_action','context_text','excluded_message_ids']:['type','understanding_correction','user_instruction','clarification_answer','suggestion',...(c.type==='reply_to_message'?['direction','direction_source','target_message_id']:['purpose','purpose_source'])];
 if(Object.keys(c).some(key=>!fields.includes(key))||c.type==='rewrite_draft'&&(c.input_kind!=='workspace'||c.include_relationship_context!==true||(input.content.excluded_message_ids as string[]).includes(message))||c.type==='reply_to_message'&&input.content.target_message_id!==message)return invalid();
 // JSON的缺字段与null都是原submission的一部分；不把规范化副本当成用户原声明。
 const submission=JSON.parse(JSON.stringify(value));return {input,adoption:{input,submission,message}};
}
export async function reserveAssistantAdoption(store:AssistantGenerationStore,client:Client,scope:VerifiedReplyScope,session:string,command:AssistantAdoptionInput,runningKey?:string){
 const {input:declared,submission,message}=command;await store.session(client,scope,session);
 const existing=await store.existing(client,scope,declared.idempotency_key);let metadata:GenerationRow,content:GenerationRow,deps:string[]=[];
 if(existing){
  if(existing.state==='redacted'||!existing.input_payload)generationReject('source_deleted');
  metadata=existing.input_payload.continuation;
  if(existing.session_id!==session&&existing.requested_session_id!==session||!metadata||canonical(metadata.message_adoption)!==canonical(submission))throw new AssistantGenerationError('assistant_session_input_conflict');
  const auth=await store.auth(client,scope,existing.requested_session_id??session,existing.input_payload);content=generationRequest(scope,declared.idempotency_key,existing.input_payload,auth).content;
 }else{
  deps=await store.current(client,scope,session,declared.expected_input_version_id!);
  const current=(await client.query('SELECT input_payload FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND input_version_id=$4',[scope.owner_id,scope.contact_id,session,declared.expected_input_version_id])).rows[0];
  if(!current?.input_payload)generationReject('invalid_message_adoption');
  const previous=current.input_payload,priorAuth=await store.auth(client,scope,session,previous),old=generationRequest(scope,declared.idempotency_key,previous,priorAuth).content;
  if(old.type!==declared.content.type||old.type==='rewrite_draft'&&old.input_kind!=='workspace')generationReject('invalid_message_adoption');
  const requirements=previous.continuation?.effective_requirements??(old.user_instruction?[old.user_instruction]:[]);
  content={...declared.content,user_instruction:requirements.length?requirements.join('；'):null};
  const source=content.type==='rewrite_draft'?'draft_text':content.type==='reply_to_message'?'direction':'purpose';
  metadata={version:1,submission,message_adoption:submission,candidate_group_id:null,candidate_number:null,candidate_id:null,version_id:null,effective_intent:{source},effective_requirements:requirements,intention_changed:old[source]!==content[source]||content.type==='rewrite_draft'&&old.workspace_action!==content.workspace_action,scope:'this_assistant_session_only'};
 }
 const auth={continuation:metadata,continuation_reference:null};
 const input=parseReplyRequest({...declared,content},auth);
 const captured=await store.guards.assistant.verifiedDiscussionDependencies(client,scope,[message],true);deps=[...new Set([...deps,...captured])];
 const row=await store.reserve(client,scope,session,input,{auth,dependencies:deps,runningKey});return {row,input,auth};
}
