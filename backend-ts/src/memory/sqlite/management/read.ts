import {archivedExtractionOutput} from '../outputs.ts';
import {sourceVerificationState} from './evidence.ts';
import {memoryTimeEligibility} from './temporal.ts';
import {qualificationSources,qualificationSourceRows,frozenContributingContactIds} from './dependencies.ts';
import type {StorageRow,StorageTransaction} from '../../../storage/sqlite/contracts.ts';
import {available,citations,fail,id,requireCandidate,requireSources,requireVersion,scope} from './qualification.ts';
import type {MemoryCandidateView,MemoryManagementView,MemoryScope,MemorySource,MemoryVersionView,MemoryView,MemoryHistoryView} from './contracts.ts';
import {citationContent} from '../content-citation.ts';
import {decodePage,encodePage,managementPageSize,pageScope} from './pagination.ts';
import {assertSourceEligibility,eligibleSourceReferences,type SourceEligibility} from '../../../history/sqlite/source.ts';
import {assertReplyLocalSource,eligibleReplyLocalSourceReferences} from '../../../history/sqlite/reply-local-source.ts';
import type {MessageSourceReference} from '../../../history/sqlite/contracts.ts';
interface PageSources {current:SourceEligibility;saved:SourceEligibility}
/** 只保存本页身份与资格集合；跨请求重建，不缓存正文或放宽任何逐项复验。 */
function pageSources(tx:StorageTransaction,ownerId:string,parents:{candidateId?:string;memoryId?:string;versionNo?:bigint}[]):PageSources {
 const refs=new Map<string,MessageSourceReference>();
 const key=(ref:MessageSourceReference)=>JSON.stringify([ref.owner_id,ref.contact_id,ref.record_id,ref.message_id]);
 for(const parent of parents){
  const rows=[...qualificationSourceRows(tx,ownerId,parent),...tx.all(`SELECT source_contact_id,message_id,record_id FROM memory_citation WHERE owner_id=? AND ${parent.candidateId?'candidate_id=?':'memory_id=? AND version_no=?'}`,parent.candidateId?[ownerId,parent.candidateId]:[ownerId,parent.memoryId!,parent.versionNo!])];
  for(const row of rows){const ref={owner_id:ownerId,contact_id:String(row.source_contact_id),message_id:String(row.message_id),record_id:String(row.record_id)};refs.set(key(ref),ref);}
 }
 const wanted=[...refs.values()],current=new Set(eligibleSourceReferences(tx,wanted).map(key)),saved=new Map<string,Set<string>>();
 return {current:(_tx,ref)=>{if(!current.has(key(ref)))fail('history_source_not_available');},saved:(_tx,ref)=>{
  const contact=JSON.stringify([ref.owner_id,ref.contact_id]);let eligible=saved.get(contact);
  if(!eligible){eligible=new Set(eligibleReplyLocalSourceReferences(tx,wanted.filter(r=>r.owner_id===ref.owner_id&&r.contact_id===ref.contact_id)).map(key));saved.set(contact,eligible);}
  if(!eligible.has(key(ref)))fail('history_source_not_available');
 }};
}
export function sourceViews(rows:StorageRow[]):MemorySource[]{return rows.map(r=>({contactId:String(r.source_contact_id),messageId:String(r.message_id),recordId:String(r.record_id),acceptedRevision:String(r.accepted_revision),
 sentAt:r.sent_at===null?null:String(r.sent_at),timePrecision:r.time_precision as MemorySource['timePrecision'],
 ...(r.content_kind==='image'?{quote:'',contentKind:'image' as const,contentRef:citationContent(r).contentRef!,description:String(r.explanation??'')}:{quote:[...String(r.text_body)].slice(Number(r.span_start),Number(r.span_end)).join('')})}));}
