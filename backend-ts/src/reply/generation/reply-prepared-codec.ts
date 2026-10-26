/** 原 Python v2/schema15 包装格式；外部 command 只由已验证请求提供。 */
import {preparedSchema} from './reply-prepared-schema.ts';
import {normalizeEvent,normalizeConditions,normalizeEvolution} from '../../memory/overview/projection/metadata.ts';
import {allowsHistory} from '../context/reply-context.ts';
import {epochMicros} from '../../memory/overview/projection/time.ts';
import type {ReplyRequestInput} from './reply-contract.ts';
import {stringifyJson} from '../../host/host-json.ts';
type Row=Record<string,any>;
export class PreparedContextFormatError extends Error {readonly code='prepared_context_reprepare_required';constructor(){super('固定上下文格式已变化或损坏，请重新准备。');}}
const bad=():never=>{throw new PreparedContextFormatError();};
const object=(v:any):v is Row=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const exact=(v:any,keys:string[])=>{if(!object(v)||Object.keys(v).sort().join()!==[...keys].sort().join())bad();};
const id=(v:any)=>{if(typeof v!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v))bad();return v.toLowerCase();};
const integer=(v:any,min:number|bigint=0,max:number|bigint=9223372036854775807n)=>{if(!(typeof v==='number'&&Number.isSafeInteger(v)||typeof v==='bigint')||v<min||v>max)bad();};
const same=(a:any,b:any)=>JSON.stringify(a)===JSON.stringify(b);
// dict中的嵌套白名单值同样保留原包装；未修改值的往返不丢tuple/UUID类型。
const dynamicWire=new WeakMap<object,{wire:any;value:string}>();
function semantic(type:string,v:Row){
 const hash=(s:any)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s);
 const aware=(s:any)=>s===null||typeof s==='string'&&/(Z|[+-]\d\d:\d\d)$/.test(s);
 if(type==='MemoryTiming'&&(![v.recorded_at,v.source_started_at,v.source_ended_at].every(aware)||(v.source_started_at===null)!==(v.source_ended_at===null)||v.source_started_at!==null&&epochMicros(v.source_ended_at)<epochMicros(v.source_started_at)||v.source_time_complete&&v.source_started_at===null||!['current_verified','current_unverified','historical','stable'].includes(v.current_status)||!v.current_status_reason.trim()))bad();
 if(type==='ConfirmedDirection'&&(!v.text.trim()||v.suggestion&&v.source!=='confirmed_suggestion'&&typeof v.suggestion.input_version!=='string'))bad();
 if(type==='SuggestionReference'&&typeof v.input_version!=='string')integer(v.input_version,1);
 if(type==='ContinuedReplyCandidate'&&!v.text.trim())bad();
 if(type==='ReplyBasisChange'&&(v.kind==='reply_skill')!==(v.reason==='skill_policy_changed'))bad();
 if(type==='DiscussionIdentity'&&(!hash(v.payload_sha256)||!['discussion_input','generation_input','candidate_version'].includes(v.kind)||v.kind==='discussion_input'&&[v.turn_id,v.candidate_id,v.version_id].some(i=>i!==null)||v.kind==='generation_input'&&(v.turn_id===null||v.candidate_id!==null||v.version_id!==null)||v.kind==='candidate_version'&&[v.turn_id,v.candidate_id,v.version_id].some(i=>i===null)))bad();
 if(type==='DiscussionSnapshot'&&(!hash(v.current_payload_sha256)||v.basis_revision_sha256!==null&&!hash(v.basis_revision_sha256)||new Set(v.records.map((r:Row)=>r.kind+':'+(r.kind==='candidate_version'?r.version_id:r.input_version_id))).size!==v.records.length||v.records.some((r:Row)=>r.input_version_id===v.current_input_version_id||r.turn_id===v.current_turn_id)))bad();
 if(type==='DiscussionContext'&&['scope','session_id','request_key','current_input_version_id'].some(k=>!same(v[k],v.snapshot[k])))bad();
 if(type==='ContextEvidence'&&v.kind!=='message'&&v.speaker_role!=='unknown')bad();
 if(type==='OverviewRevision'||type==='MemoryNavigation'){if(!/^[a-f0-9]{64}$/.test(v.projection_revision))bad();integer(v.memory_revision,type==='MemoryNavigation'?1:0);}
 if(type==='MemoryNavigation')for(const k of ['source_message_ids','dependency_ids'])if(new Set(v[k]).size!==v[k].length)bad();
 if(type==='RetrievalQuery'){integer(v.limit,1,20);if(new Set(v.evidence_ids).size!==v.evidence_ids.length||(v.status==='succeeded')!==!!v.evidence_ids.length)bad();}
 if(type==='RetrievalBudget'){integer(v.limit,1,20);integer(v.char_limit,1,10000);integer(v.used_count,0,v.limit);integer(v.used_chars,0,v.char_limit);}
 if(type==='SourceMessageBudget')for(const [limit,used,max]of [['call_limit','used_calls',3],['item_limit','used_count',16],['token_limit','used_tokens',2048]] as const){integer(v[limit],1,max);integer(v[used],0,v[limit]);}
 if(type==='ReplyRetrievalReceipt'&&v.queries.length>64)bad();
 if(type==='ExpressionPreference'){integer(v.revision,1);if(!aware(v.confirmed_at)||!aware(v.updated_at)||!v.text.trim()||[...v.text].length>512||new Set(v.source_ids).size!==v.source_ids.length||!['manual','message'].includes(v.origin_kind)||v.origin_kind==='manual'&&(v.origin_id!==null||v.source_ids.length)||v.origin_kind==='message'&&(!v.origin_id||!v.scope.contact_id||!v.source_ids.includes(v.origin_id)))bad();}
}
function dynamic(value:any,encode:boolean,depth:number):any{
 if(depth>100)bad();if(value===null||['string','boolean','number','bigint'].includes(typeof value))return value;
 if(encode){const original=dynamicWire.get(value);if(original&&original.value===stringifyJson(value))return structuredClone(original.wire);if(Array.isArray(value))return {list:value.map(v=>dynamic(v,true,depth+1))};if(object(value))return {mapping:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,dynamic(v,true,depth+1)]))};bad();}
 const remember=(result:any)=>{if(result&&typeof result==='object')dynamicWire.set(result,{wire:structuredClone(value),value:stringifyJson(result)});return result;};
 if(Array.isArray(value))return remember(value.map(v=>dynamic(v,false,depth+1)));
 if(object(value)&&Object.keys(value).length===1){if(object(value.mapping))return remember(Object.fromEntries(Object.entries(value.mapping).map(([k,v])=>[k,dynamic(v,false,depth+1)])));if(Array.isArray(value.list))return remember(value.list.map((v:any)=>dynamic(v,false,depth+1)));for(const [key,spec]of [['uuid','UUID'],['datetime','datetime'],['direction_source','DirectionSource'],['memory_event','MemoryEvent'],['memory_conditions','MemoryConditions'],['memory_evolution','MemoryEvolution']])if(Object.hasOwn(value,key))return transform(value,spec,false,depth+1);}
 if(object(value)&&preparedSchema[value.type])return remember(transform(value,value.type,false,depth+1));
 bad();
}
function transform(value:any,spec:any,encode:boolean,depth=0):any{
 if(depth>100)bad();
 if(object(spec)){
  if(spec.union){for(const part of spec.union){try{return transform(value,part,encode,depth+1);}catch(e){if(!(e instanceof PreparedContextFormatError))throw e;}}return bad();}
  if(spec.literal){if(!spec.literal.some((v:any)=>v===value))bad();return value;}
  if(spec.tuple){if(!Array.isArray(value))bad();return value.map((v:any)=>transform(v,spec.tuple,encode,depth+1));}
 }
 if(spec==='NoneType'){if(value!==null)bad();return value;}
 if(spec==='str'||spec==='bool'||spec==='float'||spec==='int'){if(spec==='int'){integer(value,-Number.MAX_SAFE_INTEGER);}else if(typeof value!==({str:'string',bool:'boolean',float:'number'} as Row)[spec])bad();return value;}
 if(spec==='dict'){if(encode&&!object(value))bad();const result=dynamic(value,encode,depth+1);if(!encode&&!object(result))bad();return result;}
 if(['UUID','datetime','DirectionSource'].includes(spec)){
  const key=({UUID:'uuid',datetime:'datetime',DirectionSource:'direction_source'} as Row)[spec];if(!encode)exact(value,[key]);const raw=encode?value:value[key];
  if(spec==='UUID')id(raw);else if(spec==='datetime'){if(typeof raw!=='string'||!Number.isFinite(Date.parse(raw)))bad();}else if(!['direct_input','confirmed_suggestion'].includes(raw))bad();
  const normalized=spec==='UUID'?id(raw):raw;return encode?{[key]:normalized}:normalized;
 }
 if(['MemoryEvent','MemoryConditions','MemoryEvolution'].includes(spec)){
  const [key,normalize]=({MemoryEvent:['memory_event',normalizeEvent],MemoryConditions:['memory_conditions',normalizeConditions],MemoryEvolution:['memory_evolution',normalizeEvolution]} as Row)[spec];
  if(!encode)exact(value,[key]);const raw=encode?value:value[key];try{if(!normalize(raw))bad();}catch{bad();}return encode?{[key]:structuredClone(raw)}:structuredClone(raw);
 }
 const fields=preparedSchema[spec];if(!fields)bad();let data=value;
 if(!encode&&spec!=='ReplyContext'){exact(value,['type','fields']);if(value.type!==spec)bad();data=value.fields;}
 exact(data,Object.keys(fields));const result:Row={};for(const [key,field]of Object.entries(fields))result[key]=transform(data[key],field,encode,depth+1);
 semantic(spec,encode?data:result);return encode&&spec!=='ReplyContext'?{type:spec,fields:result}:result;
}
export function encodePreparedContext(value:Row):Row{return {version:2,schema_revision:15,context:transform(value,'ReplyContext',true)};}
export function decodePreparedContext(payload:unknown,command:ReplyRequestInput,scope:{owner_id:string;contact_id:string},binding:string,requestId?:string):Row{
 try{
  exact(payload,['version','schema_revision','context']);const p=payload as Row;if(p.version!==2||p.schema_revision!==15)bad();const c=transform(p.context,'ReplyContext',false);
  if(!same(c.scope,scope)||c.evidence.some((e:Row)=>!same(e.scope,scope))||command.contact_id!==scope.contact_id)bad();
  if(allowsHistory(command)&&c.history_message_ids===null)bad();
  const prefs=c.expression_preferences;if(c.expression_preference_revision!==null)integer(c.expression_preference_revision);else if(prefs.length)bad();
  if(prefs.length>5||new Set(prefs.map((e:Row)=>e.preference_id)).size!==prefs.length||prefs.reduce((n:number,e:Row)=>n+[...e.text].length,0)>1536||prefs.some((e:Row)=>e.scope.owner_id!==scope.owner_id||![null,scope.contact_id].includes(e.scope.contact_id)||![null,command.content.type].includes(e.scope.reply_mode)))bad();
  const b=c.continuation_basis;if((b===null)!==(command.continued_from_candidate_id===null)||b&&(!same(b.scope,scope)||b.conversation_binding_id!==binding||b.candidate_id!==command.continued_from_candidate_id))bad();
  const d=c.assistant_discussion;if(d&&(!same(d.scope,scope)||d.request_key!==command.idempotency_key||!same(d.snapshot.scope,scope)||d.snapshot.request_key!==command.idempotency_key))bad();
  const receipt=c.retrieval,actual=new Map<string,Row>(c.evidence.filter((e:Row)=>e.model_visible).map((e:Row)=>[e.evidence_id,e]));
  if(!receipt){if(c.evidence.some((e:Row)=>e.navigation))bad();}else{
   for(const q of receipt.queries)if(q.evidence_ids.some((i:string)=>actual.get(i)?.kind!==q.kind))bad();
   for(const [kind,key]of [['confirmed_memory','contact_memory'],['owner_memory','owner_memory'],['pending_candidate','pending_candidate']]){const selected=[...actual.values()].filter(e=>e.kind===kind);if(selected.length!==receipt[key].used_count||selected.reduce((n,e)=>n+[...e.text].length,0)!==receipt[key].used_chars)bad();}
   for(const e of actual.values())if(e.navigation){const n=e.navigation,expected=receipt[n.scope_kind==='owner'?'owner_overview':'contact_overview'];if(!expected||e.kind!==(n.scope_kind==='owner'?'owner_memory':'confirmed_memory')||e.evidence_id!==n.memory_id||e.revision!==n.memory_revision||n.projection_revision!==expected.projection_revision)bad();}
  }
  if(requestId)c.reply_request_id=id(requestId);return c;
 }catch{throw new PreparedContextFormatError();}
}
