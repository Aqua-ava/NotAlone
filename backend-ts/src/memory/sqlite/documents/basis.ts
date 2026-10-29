import type {StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import type {ReplySource} from '../../../reply/sqlite/candidates/contracts.ts';
import type {L2ScenarioMemory,L2ScenarioReference,L2ScenarioVersion} from '../../scenarios/workspace.ts';
import type {L3ProfileDocument,L3ProfileEntry} from '../../profiles/workspace.ts';
import {createHash} from 'node:crypto';
import {assertSourceEligibility} from '../../../history/sqlite/source.ts';
import {qualificationSources,mergeKnowledgeSources} from '../management/dependencies.ts';
import {sourceVerificationState} from '../management/evidence.ts';
import {memoryTimeEligibility} from '../management/temporal.ts';
import {fail,requireVersion} from '../management/qualification.ts';
import {documentActualInputs,type DocumentActualInput} from './inputs.ts';

function safeNumber(value:bigint):number {if(value<0n||value>BigInt(Number.MAX_SAFE_INTEGER))fail('document_revision_invalid');return Number(value);}
function fact(tx:StorageTransaction,ownerId:string,decisionId:string):Record<string,any>|null {
 const row=tx.get(`SELECT e.payload FROM decision_candidate dc JOIN memory_candidate c ON c.owner_id=dc.owner_id AND c.id=dc.candidate_id
  JOIN execution_event e ON e.owner_id=c.owner_id AND e.id=c.event_id WHERE dc.owner_id=? AND dc.decision_id=? ORDER BY c.id LIMIT 1`,[ownerId,decisionId]);
 return row?JSON.parse(String(row.payload)).fact:null;
}
function memorySources(tx:StorageTransaction,ownerId:string,m:StorageRow,v:StorageRow):ReplySource[] {
 const citations=requireVersion(tx,ownerId,m,v);
 if(v.adoption_mode==='auto'&&sourceVerificationState(tx,ownerId,{memoryId:String(m.id),versionNo:v.version_no as bigint})!=='verified')fail('document_memory_unverified');
 return mergeKnowledgeSources(qualificationSources(tx,ownerId,{memoryId:String(m.id),versionNo:v.version_no as bigint}),citations.map(r=>({contactId:String(r.source_contact_id),messageId:String(r.message_id),recordId:String(r.record_id),acceptedRevision:r.accepted_revision as bigint})));
}
export function memoryBasis(tx:StorageTransaction,ownerId:string,m:StorageRow,v:StorageRow):{memory:L2ScenarioMemory;sources:ReplySource[]} {
 if(m.state!=='active'||m.current_version_no!==v.version_no)fail('document_memory_stale');
 const time=memoryTimeEligibility(tx,ownerId,{memoryId:String(m.id),versionNo:v.version_no as bigint});
 if(time==='invalid')fail('document_time_invalid');if(time==='needs_revalidation')fail('document_time_pending');if(time==='out_of_window')fail('document_memory_stale');
 const sources=memorySources(tx,ownerId,m,v);
 const f=fact(tx,ownerId,String(v.decision_id));
 return {memory:{memory_id:String(m.id),revision:safeNumber(v.version_no as bigint),level:m.scope_kind==='self'?'owner':'contact',text:String(v.body),
  category:typeof f?.category==='string'?f.category:'user_memory',provenance_kind:v.adoption_mode==='manual'?'manual_entry':'source_supported',
  timing:{},event:f?.event??null,conditions:f?.conditions??null,evolution:null,valid_at:f?.valid_at??null,invalid_at:f?.invalid_at??null,
  dependency_ids:sources.map(s=>s.recordId),message_ids:[...new Set(sources.map(s=>s.messageId))],dependency_manifest:{}},sources};
}
export function frozenMemories(tx:StorageTransaction,ownerId:string,stepId:string):L2ScenarioMemory[]{
 return tx.all("SELECT * FROM step_input WHERE owner_id=? AND step_id=? AND kind='memory' ORDER BY input_no",[ownerId,stepId]).map(i=>{
  const m=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[ownerId,i.memory_id]),v=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,i.memory_id,i.memory_version_no]);
  if(!m||!v||m.head_revision!==i.accepted_head_revision)fail('document_memory_stale');return memoryBasis(tx,ownerId,m!,v!).memory;
 });
}
export function sourceStillValid(tx:StorageTransaction,ownerId:string,s:ReplySource):void {
 assertSourceEligibility(tx,{owner_id:ownerId,contact_id:s.contactId,message_id:s.messageId,record_id:s.recordId});
 if(!tx.get("SELECT 1 FROM message WHERE owner_id=? AND contact_id=? AND id=? AND interpretation_revision=? AND availability='available'",[ownerId,s.contactId,s.messageId,s.acceptedRevision]))fail('document_source_stale');
}
interface DocumentInspection {sources:ReplySource[];stale:boolean}
/** 旧头修订可标为失效，但仍逐项核验历史版本及实际来源，不能掩盖缺失依据。 */
function inspectActualInputs(tx:StorageTransaction,ownerId:string,actual:DocumentActualInput[],visited:Set<string>,cache:Map<string,DocumentInspection>):DocumentInspection {
 const sources:ReplySource[]=[];let stale=false;
 for(const {row:i} of actual){
  if(i.kind==='memory'){
   const m=tx.get('SELECT * FROM memory WHERE owner_id=? AND id=?',[ownerId,i.memory_id]),v=tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? AND version_no=?',[ownerId,i.memory_id,i.memory_version_no]);
   if(!m||!v)fail('document_basis_missing');
   if(m!.state!=='active'||m!.current_version_no!==v!.version_no||m!.head_revision!==i.accepted_head_revision)stale=true;
   const time=memoryTimeEligibility(tx,ownerId,{memoryId:String(m!.id),versionNo:v!.version_no as bigint});
   if(time==='invalid')fail('document_time_invalid');if(time==='needs_revalidation')fail('document_time_pending');if(time==='out_of_window')stale=true;
   sources.push(...memorySources(tx,ownerId,m!,v!));
  }else if(i.kind==='document'){
   const dependency=inspectDocument(tx,ownerId,String(i.document_id),i.document_version_no as bigint,new Set(visited),cache);
   stale||=dependency.stale;sources.push(...dependency.sources);
  }
 }
 return {sources:mergeKnowledgeSources(sources),stale};
}
/** 记录实际材料的传递来源；原始消息本身不因此成为模型输入。 */
export function actualInputSources(tx:StorageTransaction,ownerId:string,actual:DocumentActualInput[]):ReplySource[]{
 const result=inspectActualInputs(tx,ownerId,actual,new Set(),new Map());if(result.stale)fail('document_memory_stale');return result.sources;
}
/** 同时核对历史图完整性和当前记忆资格；两者不能互相代替。 */
function inspectDocument(tx:StorageTransaction,ownerId:string,documentId:string,versionNo:bigint,visited:Set<string>,cache:Map<string,DocumentInspection>):DocumentInspection {
 const key=JSON.stringify([documentId,String(versionNo)]);if(visited.has(key))fail('document_dependency_cycle');visited.add(key);
 const cached=cache.get(key);if(cached){visited.delete(key);return cached;}
 const v=tx.get(`SELECT v.*,s.id AS step_id,s.state AS step_state,a.state AS attempt_state FROM memory_document_version v
  JOIN step_attempt a ON a.owner_id=v.owner_id AND a.id=v.produced_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id
  WHERE v.owner_id=? AND v.document_id=? AND v.version_no=?`,[ownerId,documentId,versionNo]);
 if(!v||v.content_state!=='present'||v.step_state!=='succeeded'||v.attempt_state!=='succeeded')fail('document_unavailable');
 const sources:ReplySource[]=[];let stale=false;const events=tx.all(`SELECT e.*,o.input_seal FROM execution_event e JOIN model_call c ON c.owner_id=e.owner_id AND c.id=e.originated_call_id
  JOIN model_operation o ON o.owner_id=c.owner_id AND o.id=c.operation_id WHERE e.owner_id=? AND e.step_attempt_id=? AND e.kind='document_input' ORDER BY e.event_no`,[ownerId,v!.produced_attempt_id]);
 if(!events.length)fail('document_input_incomplete');
 const compare=(eventId:string,expected:DocumentActualInput[])=>{
  const saved=tx.all('SELECT * FROM execution_input WHERE owner_id=? AND event_id=? ORDER BY presentation_no',[ownerId,eventId]);
  if(saved.length!==expected.length||saved.some((x,index)=>x.planned_step_id!==v!.step_id||x.planned_input_no!==expected[index]?.row.input_no||x.role!==expected[index]?.role||x.presentation_no!==BigInt(index+1)))fail('document_input_incomplete');
 };
 for(const event of events){
  const request=JSON.parse(String(event.payload));
  if(createHash('sha256').update(JSON.stringify(request)).digest('hex')!==event.input_seal)fail('document_input_incomplete');
  const actual=documentActualInputs(tx,ownerId,String(v!.step_id),request);compare(String(event.id),actual);
  const outputs=tx.all("SELECT id FROM execution_event WHERE owner_id=? AND step_attempt_id=? AND kind='document_output' AND originated_call_id=?",[ownerId,v!.produced_attempt_id,event.originated_call_id]);
  if(outputs.length!==1)fail('document_input_incomplete');compare(String(outputs[0]!.id),actual);
  const inspected=inspectActualInputs(tx,ownerId,actual,visited,cache),expectedSources=inspected.sources,keys=expectedSources.map(source=>JSON.stringify([source.contactId,source.recordId])).sort();
  stale||=inspected.stale;
  for(const id of [String(event.id),String(outputs[0]!.id)]){
   const saved=tx.all('SELECT source_contact_id,record_id FROM event_source WHERE owner_id=? AND event_id=?',[ownerId,id]).map(row=>JSON.stringify([String(row.source_contact_id),String(row.record_id)])).sort();
   if(JSON.stringify(saved)!==JSON.stringify(keys))fail('document_input_incomplete');
  }
  sources.push(...expectedSources);
 }
 const statements=tx.all('SELECT * FROM document_statement WHERE owner_id=? AND document_id=? AND version_no=?',[ownerId,documentId,versionNo]);
 if(!statements.length||statements.some(s=>!tx.get('SELECT 1 FROM document_basis WHERE owner_id=? AND document_id=? AND version_no=? AND block_no=? AND statement_no=?',[ownerId,documentId,versionNo,s.block_no,s.statement_no])))fail('document_basis_missing');
 const missing=tx.get(`SELECT 1 FROM document_basis b LEFT JOIN execution_event output ON output.owner_id=b.owner_id AND output.id=b.event_id
  LEFT JOIN execution_input used ON used.owner_id=b.owner_id AND used.event_id=b.event_id AND used.input_no=b.input_no
  WHERE b.owner_id=? AND b.document_id=? AND b.version_no=? AND NOT EXISTS(
   SELECT 1 FROM execution_event input JOIN execution_input x ON x.owner_id=input.owner_id AND x.event_id=input.id
   WHERE input.owner_id=output.owner_id AND input.step_attempt_id=output.step_attempt_id AND input.kind='document_input'
    AND input.originated_call_id=output.originated_call_id AND x.planned_step_id=used.planned_step_id AND x.planned_input_no=used.planned_input_no) LIMIT 1`,[ownerId,documentId,versionNo]);
 if(missing)fail('document_basis_missing');
 const result={sources:mergeKnowledgeSources(sources),stale};visited.delete(key);cache.set(key,result);return result;
}
/** 校验完成文档实际输入及其传递来源；不把重新选择的record替换为原证明。 */
export function documentSources(tx:StorageTransaction,ownerId:string,documentId:string,versionNo:bigint,visited=new Set<string>(),cache=new Map<string,ReplySource[]>()):ReplySource[]{
 const key=JSON.stringify([documentId,String(versionNo)]);if(visited.has(key))fail('document_dependency_cycle');
 const cached=cache.get(key);if(cached)return cached;
 const inspected=new Map<string,DocumentInspection>(),result=inspectDocument(tx,ownerId,documentId,versionNo,visited,inspected);
 if(result.stale)fail('document_memory_stale');
 for(const [id,value] of inspected)if(!value.stale)cache.set(id,value.sources);
 return result.sources;
}
export function publicationDigest(members:readonly {documentId:string;versionNo:bigint}[]):string {
 const sorted=members.map(m=>[m.documentId,String(m.versionNo)]).sort((a,b)=>a[0]!.localeCompare(b[0]!));
 return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}