function mergeParents(tx:StorageTransaction,ownerId:string,decisionId:string){
 return tx.all("SELECT m.id,m.current_version_no,m.head_revision FROM memory_decision r JOIN memory_decision d ON d.owner_id=r.owner_id AND d.execution_id=r.execution_id JOIN memory m ON m.owner_id=r.owner_id AND m.id=r.target_memory_id WHERE d.owner_id=? AND d.id=? AND d.action='auto_update' AND r.action='auto_retire' AND r.actor_kind='system' AND r.outcome='applied' ORDER BY m.id",[ownerId,decisionId]).map(m=>({memoryId:String(m.id),versionNo:String(m.current_version_no),headRevision:String(m.head_revision)}));
}
/** sourceEligibility 默认要求当前读取授权；读取授权暂时不可用时由 checkedVersion 改用已保存来源的资格（与回复一致）。 */
export function versionView(tx:StorageTransaction,ownerId:string,v:StorageRow,sourceEligibility:SourceEligibility=assertSourceEligibility):MemoryVersionView{const parents=mergeParents(tx,ownerId,String(v.decision_id));if(v.content_state==='present')qualificationSources(tx,ownerId,{memoryId:String(v.memory_id),versionNo:v.version_no as bigint},sourceEligibility);return {timeStatus:v.content_state==='present'?memoryTimeEligibility(tx,ownerId,{memoryId:String(v.memory_id),versionNo:v.version_no as bigint}):'invalid',mergeParents:parents,mergeParentCount:parents.length?parents.length+1:0,verificationState:v.content_state==='present'?sourceVerificationState(tx,ownerId,{memoryId:String(v.memory_id),versionNo:v.version_no as bigint},sourceEligibility):'pending',versionNo:String(v.version_no),body:v.body as string|null,formationKind:String(v.formation_kind),adoptionMode:String(v.adoption_mode),previousVersionNo:v.previous_version_no===null?null:String(v.previous_version_no),restoredFromVersionNo:v.restored_from_version_no===null?null:String(v.restored_from_version_no),contentState:String(v.content_state),provenanceState:String(v.provenance_state),decisionId:String(v.decision_id),contributingContactIds:v.content_state==='present'?frozenContributingContactIds(tx,ownerId,{memoryId:String(v.memory_id),versionNo:v.version_no as bigint}):[],sources:sourceViews(citations(tx,ownerId,{memoryId:String(v.memory_id),versionNo:v.version_no as bigint},sourceEligibility))};}

