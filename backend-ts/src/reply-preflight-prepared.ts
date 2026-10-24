/** 原A准备副本的同owner事务CAS；不创建C请求、attempt或模型调用。 */
import type {Client} from 'pg';
import {isDeepStrictEqual} from 'node:util';
import {normalizeReplyInput,type ReplyRequestInput} from './reply-contract.ts';
import {requireReplyScope,type VerifiedReplyScope} from './reply-scope.ts';
import {ReplyStoreError} from './reply-store.ts';
import type {AuthenticatedContinuation,ReplyAssistantGuards} from './reply-assistant-guards.ts';
import type {ReplyPreparationIdentity} from './reply-discussion-context.ts';
import {activeMessage} from './reply-assistant-erasure.ts';
import {parseJson,stringifyJson} from './host-json.ts';
import {allowsHistory} from './reply-context.ts';
import {decodePreparedContext,PreparedContextFormatError} from './reply-prepared-codec.ts';
export interface AssistantPreparationReceipt {session_id:string;turn_id:string;request_key:string;input_version_id:string;state:string;interruption_reason:string|null}
export interface AssistantPreparedPort<State> {
 build(client:Client,identity:ReplyPreparationIdentity,historyIds:string[]):Promise<State>;
 restore(client:Client,identity:ReplyPreparationIdentity,encoded:unknown):Promise<State>;
 validate(client:Client,identity:ReplyPreparationIdentity,state:State):Promise<void>;
 encode(state:State):unknown;
 dependencies(state:State):string[];
}
export interface AssistantPreflightOptions<State,Budget> {
 transaction<T>(operation:(client:Client)=>Promise<T>):Promise<T>;
 scope:VerifiedReplyScope;input:ReplyRequestInput;authenticatedContinuation?:AuthenticatedContinuation;
 assistant:Pick<ReplyAssistantGuards,'prepareAssistantReplyStart'>;prepared:AssistantPreparedPort<State>;
 /** 使用实际官方Agent预检；仅首次准备允许省略新增层，不得更改冻结材料。 */
 fitBudget(state:State,options:{frozen:boolean;signal:AbortSignal}):Promise<{state:State;budget:Budget}>;
}
type Row=Record<string,any>;
const reject=(code='reply_context_invalidated'):never=>{throw new ReplyStoreError(code);};
function format(value:any):void {if(value!==null&&(!value||value.version!==2||value.schema_revision!==15||Object.keys(value).sort().join(',')!=='context,schema_revision,version'||!value.context||typeof value.context!=='object'))reject('reply_preparation_format_invalid');}
const receipt=(row:Row):AssistantPreparationReceipt=>({session_id:row.session_id,turn_id:row.id,request_key:row.idempotency_key,input_version_id:row.input_version_id,state:row.state,interruption_reason:row.interruption_reason});
export async function prepareAssistantReply<State,Budget>(options:AssistantPreflightOptions<State,Budget>,signal:AbortSignal):Promise<{receipt:AssistantPreparationReceipt;state:State|null;budget:Budget|null;replayed:boolean}>{
 const {scope,input}=options,identity={owner_id:scope.owner_id,contact_id:scope.contact_id,conversation_binding_id:scope.conversation_binding_id,idempotency_key:input.idempotency_key};
 if(!options.prepared||typeof options.fitBudget!=='function')reject('reply_guards_unavailable');
 async function anchor(client:Client,current:boolean):Promise<Row>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${scope.owner_id}`]);
   const row=(await client.query(`SELECT t.*,t.prepared_context::text AS prepared_text,t.input_payload::text AS payload_text,i.state AS input_state,i.input_type,i.conversation_binding_id AS input_binding,s.current_input_version_id FROM assistant_session_turn t
     JOIN assistant_session_input i ON i.id=t.input_version_id AND i.turn_id=t.id AND i.session_id=t.session_id AND i.owner_id=t.owner_id AND i.contact_id=t.contact_id
     JOIN assistant_session s ON s.id=t.session_id AND s.owner_id=t.owner_id AND s.contact_id=t.contact_id
     WHERE t.owner_id=$1 AND t.contact_id=$2 AND t.idempotency_key=$3 FOR UPDATE OF t`,[scope.owner_id,scope.contact_id,input.idempotency_key])).rows[0];
   if(!row||row.input_payload===null||row.input_type!=='generation'||row.input_state!=='active'||!['running','failed','completed'].includes(row.state)||row.conversation_binding_id!==scope.conversation_binding_id||row.input_binding!==scope.conversation_binding_id||row.interruption_reason!==null)reject();
   row.encoded=row.prepared_text===null?null:parseJson(row.prepared_text);format(row.encoded);
   if(row.encoded!==null)try{decodePreparedContext(row.encoded,input,{owner_id:scope.owner_id,contact_id:scope.contact_id},scope.conversation_binding_id);}catch(error){if(error instanceof PreparedContextFormatError)reject('reply_preparation_format_invalid');throw error;}
   await options.assistant.prepareAssistantReplyStart(client,{...identity,normalized_input:normalizeReplyInput(input),continued_from_candidate_id:input.continued_from_candidate_id},options.authenticatedContinuation);
   if(current){if(row.current_input_version_id!==row.input_version_id)reject();await requireReplyScope(client,scope,input);}
   signal.throwIfAborted();return row;
 }
 for(let attempt=0;attempt<2;attempt++){
   signal.throwIfAborted();
   const first=await options.transaction(async client=>{
     const row=await anchor(client,false);
     if(row.state==='completed'||row.state==='failed'&&row.encoded!==null)return {row,state:null as State|null};
     if(row.current_input_version_id!==row.input_version_id)reject();await requireReplyScope(client,scope,input);
     const ids=allowsHistory(input)?(await client.query(`SELECT message.id FROM message WHERE message.owner_id=$1 AND message.contact_id=$2 AND ${activeMessage} ORDER BY message.occurred_at DESC NULLS LAST,message.id DESC LIMIT 500`,[scope.owner_id,scope.contact_id])).rows.map(r=>r.id):[];
     const state=row.encoded===null?await options.prepared.build(client,identity,ids):await options.prepared.restore(client,identity,row.encoded);
     await options.prepared.validate(client,identity,state);signal.throwIfAborted();return {row,state};
   });
   if(first.state===null)return {receipt:receipt(first.row),state:null,budget:null,replayed:true};
   // decode可规范化旧时间表示；冻结限制比较解码后同一材料，绝不改写原始JSON。
   const frozenEncoding=first.row.encoded===null?null:options.prepared.encode(first.state);
   const fitted=await options.fitBudget(first.state,{frozen:first.row.encoded!==null,signal});signal.throwIfAborted();
   if(frozenEncoding!==null&&!isDeepStrictEqual(options.prepared.encode(fitted.state),frozenEncoding))reject();
   const result=await options.transaction(async client=>{
     const current=await anchor(client,true);
     if(current.id!==first.row.id||current.input_version_id!==first.row.input_version_id||current.input_digest!==first.row.input_digest||current.payload_text!==first.row.payload_text)reject();
     if(!isDeepStrictEqual(current.encoded,first.row.encoded))return null;
     await options.prepared.validate(client,identity,fitted.state);signal.throwIfAborted();
     if(current.encoded===null){const encoded=options.prepared.encode(fitted.state);format(encoded);const deps=[...new Set(options.prepared.dependencies(fitted.state))];if(deps.some(id=>typeof id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)))reject();
       await client.query('UPDATE assistant_session_turn SET prepared_context=$2,dependency_ids=ARRAY(SELECT DISTINCT unnest(dependency_ids||$3::uuid[])) WHERE id=$1',[current.id,stringifyJson(encoded),deps]);
     }
     signal.throwIfAborted();return {receipt:receipt(current),state:fitted.state,budget:fitted.budget,replayed:current.encoded!==null};
   });
   if(result)return result;
 }
 return reject('reply_preparation_conflict');
}
