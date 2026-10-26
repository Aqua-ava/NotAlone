/** 助手完整讨论只读装配；正文仅作为本轮低权重模型输入，不写入关系事实。 */
import type pg from 'pg';
import type {AssistantScope,AuthenticatedContinuation,ReplyAssistantPorts} from '../generation/reply-assistant-guards.ts';
import {ReplyAssistantGuards} from '../generation/reply-assistant-guards.ts';
import type {ReplyStoreRequest} from '../generation/reply-store.ts';
import {ReplyStoreError} from '../generation/reply-store.ts';
import {canonical,fingerprint,legacyJson,inputRows,generationDependencies,carryEdges,capturedEdges,snapshot} from '../generation/reply-assistant-erasure.ts';
import {anchor as anchorSQL} from '../generation/reply-assistant-erasure-sql.ts';
import {withReplyValidationScope} from '../generation/reply-source-guards.ts';
type Row=Record<string,any>;
type Change=Record<string,unknown>;
export type ReplyPreparationIdentity=Pick<ReplyStoreRequest,'owner_id'|'contact_id'|'conversation_binding_id'|'idempotency_key'>;
type DiscussionRequest=ReplyPreparationIdentity&{request_id:string|null};
export type DiscussionKind='discussion_input'|'generation_input'|'candidate_version'|'candidate_carry';
export interface DiscussionItem {
 kind:DiscussionKind;text:string;input_version_id:string;turn_id:string|null;reply_request_id:string|null;
 candidate_id:string|null;version_id:string|null;parent_version_id:string|null;candidate_number:number|null;version_number:number|null;
 is_default_display:boolean;is_explicitly_selected:boolean;basis_changes:Change[];
}
export interface ReplyDiscussionContext {
 scope:AssistantScope;session_id:string;request_key:string;current_input_version_id:string;items:DiscussionItem[];
 snapshot:Record<string,any>;notice:string;
}
export interface AssistantDiscussionPayload {
 session_id:string;request_key:string;current_input_version_id:string;factual_role:'assistant_discussion_reference';weight:'low';notice:string;
 items:(Omit<DiscussionItem,'basis_changes'> & {role:'assistant_candidate'|'user';is_sent:false;basis_changes?:Change[]})[];
}
export interface ContinuationReferencePayload {
 candidate_id:string;version_id:string;is_current_draft:boolean;messages?:{message_id:string;text:string}[];
 factual_role:'previous_assistant_candidate';weight:'low';basis_changes?:Change[];notice:string;
}
export const DISCUSSION_NOTICE='以下是当前助手会话的历史讨论和旧候选，仅作低权重参考，不是关系事实。历史用户要求与当前明确意愿冲突时，以当前意愿为准；旧AI候选不代表用户采用或发送。';
const reject=():never=>{throw new ReplyStoreError('reply_context_invalidated');};
const unique=(ids:Iterable<string>)=>[...new Set(ids)].sort();
const same=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const eligibilityError=(e:unknown)=>['reply_context_invalidated','reply_input_invalidated','reply_context_unavailable','assistant_erasure_identity_invalid'].includes((e as {code?:string})?.code??'');
function item(kind:DiscussionKind,text:string,input:string,fields:Partial<DiscussionItem>={}):DiscussionItem {
 return {kind,text,input_version_id:input,turn_id:null,reply_request_id:null,candidate_id:null,version_id:null,parent_version_id:null,candidate_number:null,version_number:null,is_default_display:false,is_explicitly_selected:false,basis_changes:[],...fields};
}
function messages(value:unknown):{message_id:string;text:string}[] {
 if(!Array.isArray(value)||!value.length||value.length>8)reject();
 const result=(value as Row[]).map(m=>{if(typeof m?.message_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(m.message_id)||typeof m.text!=='string'||!m.text.trim())reject();return {message_id:m.message_id,text:m.text};});
 if(new Set(result.map(m=>m.message_id)).size!==result.length)reject();return result;
}
/** 调用方传入同一业务事务client；所有资格端口必须实际实现，不能默认成功。 */
export class PostgresReplyDiscussionContext {
 private readonly guards:ReplyAssistantGuards;
 private readonly ports:ReplyAssistantPorts;
 private readonly requireRuntimeMaterials?: (client:pg.Client,scope:AssistantScope,row:Row)=>Promise<void>;
 private readonly selectedReference?:{candidate_id:string;version_id:string};
 private readonly metadataOnly?:((client:pg.Client,identity:ReplyPreparationIdentity)=>Promise<boolean>);
 constructor(options:{guards:ReplyAssistantGuards;ports:ReplyAssistantPorts;selectedReference?:{candidate_id:string;version_id:string};requireRuntimeMaterials?:(client:pg.Client,scope:AssistantScope,row:Row)=>Promise<void>;metadataOnly?:(client:pg.Client,identity:ReplyPreparationIdentity)=>Promise<boolean>}) {this.requireRuntimeMaterials=options.requireRuntimeMaterials;this.guards=options.guards;this.ports=options.ports;this.metadataOnly=options.metadataOnly;this.selectedReference=options.selectedReference;}
 async read(client:pg.Client,request:ReplyStoreRequest):Promise<ReplyDiscussionContext|null> {return this.build(client,request);}
 async readPreparation(client:pg.Client,identity:ReplyPreparationIdentity):Promise<ReplyDiscussionContext>{const result=await this.build(client,{...identity,request_id:null});if(!result)reject();return result!;}
 async validatePreparation(client:pg.Client,identity:ReplyPreparationIdentity,discussion:ReplyDiscussionContext|null):Promise<void>{if(discussion===null)reject();await this.validate(client,{...identity,request_id:null},discussion);}
 async preparationDependencies(client:pg.Client,identity:ReplyPreparationIdentity,discussion:ReplyDiscussionContext):Promise<string[]>{
   await this.validatePreparation(client,identity,discussion);
   const rows=new Map((await inputRows(client,identity.owner_id,identity.contact_id,discussion.session_id)).map(r=>[r.id,r]));
   const deps=new Set<string>();
   for(const record of discussion.snapshot.records){const row=rows.get(record.input_version_id);if(!row)reject();for(const id of record.kind==='discussion_input'?row!.dependency_ids:await generationDependencies(client,identity.owner_id,identity.contact_id,row!))deps.add(id);}
   return unique(deps);
 }
 async validateCurrent(client:pg.Client,request:ReplyStoreRequest,discussion:ReplyDiscussionContext|null):Promise<void> {
   await this.validate(client,request,discussion);
 }
 private async validate(client:pg.Client,request:DiscussionRequest,discussion:ReplyDiscussionContext|null):Promise<void> {
   if(discussion===null){if(await this.build(client,request)!==null)reject();return;}
   if(!same(discussion.scope,{owner_id:request.owner_id,contact_id:request.contact_id})||discussion.request_key!==request.idempotency_key)reject();
   snapshot(discussion.snapshot,request.owner_id,request.contact_id,request.idempotency_key);
   const current=await this.build(client,request,discussion.snapshot);
   if(!current||!same(current.snapshot,discussion.snapshot))reject();
   // 展示/选择标记可随后变化；实际传给模型的正文仍必须逐项相同。
   const identity=(i:DiscussionItem)=>[i.kind,i.input_version_id,i.turn_id,i.reply_request_id,i.candidate_id,i.version_id,i.parent_version_id,i.candidate_number,i.version_number,i.text,i.basis_changes];
   if(!same(current!.items.map(identity),discussion.items.map(identity)))reject();
 }
 private async generation(client:pg.Client,scope:AssistantScope,row:Row):Promise<string[]> {
   if(row.state!=='active'||!['running','failed','completed'].includes(row.turn_state)||row.input_payload===null)reject();
   await this.ports.requireDependencies(client,scope,row.turn_dependencies??[],true);
   if(row.reply_request_id){await this.ports.requireSavedSkillPolicy(client,scope,row.reply_request_id);await this.ports.requireReplySourcesCurrent(client,scope,row.reply_request_id,true);}
   else if(row.turn_state==='completed')reject();
   const deps=await generationDependencies(client,scope.owner_id,scope.contact_id,row);
   await this.ports.requireGenerationMemoryDependencies(client,scope,deps);
   await this.guards.verifiedDiscussionDependencies(client,scope,deps,true);await this.requireRuntimeMaterials?.(client,scope,row);return deps;
 }
 private async versions(client:pg.Client,scope:AssistantScope,row:Row,candidateId?:string):Promise<Row[]> {
   const candidates=(await client.query(`SELECT c.* FROM reply_candidate c JOIN reply_request r ON r.id=c.reply_request_id AND r.owner_id=c.owner_id AND r.contact_id=c.contact_id AND r.conversation_binding_id=c.conversation_binding_id
     WHERE c.owner_id=$1 AND c.contact_id=$2 AND c.reply_request_id=$3 AND c.conversation_binding_id=$4 AND ($5::uuid IS NULL OR c.id=$5)
     AND NOT EXISTS(SELECT 1 FROM reply_invalidated_key k WHERE k.owner_id=r.owner_id AND k.contact_id=r.contact_id AND k.idempotency_key=r.idempotency_key) ORDER BY c.ordinal,c.id`,[scope.owner_id,scope.contact_id,row.reply_request_id,row.conversation_binding_id,candidateId??null])).rows;
   const result:Row[]=[];
   for(const c of candidates){
     const versions=(await client.query('SELECT * FROM assistant_candidate_version WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND turn_id=$4 AND candidate_id=$5 ORDER BY version_number',[scope.owner_id,scope.contact_id,row.session_id,row.turn_id,c.id])).rows;
     if(!versions.length||versions[0].version_number!==0)versions.unshift({id:c.id,version_number:0,parent_version_id:null,requirements:null});
     const selected=(await client.query('SELECT version_id FROM assistant_candidate_selection WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND candidate_id=$4 AND is_current',[scope.owner_id,scope.contact_id,row.session_id,c.id])).rows[0]?.version_id??null;
     const basis=await this.ports.readReplyBasisChanges(client,scope,c.reply_request_id);
     for(const v of versions)result.push({...v,messages:messages(v.version_number===0?c.message_group:v.message_group),candidate_id:c.id,candidate_number:c.ordinal+1,request_id:c.reply_request_id,default_id:versions.at(-1)!.id,selected_id:selected,basis_changes:basis});
   }return result;
 }
 private async carry(client:pg.Client,scope:AssistantScope,row:Row):Promise<DiscussionItem> {
   const edge=(await carryEdges(client,scope.owner_id,row.id)).find(e=>e.child===row.id);if(!edge)reject();const origin=row.content;
   const parent=(await inputRows(client,scope.owner_id,scope.contact_id,origin.origin_session_id)).find(r=>r.id===origin.origin_input_version_id);
   if(!parent||parent.turn_id!==origin.origin_turn_id||parent.reply_request_id!==origin.origin_reply_request_id||parent.conversation_binding_id!==row.conversation_binding_id||parent.turn_state!=='completed'||parent.request_state!=='completed')reject();
   const deps=await this.generation(client,scope,parent!);
   const verified=await this.guards.verifiedDiscussionDependencies(client,scope,deps,true);if(!same(unique(verified),unique(row.dependency_ids)))reject();
   const v=(await this.versions(client,scope,parent!,origin.origin_candidate_id)).find(v=>v.id===origin.origin_version_id);if(!v)reject();
   return item('candidate_carry',canonical({messages:v!.messages}),row.id,{turn_id:parent!.turn_id,reply_request_id:parent!.reply_request_id,candidate_id:v!.candidate_id,version_id:v!.id,parent_version_id:v!.parent_version_id,candidate_number:v!.candidate_number,version_number:v!.version_number,is_explicitly_selected:true,basis_changes:v!.basis_changes});
 }
 /** 会话级有效业务投影不依赖新生成锚点；恢复引用绝不伪造请求或候选。 */
 async readSession(client:pg.Client,scope:AssistantScope,sessionId:string,binding:string,excludeRequestKey?:string):Promise<{items:DiscussionItem[];records:Row[];basis:Set<string>}> {
  return withReplyValidationScope(client,scope,async()=>{
   await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${scope.owner_id}`]);
   if(!(await client.query('SELECT 1 FROM assistant_session WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,sessionId])).rowCount)reject();
   if(await this.ports.requireActiveBinding(client,scope)!==binding)reject();
   const rows=await inputRows(client,scope.owner_id,scope.contact_id,sessionId);
   // 身份变化与材料失效不同：旧绑定不能按空历史吞掉。
   if(rows.some(row=>row.conversation_binding_id!==binding))reject();
   const dependencies=unique(rows.filter(row=>row.state==='active').flatMap(row=>[...row.dependency_ids??[],...row.turn_dependencies??[]]));
   if(dependencies.length){const known=(await client.query(`SELECT id FROM source_document WHERE owner_id=$1 AND id=ANY($3::uuid[]) UNION SELECT id FROM local_wechat_observation WHERE owner_id=$1 AND id=ANY($3::uuid[]) UNION SELECT id FROM message WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) UNION SELECT id FROM message_source_ref WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) UNION SELECT id FROM confirmed_memory WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) UNION SELECT id FROM memory_candidate WHERE owner_id=$1 AND contact_id=$2 AND id=ANY($3::uuid[]) UNION SELECT id FROM owner_memory WHERE owner_id=$1 AND id=ANY($3::uuid[]) UNION SELECT id FROM expression_preference WHERE owner_id=$1 AND (contact_id IS NULL OR contact_id=$2) AND id=ANY($3::uuid[]) UNION SELECT id FROM scenario_document_version WHERE owner_id=$1 AND (contact_id IS NULL OR contact_id=$2) AND id=ANY($3::uuid[]) UNION SELECT id FROM layered_profile_version WHERE owner_id=$1 AND (contact_id IS NULL OR contact_id=$2) AND id=ANY($3::uuid[]) UNION SELECT batch_id AS id FROM source_processing_batch WHERE owner_id=$1 AND batch_id=ANY($3::uuid[])`,[scope.owner_id,scope.contact_id,dependencies])).rows;if(known.length!==dependencies.length)reject();}
   const excluded=excludeRequestKey?(await client.query('SELECT input_version_id FROM assistant_session_turn WHERE owner_id=$1 AND contact_id=$2 AND session_id=$3 AND idempotency_key=$4',[scope.owner_id,scope.contact_id,sessionId,excludeRequestKey])).rows[0]?.input_version_id:null;
   return this.assemble(client,scope,rows,excluded??null,false);
  });
 }
 private async assemble(client:pg.Client,scope:AssistantScope,rows:Row[],excludedInput:string|null,metadataOnly:boolean,selected?:Row){
   const items:DiscussionItem[]=[],records:Row[]=[],basis=new Set<string>();
   const wanted=selected?new Set<string>(selected.records.map((r:Row)=>r.input_version_id)):null;
   for(const row of rows){
     if(row.id===excludedInput||wanted&&!wanted.has(row.id))continue;
     const identity=(kind:string,hash:string,fields:Row={})=>({kind,input_version_id:row.id,payload_sha256:hash,turn_id:null,candidate_id:null,version_id:null,...fields});
     if(row.input_type!=='generation'){
       if(row.state!=='active'||row.content===null){if(selected)reject();continue;}
       let discussion:DiscussionItem|undefined;
       try {if(row.input_type==='candidate_carry')discussion=await this.carry(client,scope,row);else{await this.guards.verifiedDiscussionDependencies(client,scope,row.dependency_ids,false);if(!metadataOnly)discussion=item('discussion_input',canonical(row.content),row.id);}}
       catch(e){if(!selected&&eligibilityError(e))continue;throw e;}
       for(const d of row.dependency_ids)basis.add(d);if(discussion&&!metadataOnly)items.push(discussion);
       records.push(identity('discussion_input',fingerprint([row.content,row.conversation_binding_id,unique(row.dependency_ids)])));continue;
     }
     let deps:string[];try{deps=await this.generation(client,scope,row);}catch(e){if(!selected&&eligibilityError(e))continue;throw e;}
     for(const d of deps)basis.add(d);
     if(!selected||selected.records.some((r:Row)=>r.kind==='generation_input'&&r.input_version_id===row.id)){
       if(!metadataOnly)items.push(item('generation_input',canonical(row.input_payload),row.id,{turn_id:row.turn_id,reply_request_id:row.reply_request_id}));
       records.push(identity('generation_input',fingerprint([row.input_payload,row.input_digest,row.conversation_binding_id,row.reply_request_id,deps,[]]),{turn_id:row.turn_id}));
     }
     if(row.turn_state!=='completed'||row.request_state!=='completed')continue;
     for(const v of await this.versions(client,scope,row)){
       if(selected&&!selected.records.some((r:Row)=>r.kind==='candidate_version'&&r.version_id===v.id))continue;
       const text=canonical({messages:v.messages,requirements:v.requirements});
       if(!metadataOnly||this.selectedReference?.candidate_id===v.candidate_id&&this.selectedReference?.version_id===v.id)items.push(item('candidate_version',text,row.id,{turn_id:row.turn_id,reply_request_id:row.reply_request_id,candidate_id:v.candidate_id,version_id:v.id,parent_version_id:v.parent_version_id,candidate_number:v.candidate_number,version_number:v.version_number,is_default_display:v.id===v.default_id,is_explicitly_selected:v.id===v.selected_id,basis_changes:v.basis_changes}));
       records.push(identity('candidate_version',fingerprint([text,v.version_number,v.parent_version_id,row.reply_request_id,v.candidate_number]),{turn_id:row.turn_id,candidate_id:v.candidate_id,version_id:v.id}));
     }
   }
   return {items,records,basis};
 }
 private async build(client:pg.Client,request:DiscussionRequest,selected?:Row):Promise<ReplyDiscussionContext|null> {
   return withReplyValidationScope(client,request,()=>this.buildScoped(client,request,selected));
 }
 private async buildScoped(client:pg.Client,request:DiscussionRequest,selected?:Row):Promise<ReplyDiscussionContext|null> {
   const scope={owner_id:request.owner_id,contact_id:request.contact_id};await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`owner:${scope.owner_id}`]);
   if(request.request_id!==null&&!(await client.query('SELECT 1 FROM reply_request WHERE id=$1 AND owner_id=$2 AND contact_id=$3 AND conversation_binding_id=$4 AND idempotency_key=$5',[request.request_id,scope.owner_id,scope.contact_id,request.conversation_binding_id,request.idempotency_key])).rowCount)reject();
   const anchor=(await client.query(anchorSQL.replace('turn.input_payload,','turn.input_payload::text AS input_payload_text,'),[scope.owner_id,scope.contact_id,request.idempotency_key])).rows[0];
   if(!anchor)return null;
   const pointer=(await client.query('SELECT current_input_version_id FROM assistant_session WHERE owner_id=$1 AND contact_id=$2 AND id=$3',[scope.owner_id,scope.contact_id,anchor.session_id])).rows[0];
   if(pointer?.current_input_version_id!==anchor.input_version_id||anchor.anchor_input_state!=='active'||!['running','failed','completed'].includes(anchor.state)||anchor.input_payload_text===null||anchor.anchor_binding_id!==anchor.conversation_binding_id||anchor.conversation_binding_id!==request.conversation_binding_id||await this.ports.requireActiveBinding(client,scope)!==anchor.conversation_binding_id)reject();
   const rows=await inputRows(client,scope.owner_id,scope.contact_id,anchor.session_id),current=rows.find(r=>r.id===anchor.input_version_id);if(!current)reject();await this.generation(client,scope,current!);
   // 持久运行可用时不构造完整历史 items 或复制进提示；不可变校验仍读取正文并计算指纹。
   // 首次建立及故障重建构造完整 items，明确引用只额外构造所选版本。
   const metadataOnly=await this.metadataOnly?.(client,request)??false;
   const {items,records,basis}=await this.assemble(client,scope,rows,anchor.input_version_id,metadataOnly,selected);
   const snap={version:1,scope,session_id:anchor.session_id,request_key:request.idempotency_key,current_input_version_id:anchor.input_version_id,current_turn_id:anchor.id,current_payload_sha256:fingerprint([anchor.input_digest,legacyJson(anchor.input_payload_text),anchor.conversation_binding_id]),records,basis_revision_sha256:await this.ports.historicalBasisRevision(client,scope,unique(basis))};
   if(request.request_id!==null)await capturedEdges(client,scope.owner_id,request.request_id,snap);
   return {scope,session_id:anchor.session_id,request_key:request.idempotency_key,current_input_version_id:anchor.input_version_id,items,snapshot:snap,notice:DISCUSSION_NOTICE};
 }
}
export function assistantDiscussionPayload(discussion:ReplyDiscussionContext):AssistantDiscussionPayload {
 return {session_id:discussion.session_id,request_key:discussion.request_key,current_input_version_id:discussion.current_input_version_id,factual_role:'assistant_discussion_reference',weight:'low',notice:discussion.notice,items:discussion.items.map(({basis_changes,...i})=>({...i,role:i.kind==='candidate_version'||i.kind==='candidate_carry'?'assistant_candidate':'user',is_sent:false,...(basis_changes.length?{basis_changes}:{})}))};
}
/** 仅接收08认证后的内部身份；完整历史中的不可变版本必须逐字匹配。 */
export function continuationReferencePayload(discussion:ReplyDiscussionContext|null,scope:AssistantScope,continuedCandidateId:string|null,content:{type:string;draft_text?:string},authenticated?:AuthenticatedContinuation):ContinuationReferencePayload|null {
 const ref=authenticated?.continuation_reference;if(!ref)return null;
 if(!discussion||!same(discussion.scope,scope)||ref.candidate_id!==continuedCandidateId)reject();
 const selected=discussion!.items.filter(i=>i.kind==='candidate_version'&&i.candidate_id===ref.candidate_id&&i.version_id===ref.version_id);
 if(selected.length===0&&authenticated?.rollover_reference===true){
  const group=messages(ref.messages),is_current_draft=content.type==='rewrite_draft'&&content.draft_text===group.map(m=>m.text).join('\n\n');
  return {candidate_id:ref.candidate_id,version_id:ref.version_id,is_current_draft,...(is_current_draft?{}:{messages:group}),factual_role:'previous_assistant_candidate',weight:'low',notice:'这是用户本次明确选择的旧候选版本，只参考说法；本次明确意愿优先，不代表已发送或关系事实。'};
 }
 if(selected.length!==1)reject();
 let captured:Row;try{captured=JSON.parse(selected[0]!.text);}catch{reject();}
 const group=messages(ref.messages);if(!same(captured!.messages,group))reject();
 const is_current_draft=content.type==='rewrite_draft'&&content.draft_text===group.map(m=>m.text).join('\n\n');
 return {candidate_id:ref.candidate_id,version_id:ref.version_id,is_current_draft,...(is_current_draft?{}:{messages:group}),factual_role:'previous_assistant_candidate',weight:'low',...(selected[0]!.basis_changes.length?{basis_changes:selected[0]!.basis_changes}:{}),notice:'这是用户本次明确选择的旧候选版本，只参考说法；本次明确意愿优先，不代表已发送或关系事实。'};
}