function publicationStructure(tx:StorageTransaction,ownerId:string,publicationId:string,scopeKind:string,contactId:string|null):{publication:StorageRow;members:StorageRow[]} {
 const p=tx.get('SELECT * FROM document_publication WHERE owner_id=? AND id=? AND scope_kind=? AND contact_id IS ?',[ownerId,publicationId,scopeKind,contactId]);
 if(!p)fail('document_publication_unavailable');
 const rows=tx.all(`SELECT m.*,d.kind,d.scope_kind,d.contact_id,d.state,v.version_identity,v.title,v.hint,v.topic_key,v.content_state
  FROM publication_member m JOIN memory_document d ON d.owner_id=m.owner_id AND d.id=m.document_id JOIN memory_document_version v ON v.owner_id=m.owner_id AND v.document_id=m.document_id AND v.version_no=m.version_no
  WHERE m.owner_id=? AND m.publication_id=? ORDER BY d.kind,d.id`,[ownerId,publicationId]);
 if(p!.member_count!==BigInt(rows.length)||p!.members_digest!==publicationDigest(rows.map(row=>({documentId:String(row.document_id),versionNo:row.version_no as bigint}))))fail('document_publication_incomplete');
 for(const row of rows)if(row.scope_kind!==scopeKind||row.contact_id!==contactId||row.state!=='active'||row.content_state!=='present')fail('document_publication_unavailable');
 return {publication:p!,members:rows};
}
export function publicationMembers(tx:StorageTransaction,ownerId:string,publicationId:string,scopeKind:string,contactId:string|null,cache=new Map<string,ReplySource[]>()):StorageRow[]{
 const {publication,members}=publicationStructure(tx,ownerId,publicationId,scopeKind,contactId);
 if(publication.availability!=='available')fail('document_publication_unavailable');
 for(const row of members)documentSources(tx,ownerId,String(row.document_id),row.version_no as bigint,new Set(),cache);
 return members;
}
/** 先核验整个旧发布集合，再按本轮固定的联系人范围筛选可继承版本。 */
export function eligiblePriorMembers(tx:StorageTransaction,ownerId:string,t:StorageRow):StorageRow[]{
 if(t.accepted_publication_id===null)return [];
 const {publication,members}=publicationStructure(tx,ownerId,String(t.accepted_publication_id),String(t.scope_kind),t.contact_id as string|null);
 if(publication.availability!=='available')return [];
 const cache=new Map<string,DocumentInspection>(),checked=members.map(member=>({member,inspection:inspectDocument(tx,ownerId,String(member.document_id),member.version_no as bigint,new Set(),cache)}));
 const contributions=new Set(tx.all('SELECT source_contact_id FROM task_contribution WHERE owner_id=? AND task_id=?',[ownerId,t.id]).map(c=>String(c.source_contact_id)));
 return checked.filter(({inspection})=>!inspection.stale&&inspection.sources.every(source=>contributions.has(source.contactId))).map(({member})=>member);
}
function references(tx:StorageTransaction,ownerId:string,row:StorageRow,memories:L2ScenarioMemory[]):L2ScenarioReference[]{
 const byId=new Map(memories.map(m=>[`${m.memory_id}:${m.revision}`,m]));
 return tx.all(`SELECT DISTINCT i.memory_id,i.memory_version_no FROM document_basis b JOIN execution_input x ON x.owner_id=b.owner_id AND x.event_id=b.event_id AND x.input_no=b.input_no
  JOIN step_input i ON i.owner_id=x.owner_id AND i.step_id=x.planned_step_id AND i.input_no=x.planned_input_no
  WHERE b.owner_id=? AND b.document_id=? AND b.version_no=? AND b.block_no=? AND b.statement_no=? AND i.kind='memory' ORDER BY i.memory_id`,[ownerId,row.document_id,row.version_no,row.block_no,row.statement_no]).map(r=>{
   const m=byId.get(`${r.memory_id}:${r.memory_version_no}`);if(!m)fail('document_memory_stale');
   return {memory_id:m!.memory_id,revision:m!.revision,level:m!.level,provenance_kind:m!.provenance_kind,timing:m!.timing,event:m!.event,conditions:m!.conditions,evolution:m!.evolution,valid_at:m!.valid_at,invalid_at:m!.invalid_at};
  });
}
export function renderDocuments(tx:StorageTransaction,ownerId:string,members:StorageRow[],memories:L2ScenarioMemory[]):{scenarios:L2ScenarioVersion[];profile:L3ProfileDocument|null;documents:any[]} {
 const scenarios:L2ScenarioVersion[]=[],documents:any[]=[];let profile:L3ProfileDocument|null=null;
 for(const v of members){
  const statements=tx.all('SELECT * FROM document_statement WHERE owner_id=? AND document_id=? AND version_no=? ORDER BY block_no,statement_no',[ownerId,v.document_id,v.version_no]);
  const rows=statements.map(s=>({text:String(s.body),kind:String(s.kind),basis:s.rationale===null?null:String(s.rationale),section:s.section===null?null:String(s.section),uncertainty:s.uncertainty===null?null:String(s.uncertainty),temporalStatus:s.temporal_status===null?null:String(s.temporal_status),leftClaim:s.left_claim===null?null:String(s.left_claim),rightClaim:s.right_claim===null?null:String(s.right_claim),resolutionState:s.resolution_state===null?null:String(s.resolution_state),resolutionText:s.resolution_text===null?null:String(s.resolution_text),references:references(tx,ownerId,s,memories)}));
  const displayRows=rows.map(row=>({...row,references:row.references.map(ref=>{
   const memory=memories.find(m=>m.memory_id===ref.memory_id&&m.revision===ref.revision);if(!memory)fail('document_memory_stale');
   return {...ref,memoryText:memory!.text};
  })}));
  documents.push({id:String(v.document_id),versionNo:String(v.version_no),scopeKind:String(v.scope_kind),contactId:v.contact_id===null?null:String(v.contact_id),kind:String(v.kind),title:String(v.title),statements:displayRows});
  if(v.kind==='scene')scenarios.push({scenario_id:String(v.document_id),version_id:String(v.version_identity),title:String(v.title),hint:String(v.hint),paragraphs:rows.map(r=>({text:r.text,references:r.references})),input_manifest:[],dependency_ids:[]});
  else {
   if(profile)fail('document_multiple_profiles');
   profile={version_id:String(v.version_identity),entries:rows.map((r,index)=>({text:r.text,kind:String(statements[index]!.profile_kind) as L3ProfileEntry['kind'],section:r.section as L3ProfileEntry['section'],basis:r.basis??'',temporal_status:r.temporalStatus as L3ProfileEntry['temporal_status'],uncertainty:r.uncertainty??'',references:r.references}))};
  }
 }
 return {scenarios,profile,documents};
}