/** pending 候选的派生状态：有裁决原因或门槛留痕才是真待确认；无结果且无留痕按处理未完成呈现（查询层派生，不改表）。 */
function pendingDerivation(tx:StorageTransaction,ownerId:string,c:StorageRow):{stage:'decision_pending'|'processing_incomplete';reason:string|null}{
 const result=tx.get(`SELECT e.payload FROM execution_event e
  JOIN step_attempt a ON a.owner_id=e.owner_id AND a.id=e.step_attempt_id
  JOIN step_input i ON i.owner_id=a.owner_id AND i.step_id=a.step_id AND i.kind='candidate' AND i.candidate_id=?
  WHERE e.owner_id=? AND e.kind='adjudication_result' ORDER BY e.rowid DESC LIMIT 1`,[String(c.id),ownerId]);
 if(result){const value=JSON.parse(String(result.payload));return value.reason?{stage:'decision_pending',reason:String(value.reason)}:{stage:'processing_incomplete',reason:null};}
 const passed=tx.get(`SELECT 1 FROM step_input i JOIN processing_step s ON s.owner_id=i.owner_id AND s.id=i.step_id WHERE i.owner_id=? AND i.kind='candidate' AND i.candidate_id=? AND s.kind='adjudication' LIMIT 1`,[ownerId,String(c.id)]);
 if(passed)return {stage:'processing_incomplete',reason:null};
 const gate=tx.get("SELECT kind FROM execution_event WHERE owner_id=? AND step_attempt_id=? AND kind IN ('memory_conditions_pending','memory_ambiguity_unconfirmed') ORDER BY event_no LIMIT 1",[ownerId,String(c.produced_attempt_id)]);
 if(gate)return {stage:'decision_pending',reason:String(gate.kind)};
 return {stage:'processing_incomplete',reason:null};
}
function candidateView(tx:StorageTransaction,ownerId:string,s:MemoryScope,c:StorageRow,sourceEligibility:SourceEligibility=assertSourceEligibility):MemoryCandidateView|null {
 if(!['pending','adopted','rejected','duplicate'].includes(String(c.state)))return null;
 let verificationState:'verified'|'pending';
 try{
  if(c.state==='pending')verificationState=requireCandidate(tx,ownerId,c,sourceEligibility).state;
  else{
   const out=archivedExtractionOutput(tx,{ownerId,eventId:String(c.event_id)},sourceEligibility);
   if(out.proposedBody!==c.proposed_body||out.producedAttemptId!==c.produced_attempt_id||out.scopeKind!==c.scope_kind||out.contactId!==c.contact_id||out.outputNo!==c.output_no)fail('memory_candidate_stale');
   requireSources(tx,ownerId,{candidateId:String(c.id)},false,sourceEligibility);verificationState=out.semanticVerification.state;
  }
  qualificationSources(tx,ownerId,{candidateId:String(c.id)},sourceEligibility);
  const pendingFields=String(c.state)==='pending'?(()=>{const pending=pendingDerivation(tx,ownerId,c);return {pendingStage:pending.stage,pendingReason:pending.reason};})():undefined;
  return {...pendingFields,verificationState,id:String(c.id),scopeKind:s.scopeKind,contactId:s.contactId,body:String(c.proposed_body),state:c.state as MemoryCandidateView['state'],stateRevision:String(c.state_revision),eventId:String(c.event_id),contributingContactIds:frozenContributingContactIds(tx,ownerId,{candidateId:String(c.id)}),sources:sourceViews(citations(tx,ownerId,{candidateId:String(c.id)},sourceEligibility))};
 }catch{return null;}
}
function checkedVersion(tx:StorageTransaction,ownerId:string,m:StorageRow,v:StorageRow,sources?:PageSources):MemoryVersionView {
 const current=sources?.current??assertSourceEligibility,saved=sources?.saved??assertReplyLocalSource;
 try{if(v.content_state==='present')requireVersion(tx,ownerId,m,v,current);return versionView(tx,ownerId,v,current);}
 catch{
  // 读取授权暂时不可用（如重启后尚未重建）时，已保存且来源仍有效的记忆继续可查看，并标注待重新核验；
  // 来源被删除、隔离、换绑或失证时本地资格同样不通过，仍隐藏正文。写入与实时核验入口保持严格。
  if(v.content_state==='present')try{
   requireVersion(tx,ownerId,m,v,saved);
   return {...versionView(tx,ownerId,v,saved),sourcePendingRecheck:true};
  }catch{/* 本地资格也不通过：按失效处理。 */}
  return {...versionView(tx,ownerId,{...v,body:null,content_state:'redacted'},current),sources:[],provenanceState:'invalidated'};
 }
}
function owned(s:MemoryScope,display:string|null,value:{sources:MemorySource[];contributingContactIds:string[]}):boolean {
 if(display===null)return true;
 return s.scopeKind==='contact'?value.sources.every(source=>source.contactId===display)&&value.contributingContactIds.every(contact=>contact===display)
  :value.sources.length>0&&value.sources.every(source=>source.contactId===display)&&value.contributingContactIds.length===1&&value.contributingContactIds[0]===display;
}
function summary(tx:StorageTransaction,ownerId:string,s:MemoryScope,m:StorageRow,display:string|null,version?:StorageRow|null,sources?:PageSources):MemoryView|null {
 // 撤回项仍需最近版本来调整保护；历史正文只在用户展开后另行分页核验。
 const raw=version===undefined?tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? ORDER BY version_no DESC LIMIT 1',[ownerId,m.id]):version;
 const latest=raw?checkedVersion(tx,ownerId,m,raw,sources):null;
 if(display!==null&&s.scopeKind==='self'&&(!latest||latest.body===null||!owned(s,display,latest)))return null;
 if(latest&&latest.body!==null&&!owned(s,display,latest))return null;
 const current=m.state==='active'&&latest?.versionNo===String(m.current_version_no)&&latest.body!==null&&latest.provenanceState==='eligible'?latest:null;
 return {id:String(m.id),scopeKind:s.scopeKind,contactId:s.contactId,headRevision:String(m.head_revision),state:String(m.state),manualProtection:m.manual_protection===1n,current,versions:latest?[latest]:[],decisions:[]};
}
const maxPageBytes=6*1024*1024;
/** 原稿只随展开的历史读取，按形成该版本的决定关联并重新核验；单次采纳最多 100 条。 */
function originalCandidates(tx:StorageTransaction,ownerId:string,s:MemoryScope,display:string|null,version:MemoryVersionView):MemoryCandidateView[]{
 if(version.body===null)return [];
 const rows=tx.all("SELECT c.* FROM decision_candidate d JOIN memory_candidate c ON c.owner_id=d.owner_id AND c.id=d.candidate_id WHERE d.owner_id=? AND d.decision_id=? AND d.relation_kind='accepted' AND c.scope_kind=? AND c.contact_id IS ? ORDER BY c.id LIMIT 101",[ownerId,version.decisionId,s.scopeKind,s.contactId]);
 if(rows.length>100)fail('memory_item_too_large');
 const candidates:MemoryCandidateView[]=[];let bytes=Buffer.byteLength(JSON.stringify(version));
 for(const row of rows){
  if(row.state!=='adopted')continue;
  const candidate=candidateView(tx,ownerId,s,row);
  if(!candidate||!owned(s,display,candidate))continue;
  bytes+=Buffer.byteLength(JSON.stringify(candidate));if(bytes>maxPageBytes)fail('memory_item_too_large');
  candidates.push(candidate);
 }
 return candidates;
}
interface ListPosition {candidateAfter:string;memoryAfter:string;memoryTime:string|null;candidatesDone:boolean;memoriesDone:boolean}
function listPosition(value:unknown):ListPosition {
 const p=value as ListPosition;
 if(!p||Object.keys(p).sort().join(',')!=='candidateAfter,candidatesDone,memoriesDone,memoryAfter,memoryTime'||typeof p.candidateAfter!=='string'||p.candidateAfter.length>256||typeof p.memoryAfter!=='string'||p.memoryAfter.length>256||p.memoryTime!==null&&(typeof p.memoryTime!=='string'||!/^\d{1,18}$/.test(p.memoryTime))||typeof p.candidatesDone!=='boolean'||typeof p.memoriesDone!=='boolean')fail('memory_page_stale');
 return {...p};
}
/** 只扫描本页的原始身份；来源失效项也推进游标，避免为凑满一页扫描整库。 */
export function managementRead(tx:StorageTransaction,input:unknown):MemoryManagementView {
 const q=input as any,ownerId=id(q?.ownerId),s=scope(q?.scope),context=pageScope(tx,ownerId,s,q.displayContactId);
 if(q.memoryId!==undefined&&q.candidateId!==undefined||q.cursor!==undefined&&(q.memoryId!==undefined||q.candidateId!==undefined))fail('memory_request_invalid');
 if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed'",[ownerId]))return {candidates:[],memories:[],page:{revision:context.revision,nextCursor:null}};
 if(q.memoryId===undefined&&q.candidateId===undefined&&tx.get('SELECT 1 FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND management_timeline_dirty=1 LIMIT 1',[ownerId,s.scopeKind,s.contactId]))return {candidates:[],memories:[],page:{revision:context.revision,nextCursor:null,preparing:true}};
 const position=q.cursor===undefined?{candidateAfter:'',memoryAfter:'',memoryTime:null,candidatesDone:false,memoriesDone:false}:listPosition(decodePage(context,'list',q.cursor));
 const item=q.memoryId!==undefined||q.candidateId!==undefined;
 const candidates:MemoryCandidateView[]=[],memories:MemoryView[]=[];let bytes=0;
 const append=(value:MemoryCandidateView|MemoryView,items:any[]):boolean=>{
  const size=Buffer.byteLength(JSON.stringify(value));if(size>maxPageBytes)fail('memory_item_too_large');
  if(bytes+size>maxPageBytes)return false;items.push(value);bytes+=size;return true;
 };
 const candidateRows=!position.candidatesDone&&q.memoryId===undefined?(q.candidateId===undefined?tx.all("SELECT * FROM memory_candidate WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND state='pending' AND id>? ORDER BY id LIMIT ?",[ownerId,s.scopeKind,s.contactId,position.candidateAfter,managementPageSize+1])
   :tx.all('SELECT * FROM memory_candidate WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND id=?',[ownerId,s.scopeKind,s.contactId,id(q.candidateId)])):[];
 const memoryRows=!position.memoriesDone&&q.candidateId===undefined?(q.memoryId===undefined?tx.all(`SELECT * FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ? ${position.memoryAfter?'AND (-coalesce(management_source_time,-1),id)>(?,?)':''} ORDER BY -coalesce(management_source_time,-1),id LIMIT ?`,[ownerId,s.scopeKind,s.contactId,...(position.memoryAfter?[-BigInt(position.memoryTime??'-1'),position.memoryAfter]:[]),managementPageSize+1])
   :tx.all('SELECT * FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND id=?',[ownerId,s.scopeKind,s.contactId,id(q.memoryId)])):[];
 const latest=memoryRows.slice(0,managementPageSize).map(memory=>({memory,version:tx.get('SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? ORDER BY version_no DESC LIMIT 1',[ownerId,memory.id])??null}));
 const sources=pageSources(tx,ownerId,[...candidateRows.slice(0,managementPageSize).map(c=>({candidateId:String(c.id)})),...latest.flatMap(item=>item.version?[{memoryId:String(item.memory.id),versionNo:item.version.version_no as bigint}]:[])]);
 if(!position.candidatesDone&&q.memoryId===undefined){
  const rows=candidateRows;
  let consumed=0;
  for(const row of rows.slice(0,managementPageSize)){
   const value=candidateView(tx,ownerId,s,row,sources.current);
   if(value&&owned(s,context.displayContactId,value)&&!append(value,candidates))break;
   position.candidateAfter=String(row.id);consumed++;
  }
  position.candidatesDone=consumed===rows.length;
 }
 if(!position.memoriesDone&&q.candidateId===undefined){
  const rows=memoryRows;
  let consumed=0;
  for(const {memory:row,version} of latest){
   const value=summary(tx,ownerId,s,row,context.displayContactId,version,sources);
   if(value&&!append(value,memories))break;
   position.memoryAfter=String(row.id);position.memoryTime=row.management_source_time===null?null:String(row.management_source_time);consumed++;
  }
  position.memoriesDone=consumed===rows.length;
 }
 return {candidates,memories,page:{revision:context.revision,nextCursor:item||position.candidatesDone&&position.memoriesDone?null:encodePage(context,'list',position)}};
}
interface HistoryPosition {beforeVersion:string|null;beforeDecision:{at:string;id:string}|null;versionsDone:boolean;decisionsDone:boolean}
function historyPosition(value:unknown):HistoryPosition {
 const p=value as HistoryPosition;
 if(!p||Object.keys(p).sort().join(',')!=='beforeDecision,beforeVersion,decisionsDone,versionsDone'||p.beforeVersion!==null&&(typeof p.beforeVersion!=='string'||!/^\d{1,18}$/.test(p.beforeVersion))||p.beforeDecision!==null&&(!p.beforeDecision||Object.keys(p.beforeDecision).sort().join(',')!=='at,id'||typeof p.beforeDecision.at!=='string'||!/^\d{1,18}$/.test(p.beforeDecision.at)||typeof p.beforeDecision.id!=='string'||p.beforeDecision.id.length>256)||typeof p.versionsDone!=='boolean'||typeof p.decisionsDone!=='boolean')fail('memory_page_stale');
 return {...p};
}
function decisionView(d:StorageRow):MemoryView['decisions'][number] {
 return {id:String(d.id),action:String(d.action),actorKind:String(d.actor_kind),createdAt:String(d.created_at),expectedHeadRevision:d.expected_head_revision===null?null:String(d.expected_head_revision),expectedVersionNo:d.expected_version_no===null?null:String(d.expected_version_no),outcome:String(d.outcome)};
}
/** 历史分页仍逐版本核验真实来源；当前列表、历史及决定共享同一范围修订。 */
export function managementHistory(tx:StorageTransaction,input:unknown):MemoryHistoryView {
 const q=input as any,ownerId=id(q?.ownerId),s=scope(q?.scope),memoryId=id(q.memoryId),context=pageScope(tx,ownerId,s,q.displayContactId);
 available(tx,ownerId,s,true);
 const m=tx.get('SELECT * FROM memory WHERE owner_id=? AND scope_kind=? AND contact_id IS ? AND id=?',[ownerId,s.scopeKind,s.contactId,memoryId])??fail('memory_scope_stale');
 if(!summary(tx,ownerId,s,m,context.displayContactId))fail('memory_scope_stale');
 const p=q.cursor===undefined?{beforeVersion:null,beforeDecision:null,versionsDone:false,decisionsDone:false}:historyPosition(decodePage(context,`history:${memoryId}`,q.cursor));
 const versions:MemoryVersionView[]=[],decisions:MemoryView['decisions']=[];let bytes=0;
 if(!p.versionsDone){
  const rows=tx.all(`SELECT * FROM memory_version WHERE owner_id=? AND memory_id=? ${p.beforeVersion===null?'':'AND version_no<?'} ORDER BY version_no DESC LIMIT ?`,[ownerId,memoryId,...(p.beforeVersion===null?[]:[BigInt(p.beforeVersion)]),managementPageSize+1]);
  let consumed=0;
  for(const row of rows.slice(0,managementPageSize)){
   const version=checkedVersion(tx,ownerId,m,row);
   if(version.body===null||owned(s,context.displayContactId,version))version.originalCandidates=originalCandidates(tx,ownerId,s,context.displayContactId,version);
   const size=Buffer.byteLength(JSON.stringify(version));if(size>maxPageBytes)fail('memory_item_too_large');
   if(bytes+size>maxPageBytes)break;
   if(version.body===null||owned(s,context.displayContactId,version)){versions.push(version);bytes+=size;}
   p.beforeVersion=String(row.version_no);consumed++;
  }
  p.versionsDone=consumed===rows.length;
 }
 if(!p.decisionsDone){
  const rows=tx.all(`SELECT * FROM memory_decision WHERE owner_id=? AND target_memory_id=? ${p.beforeDecision===null?'':'AND (created_at,id)<(?,?)'} ORDER BY created_at DESC,id DESC LIMIT ?`,[ownerId,memoryId,...(p.beforeDecision===null?[]:[BigInt(p.beforeDecision.at),p.beforeDecision.id]),managementPageSize+1]);
  let consumed=0;
  for(const row of rows.slice(0,managementPageSize)){
   const decision=decisionView(row),size=Buffer.byteLength(JSON.stringify(decision));if(bytes+size>maxPageBytes)break;
   decisions.push(decision);bytes+=size;p.beforeDecision={at:String(row.created_at),id:String(row.id)};consumed++;
  }
  p.decisionsDone=consumed===rows.length;
 }
 return {memoryId,headRevision:String(m.head_revision),versions:versions.reverse(),decisions:decisions.reverse(),revision:context.revision,nextCursor:p.versionsDone&&p.decisionsDone?null:encodePage(context,`history:${memoryId}`,p)};
}
