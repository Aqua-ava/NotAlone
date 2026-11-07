import {getProof,isSourceBlocked,putScope,fenceSource} from './source-proof.ts';
import {getSourceGuard,putSourceGuard,loseSourceGuard} from './source-guard.ts';
import {randomUUID} from 'node:crypto';
import {StorageFailure,type StorageAction,type StorageTransaction,type StorageRow} from '../../storage/sqlite/contracts.ts';
import {assertReadEligibility} from '../../contacts/sqlite/actions.ts';
import type {ReadEligibility} from '../../contacts/sqlite/contracts.ts';
import type {HistorySupportReport,HistoryTarget} from './contracts.ts';
import {assertRecertifyAccess} from './recertify-access.ts';
import {assertHistoryReadBoundary} from './suppression.ts';
import {normalUseContinuity,fenceContinuity,isSourceContinuityLost} from './continuity.ts';
import {auditedCoverageKey,completedLegacyPhysicalKeys,coveredRecallKey,recallCoverageDigest,uncoveredLegacyRecallCandidates,type RecallCoverageMapping} from './legacy-physical-suppression.ts';
import {legacyProofDigest,validateLegacyTerminalProof,type LegacyTerminalProof} from './legacy-terminal-proof.ts';
import {historyRecertifyCandidatesActions} from './recertify-candidates.ts';
import {requestSupersededCleanup} from './superseded-actions.ts';

const fail=(code:string):never=>{throw new StorageFailure(code);};
const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,input:any)=>unknown):StorageAction=>({name:`history.recertify${name}`,mode,retryBusy:true,execute});
const json=(value:unknown)=>JSON.stringify(value,(_k,v)=>typeof v==='bigint'?String(v):v);
const runtime=(tx:StorageTransaction)=>String(tx.get('SELECT runtime_id FROM database_instance WHERE slot=1')!.runtime_id);
const operation=(tx:StorageTransaction,owner:string,id:string):StorageRow=>tx.get('SELECT * FROM history_source_recertification WHERE owner_id=? AND id=?',[owner,id])??fail('history_recertify_not_found');
function pending(tx:StorageTransaction,i:any):StorageRow {
 const op=operation(tx,i.ownerId,i.id);if(tx.get('SELECT 1 FROM history_source_recertification_cancel WHERE owner_id=? AND request_key=?',[i.ownerId,op.request_key]))fail('history_recertify_cancelled');if(op.state!=='running'||op.runtime_id!==runtime(tx))fail('history_recertify_stale');return op;
}
function exactPhysical(old:any,target:HistoryTarget):boolean {
 const sorted=(x:unknown[])=>json([...x].map(x=>json(x)).sort());
 return old.sourceGeneration===target.sourceGeneration&&(!old.checkedPartitions||Boolean(target.checkedPartitions&&sorted(old.checkedPartitions)===sorted([...target.checkedPartitions])))&&sorted(old.partitions)===sorted([...target.partitions])
  &&sorted(old.tables.map((t:any)=>Array.isArray(t)?t:[t.partition,t.instance]))===sorted(target.tables.map(t=>[t.partition,t.instance]));
}
function exactPreviewPhysical(preview:HistoryTarget,target:HistoryTarget):boolean {
 return (preview.checkedPartitions===undefined)===(target.checkedPartitions===undefined)&&exactPhysical(preview,target);
}
/** 新binding从头认证当前完整快照；这不是旧游标或旧目标的增长交接。 */
function containsPriorPhysical(old:any,target:HistoryTarget):boolean {
 const same=(a:string[],b:readonly string[])=>json([...a].sort())===json([...b].sort());
 return old.sourceGeneration===target.sourceGeneration&&Array.isArray(old.checkedPartitions)&&Array.isArray(target.checkedPartitions)
  &&same(old.checkedPartitions,target.checkedPartitions)&&old.partitions.every((p:string)=>target.partitions.includes(p))
  &&old.tables.every((t:[string,string])=>target.tables.some(current=>current.partition===t[0]&&current.instance===t[1]));
}
function scopeReport(tx:StorageTransaction,token:ReadEligibility,report:HistorySupportReport):void {
 const row=tx.get('SELECT a.external_key account_key,c.external_key conversation_key FROM channel_account a JOIN channel_conversation c ON c.owner_id=a.owner_id AND c.account_id=a.id WHERE a.owner_id=? AND a.id=? AND c.id=?',[token.owner_id,token.account_id,token.conversation_id]);
 if(!row||row.account_key!==report.accountKey||row.conversation_key!==report.conversationKey||report.sourceGeneration!==token.source_generation)fail('history_recertify_source_changed');
}
/** 删除身份不能随绑定换代失效；无法映射的抑制使本次认证停下。 */
function mappingProof(tx:StorageTransaction,token:ReadEligibility,target:HistoryTarget,report:HistorySupportReport,op?:StorageRow):LegacyTerminalProof|undefined {
 const audit=op?JSON.parse(String(op.old_fence_json)).legacy_terminal_mapping:undefined;if(!audit)return;
 if(tx.get('SELECT 1 FROM history_source_exclusion WHERE owner_id=? AND conversation_id=? LIMIT 1',[token.owner_id,token.conversation_id])
  ||tx.get('SELECT 1 FROM history_cutoff WHERE owner_id=? AND conversation_id=? LIMIT 1',[token.owner_id,token.conversation_id])
  ||tx.get('SELECT 1 FROM history_deletion_fence WHERE owner_id=? AND contact_id=? LIMIT 1',[token.owner_id,token.contact_id])
  ||tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed' AND scope_kind<>'superseded_history' AND (scope_kind='account' OR contact_identity=?)",[token.owner_id,token.contact_id]))fail('history_recertify_legacy_proof_invalid');
 const old=JSON.parse(String(op!.old_token_json)) as ReadEligibility;
 if(!Array.isArray(audit.candidates)||audit.digest!==legacyProofDigest({proof:audit.proof,candidates:audit.candidates}))fail('history_recertify_legacy_proof_invalid');
 validateLegacyTerminalProof({token:old,target,report,candidates:audit.candidates},audit.proof,Date.now(),false);return audit.proof;
}
/** 本操作在Rotate写入的独立覆盖审计；只复用键映射，不等同ADR-161双读取器物理证明。 */
function archivedCoverage(op?:StorageRow):RecallCoverageMapping[]|undefined {
 if(!op)return;
 try{
  const audit=JSON.parse(String(op.old_fence_json)).covered_terminal_mapping;
  if(!audit||!Array.isArray(audit.mappings)||audit.digest!==recallCoverageDigest(audit.mappings))return;
  return audit.mappings as RecallCoverageMapping[];
 }catch{return;}
}
function suppression(tx:StorageTransaction,token:ReadEligibility,target:HistoryTarget,report:HistorySupportReport,op?:StorageRow):{terminals:{key:string;reason:string;generation:bigint}[];covered:RecallCoverageMapping[]} {
 assertHistoryReadBoundary(tx,token,{kind:'history'});
 const proof=mappingProof(tx,token,target,report,op),audit=archivedCoverage(op);
 const valid=(key:unknown)=>{try{const k=JSON.parse(String(key));return Array.isArray(k)&&k.length===4&&k[0]===token.source_generation&&typeof k[3]==='string'&&target.tables.some(t=>t.partition===k[1]&&t.instance===k[2]);}catch{return false;}};
 const mappedExclusions:{external_key:string;reason:string;accepted_data_generation:bigint}[]=[],covered=new Map<string,RecallCoverageMapping>();
 const normalize=(key:unknown,terminalReason?:string):string=>{
  const original=String(key);if(valid(original))return original;
  const mapped=completedLegacyPhysicalKeys(tx,{ownerId:token.owner_id,contactId:token.contact_id,conversationId:token.conversation_id,key:original,target,report,...(terminalReason?{terminalReason}:{})}).find(valid);
  if(mapped)return mapped;
  if(terminalReason!=='source_recalled')return original;
  // 窄规则：只有当前代次在同一分片、同一表实例、同一行号独立记为撤回，才把旧撤回键映射到当前代次。
  const remembered=auditedCoverageKey(audit,original,target,token.source_generation,terminalReason);
  if(remembered&&valid(remembered))return remembered;
  const live=coveredRecallKey(tx,{ownerId:token.owner_id,contactId:token.contact_id,conversationId:token.conversation_id,key:original,target,report});
  if(!live||!valid(live))return original;
  covered.set(original,{from:original,to:live,reason:'source_recalled'});
  return live;
 };
 const exclude=(key:unknown)=>{const mapped=normalize(key);if(!valid(mapped))fail('history_recertify_suppression_unmapped');
  if(mapped!==key)mappedExclusions.push({external_key:mapped,reason:'source_absent',accepted_data_generation:BigInt(token.data_generation)});
 };
 for(const r of tx.all('SELECT scheme,external_key FROM history_source_exclusion WHERE owner_id=? AND conversation_id=?',[token.owner_id,token.conversation_id])){
  if(r.scheme==='local')exclude(r.external_key);else if(r.scheme!=='server'||report.serverAliasSemantics!=='verified_within_scope')fail('history_recertify_suppression_unmapped');
 }
 for(const r of tx.all(`SELECT m.external_key FROM history_cutoff_member m JOIN history_cutoff c ON c.owner_id=m.owner_id AND c.conversation_id=m.conversation_id AND c.barrier_generation=m.barrier_generation WHERE m.owner_id=? AND m.conversation_id=? AND c.state='verified'`,[token.owner_id,token.conversation_id]))exclude(r.external_key);
 const terminals=tx.all(`SELECT t.external_key,t.reason,t.accepted_data_generation FROM history_source_terminal t JOIN conversation_binding b ON b.owner_id=t.owner_id AND b.id=t.binding_id WHERE t.owner_id=? AND t.contact_id=? AND b.conversation_id=?`,[token.owner_id,token.contact_id,token.conversation_id]);
 // 兼容只有来源终态或旧隔离审计的历史记录，不从正文或时间推断对象。
 terminals.push(...tx.all(`SELECT DISTINCT r.observed_scheme,r.observed_key external_key,CASE WHEN r.reason_code='metadata_only' THEN 'source_system_replaced' ELSE r.reason_code END reason,g.accepted_data_generation FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id WHERE r.owner_id=? AND r.contact_id=? AND b.conversation_id=? AND ((r.state='excluded' AND r.reason_code IN ('source_recalled','source_system_replaced')) OR (r.state='quarantined' AND r.reason_code='metadata_only' AND json_extract(r.raw_payload,'$.originalType')='10000'))`,[token.owner_id,token.contact_id,token.conversation_id]));
 terminals.push(...tx.all(`SELECT a.external_key,q.reason,min(g.accepted_data_generation) accepted_data_generation FROM history_message_quarantine q JOIN message_alias a ON a.owner_id=q.owner_id AND a.contact_id=q.contact_id AND a.message_id=q.message_id AND a.scheme='local' JOIN conversation_binding b ON b.owner_id=a.owner_id AND b.id=a.binding_id JOIN read_goal g ON g.owner_id=b.owner_id AND g.binding_id=b.id WHERE q.owner_id=? AND q.contact_id=? AND b.conversation_id=? AND q.reason IN ('source_recalled','source_system_replaced') GROUP BY a.external_key,q.reason`,[token.owner_id,token.contact_id,token.conversation_id]));
 terminals.push(...mappedExclusions);
 const result=new Map<string,{key:string;reason:string;generation:bigint}>();
 for(const r of terminals){if(r.observed_scheme!==undefined&&r.observed_scheme!=='source-table-local-v1')fail('history_recertify_suppression_unmapped');const mapped=proof?.keys.find(k=>k.from===r.external_key&&k.reason===r.reason)?.to??normalize(r.external_key,String(r.reason));if(!valid(mapped))fail('history_recertify_suppression_unmapped');
  if(r.reason!=='source_absent'&&tx.get(`SELECT 1 FROM message_alias l JOIN message_alias s ON s.owner_id=l.owner_id AND s.contact_id=l.contact_id AND s.message_id=l.message_id AND s.scheme='server' JOIN conversation_binding b ON b.owner_id=l.owner_id AND b.id=l.binding_id WHERE l.owner_id=? AND l.contact_id=? AND b.conversation_id=? AND l.scheme='local' AND l.external_key=? LIMIT 1`,[token.owner_id,token.contact_id,token.conversation_id,r.external_key]))fail('history_recertify_terminal_alias_unmapped');
  if(r.reason!=='source_absent')for(const prior of tx.all(`SELECT json_extract(r.raw_payload,'$.serverId') server_id FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id JOIN conversation_binding b ON b.owner_id=g.owner_id AND b.id=g.binding_id WHERE r.owner_id=? AND r.contact_id=? AND b.conversation_id=? AND r.observed_key=? AND r.raw_payload IS NOT NULL`,[token.owner_id,token.contact_id,token.conversation_id,r.external_key]))
   if(typeof prior.server_id==='string'&&/^[1-9][0-9]{0,19}$/.test(prior.server_id)&&BigInt(prior.server_id)<=18446744073709551615n)fail('history_recertify_terminal_alias_unmapped');
  const key=String(mapped),prior=result.get(key),reason=String(r.reason);if(!prior||prior.reason==='source_absent')result.set(key,{key,reason,generation:BigInt(String(r.accepted_data_generation))});}
 return {terminals:[...result.values()],covered:[...covered.values()].sort((a,b)=>a.from.localeCompare(b.from))};
}
function view(tx:StorageTransaction,contactId:string,op?:StorageRow) {
 const goal=op?.goal_id?tx.get('SELECT state,failure_code FROM read_goal WHERE owner_id=? AND id=?',[op.owner_id,op.goal_id]):undefined;
 const counts=op?.new_binding_id?tx.get("SELECT count(CASE WHEN kind='text' THEN 1 END) texts,count(CASE WHEN kind<>'text' THEN 1 END) media FROM message WHERE owner_id=? AND contact_id=? AND binding_id=?",[op.owner_id,contactId,op.new_binding_id]):op?.goal_id?tx.get(`SELECT count(DISTINCT CASE WHEN m.kind='text' THEN m.id END) texts,count(DISTINCT CASE WHEN m.kind<>'text' THEN m.id END) media FROM message m
  JOIN capture_record r ON r.owner_id=m.owner_id AND r.contact_id=m.contact_id AND r.message_id=m.id
  JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
  WHERE m.owner_id=? AND m.contact_id=? AND c.goal_id=?`,[op.owner_id,contactId,op.goal_id]):undefined;
 const pages=op?.goal_id?tx.get('SELECT count(*) n FROM sync_capture WHERE owner_id=? AND goal_id=?',[op.owner_id,op.goal_id]):undefined;
 return {contact_id:contactId,request_key:op?String(op.request_key):null,state:op?String(op.state):'none',stage:op?String(op.stage):'none',completed:op?.state==='completed',failure_code:op?.failure_code??null,message_count:Number(counts?.texts??0),non_text_count:Number(counts?.media??0),page_count:Number(pages?.n??0),preserved_message_count:Number(op?.preserved_message_count??0),started_at:op?Number(op.started_at):null,finished_at:op?.finished_at===null||!op?null:Number(op.finished_at),goalState:goal?.state??null,goalFailure:goal?.failure_code??null,id:op?.id??null,new_binding_id:op?.new_binding_id??null};
}
export const historyRecertifyActions:StorageAction[]=[
 action('LegacyCandidates','read',(tx,i:any)=>{
  assertReadEligibility(tx,i.token);const op=pending(tx,{ownerId:i.token.owner_id,id:i.id});if(op.stage!=='metadata'||op.old_token_json!==json(i.token))fail('history_recertify_stale');
  const candidates=uncoveredLegacyRecallCandidates(tx,i.token,i.target,i.report);
  if(candidates.length&&candidates.every(c=>completedLegacyPhysicalKeys(tx,{ownerId:i.token.owner_id,contactId:i.token.contact_id,conversationId:i.token.conversation_id,key:c.key,terminalReason:'source_recalled',target:i.target,report:i.report}).some(key=>JSON.parse(key)[0]===i.token.source_generation)))return [];
  return candidates;
 }),
 action('LegacyMapping','write',(tx,i:any)=>{
  assertReadEligibility(tx,i.token);const op=pending(tx,{ownerId:i.token.owner_id,id:i.id});
  if(op.stage!=='metadata'||op.old_token_json!==json(i.token)||op.new_binding_id!==null)fail('history_recertify_stale');
  const candidates=uncoveredLegacyRecallCandidates(tx,i.token,i.target,i.report);validateLegacyTerminalProof({token:i.token,target:i.target,report:i.report,candidates},i.proof,i.at);
  const archived=JSON.parse(String(op.old_fence_json));if(archived.legacy_terminal_mapping)fail('history_recertify_stale');
  archived.legacy_terminal_mapping={digest:legacyProofDigest({proof:i.proof,candidates}),proof:i.proof,candidates};
  mappingProof(tx,i.token,i.target,i.report,{...op,old_fence_json:json(archived)});
  tx.run('UPDATE history_source_recertification SET old_fence_json=?,updated_at=? WHERE owner_id=? AND id=?',[json(archived),i.at,i.token.owner_id,i.id]);return true;
 }),
 action('InterruptStale','write',(tx,i:any)=>{tx.run("UPDATE history_source_recertification SET state='interrupted',guard_state='lost',failure_code=CASE WHEN EXISTS(SELECT 1 FROM history_source_recertification_cancel c WHERE c.owner_id=history_source_recertification.owner_id AND c.request_key=history_source_recertification.request_key) THEN 'history_recertify_cancelled' ELSE coalesce(failure_code,'history_recertify_interrupted') END,updated_at=?,finished_at=? WHERE owner_id=? AND state='running' AND runtime_id<>?",[i.at,i.at,i.ownerId,runtime(tx)]);return true;}),
 action('Status','read',(tx,i:any)=>{
  const op=i.requestKey?tx.get('SELECT * FROM history_source_recertification WHERE owner_id=? AND request_key=?',[i.ownerId,i.requestKey]):tx.get("SELECT * FROM history_source_recertification WHERE owner_id=? AND contact_id=? ORDER BY (state='running') DESC,started_at DESC,rowid DESC LIMIT 1",[i.ownerId,i.contactId]);
  const cancel=i.requestKey?tx.get('SELECT * FROM history_source_recertification_cancel WHERE owner_id=? AND request_key=?',[i.ownerId,i.requestKey]):tx.get('SELECT * FROM history_source_recertification_cancel WHERE owner_id=? AND contact_id=? ORDER BY cancelled_at DESC,rowid DESC LIMIT 1',[i.ownerId,i.contactId]);
  if(op&&op.contact_id!==i.contactId||cancel&&cancel.contact_id!==i.contactId)fail('history_recertify_request_conflict');
  return view(tx,i.contactId,op&&(!cancel||i.requestKey||op.state==='running'||op.request_key===cancel.request_key||Number(op.started_at)>=Number(cancel.cancelled_at))?op:cancel?{contact_id:i.contactId,request_key:String(cancel.request_key),state:'interrupted',stage:'metadata',completed:false,failure_code:'history_recertify_cancelled',message_count:0,non_text_count:0,page_count:0,preserved_message_count:0,started_at:Number(cancel.cancelled_at),finished_at:Number(cancel.cancelled_at)} as unknown as StorageRow:undefined);
 }),
 action('Cancel','write',(tx,i:any)=>{
  const op=tx.get('SELECT * FROM history_source_recertification WHERE owner_id=? AND request_key=?',[i.ownerId,i.requestKey]);
  const prior=tx.get('SELECT * FROM history_source_recertification_cancel WHERE owner_id=? AND request_key=?',[i.ownerId,i.requestKey]);
  if(op&&op.contact_id!==i.contactId||prior&&prior.contact_id!==i.contactId)fail('history_recertify_request_conflict');
  if(op&&op.state!=='running')return true;
  if(!prior){if(!tx.get("SELECT 1 FROM contact c JOIN owner o ON o.owner_id=c.owner_id WHERE c.owner_id=? AND c.id=? AND c.state='active' AND o.state='active'",[i.ownerId,i.contactId]))fail('history_recertify_not_found');
   tx.run('INSERT INTO history_source_recertification_cancel VALUES(?,?,?,?)',[i.ownerId,i.contactId,i.requestKey,i.at]);}
  return true;
 }),
 action('Prepare','write',(tx,i:any)=>{
  const token=i.token as ReadEligibility;
  const prior=tx.get('SELECT contact_id FROM history_source_recertification WHERE owner_id=? AND request_key=?',[token.owner_id,i.requestKey])??tx.get('SELECT contact_id FROM history_source_recertification_cancel WHERE owner_id=? AND request_key=?',[token.owner_id,i.requestKey]);
  if(prior){if(prior.contact_id!==token.contact_id)fail('history_recertify_request_conflict');return false;}
  assertReadEligibility(tx,token);
  if(tx.get("SELECT 1 FROM history_source_recertification WHERE owner_id=? AND contact_id=? AND state='running'",[token.owner_id,token.contact_id]))fail('history_recertify_already_running');
  const proof=getProof(tx,token.owner_id,token.contact_id);if(proof?.state!=='needs_confirmation')fail('history_recertify_not_required');
  const fence={owner_id:token.owner_id,contact_id:token.contact_id,reason:proof!.reason??'history_source_continuity_unverified'};
  if(tx.get("SELECT 1 FROM deletion_operation WHERE owner_identity=? AND state<>'completed' AND scope_kind<>'superseded_history' AND (scope_kind='account' OR contact_identity=?)",[token.owner_id,token.contact_id]))fail('history_recertify_deletion_pending');
  const scope=getProof(tx,token.owner_id,token.contact_id);
  const lease=getSourceGuard(tx,token.owner_id,token.contact_id);
  const n=tx.get('SELECT count(*) n FROM message WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id])!.n;
  tx.run(`INSERT INTO history_source_recertification(owner_id,id,contact_id,request_key,runtime_id,state,stage,started_at,updated_at,old_binding_id,old_token_json,preserved_message_count,old_fence_json,old_scope_json,old_lease_json) VALUES(?,?,?,?,?,'running','metadata',?,?,?,?,?,?,?,?)`,[token.owner_id,i.id,token.contact_id,i.requestKey,runtime(tx),i.at,i.at,token.binding_id,json(token),n,json({...fence,legacy_cause:'unknown'}),scope?json(scope):null,lease?json(lease):null]);
  return true;
 }),
 action('ResumeComplete','write',(tx,i:any)=>{
  const token=i.token as ReadEligibility;assertReadEligibility(tx,token);const op=pending(tx,{ownerId:token.owner_id,id:i.id});
  if(op.old_token_json!==json(token)||op.new_binding_id!==null||isSourceBlocked(tx,token.owner_id,token.contact_id))fail('history_recertify_stale');
  const goal=tx.get("SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND id=? AND binding_id=? AND state='complete'",[token.owner_id,token.contact_id,i.goalId,token.binding_id])??fail('history_recertify_incomplete');
  tx.run("UPDATE history_source_recertification SET state='completed',stage='completed',guard_state='lost',goal_id=?,target_json=?,support_json=?,token_json=?,updated_at=?,finished_at=? WHERE owner_id=? AND id=?",[i.goalId,goal.target_json,goal.support_json,json(token),i.at,i.at,token.owner_id,i.id]);return true;
 }),
 action('Rotate','write',(tx,i:any)=>{
  const token=i.token as ReadEligibility;assertReadEligibility(tx,token);const op=pending(tx,{ownerId:token.owner_id,id:i.id});
  if(op.stage!=='metadata'||op.old_token_json!==json(token)||op.new_binding_id!==null)fail('history_recertify_stale');
  const report=i.report as HistorySupportReport,target=i.target as HistoryTarget;
  scopeReport(tx,token,report);
  if(report.continuity!==normalUseContinuity||report.status!=='supported'||report.sourceGeneration!==token.source_generation||target.sourceGeneration!==token.source_generation)fail('history_recertify_source_changed');
  const prior=op.old_scope_json?JSON.parse(String(op.old_scope_json)):null;
  if(prior&&(prior.source_generation!==token.source_generation||prior.conversation_id!==token.conversation_id))fail('history_recertify_source_changed');
  if(prior?.tables_json){const parsed=JSON.parse(prior.tables_json),oldTarget={...parsed,sourceGeneration:prior.source_generation};
   if(parsed.accountKey&&parsed.accountKey!==report.accountKey)fail('history_recertify_source_changed');
   if(!exactPhysical(oldTarget,target)){
    if(!containsPriorPhysical(oldTarget,target)||['normalHistory','snapshotBarrier','partitionCoverage'].some(key=>report.capabilities?.[key]!=='supported'))fail('history_recertify_source_changed');
    if(tx.get('SELECT 1 FROM history_source_exclusion WHERE owner_id=? AND conversation_id=? LIMIT 1',[token.owner_id,token.conversation_id])
     ||tx.get('SELECT 1 FROM history_cutoff WHERE owner_id=? AND conversation_id=? LIMIT 1',[token.owner_id,token.conversation_id])
     ||tx.get('SELECT 1 FROM history_deletion_fence WHERE owner_id=? AND contact_id=? LIMIT 1',[token.owner_id,token.contact_id]))fail('history_recertify_suppression_unmapped');
   }
  }
  else if(Number(op.preserved_message_count)>0||tx.get('SELECT 1 FROM capture_record WHERE owner_id=? AND contact_id=? LIMIT 1',[token.owner_id,token.contact_id]))fail('history_recertify_source_unverified');
  const suppressed=suppression(tx,token,target,report,op),archived=JSON.parse(String(op.old_fence_json));
  if(suppressed.covered.length)archived.covered_terminal_mapping={digest:recallCoverageDigest(suppressed.covered),mappings:suppressed.covered};
  const b=tx.get('SELECT * FROM conversation_binding WHERE owner_id=? AND id=? AND state=\'verified\'',[token.owner_id,token.binding_id])??fail('history_recertify_stale');
  tx.run("UPDATE read_grant SET revoked_at=?,reason='explicit_source_recertification' WHERE owner_id=? AND id=? AND revoked_at IS NULL",[i.at,token.owner_id,token.grant_id]);
  tx.run("UPDATE conversation_binding SET state='revoked' WHERE owner_id=? AND id=?",[token.owner_id,token.binding_id]);
  const selection=BigInt(token.selection_generation)+1n;
  tx.run('UPDATE contact SET selection_generation=?,source_revision=source_revision+1 WHERE owner_id=? AND id=?',[selection,token.owner_id,token.contact_id]);
  tx.run("INSERT INTO conversation_binding(owner_id,id,contact_id,conversation_id,identity_generation,state) VALUES(?,?,?,?,0,'verified')",[token.owner_id,i.bindingId,token.contact_id,token.conversation_id]);
  tx.run("INSERT INTO binding_verification VALUES(?,?,?,0,'channel_metadata','identity-metadata-v1',?,?)",[token.owner_id,i.verificationId,i.bindingId,json({support_profile:report.profileId,source_generation:report.sourceGeneration,account_id:report.accountKey,conversation_key:report.conversationKey}),i.at]);
  tx.run('INSERT INTO read_grant(owner_id,id,contact_id,binding_id,verification_id,selection_generation,granted_at) VALUES(?,?,?,?,?,?,?)',[token.owner_id,i.grantId,token.contact_id,i.bindingId,i.verificationId,selection,i.at]);
  for(const terminal of suppressed.terminals)tx.run('INSERT INTO history_source_terminal VALUES(?,?,?,?,?,?,?)',[token.owner_id,randomUUID(),token.contact_id,i.bindingId,terminal.key,terminal.reason,terminal.generation]);
  const expectedToken={...token,binding_id:i.bindingId,grant_id:i.grantId,verification_id:i.verificationId,selection_generation:String(selection),identity_generation:'0'};
  tx.run('UPDATE history_source_recertification SET new_binding_id=?,new_grant_id=?,token_json=?,target_json=?,support_json=?,old_fence_json=?,updated_at=? WHERE owner_id=? AND id=?',[i.bindingId,i.grantId,json(expectedToken),json(target),json(report),json(archived),i.at,token.owner_id,i.id]);return true;
 }),
 action('Guard','write',(tx,i:any)=>{
  const token=i.token as ReadEligibility;assertReadEligibility(tx,token);const op=pending(tx,{ownerId:token.owner_id,id:i.id});
  if(op.new_binding_id!==token.binding_id||op.new_grant_id!==token.grant_id||op.token_json!==json(token)||op.stage!=='metadata')fail('history_recertify_stale');
  scopeReport(tx,token,i.report);
  if(!exactPreviewPhysical(JSON.parse(String(op.target_json)),i.target)||json(i.report)!==op.support_json)fail('history_recertify_source_changed');
  suppression(tx,token,i.target,i.report,op);
  tx.run("UPDATE history_source_recertification SET stage='history',token_json=?,target_json=?,guard_id=?,guard_state='active',updated_at=? WHERE owner_id=? AND id=?",[json(token),json(i.target),i.guardId,i.at,token.owner_id,i.id]);return true;
 }),
 action('Attach','write',(tx,i:any)=>{const op=assertRecertifyAccess(tx,i.token,i.id,i.guardId);const g=tx.get('SELECT * FROM read_goal WHERE owner_id=? AND id=?',[i.token.owner_id,i.goalId]);if(!g||g.eligibility_json!==op.token_json)fail('history_recertify_stale');tx.run('UPDATE history_source_recertification SET goal_id=?,updated_at=? WHERE owner_id=? AND id=?',[i.goalId,i.at,i.token.owner_id,i.id]);return true;}),
 action('Activate','write',(tx,i:any)=>{
  const token=i.token as ReadEligibility,op=assertRecertifyAccess(tx,token,i.id,i.guardId,i.target);assertHistoryReadBoundary(tx,token,{kind:'history'});
  const goal=tx.get("SELECT * FROM read_goal WHERE owner_id=? AND id=? AND state='complete' AND eligibility_json=?",[token.owner_id,op.goal_id,op.token_json])??fail('history_recertify_incomplete');
  const target=JSON.parse(String(op.target_json)) as HistoryTarget,report=JSON.parse(String(op.support_json));suppression(tx,token,target,report,op);
  const fence=getProof(tx,token.owner_id,token.contact_id)!;
  const archived=JSON.parse(String(op.old_fence_json));if(fence.reason!==archived.reason)fail('history_recertify_stale');
  const scope=json({accountKey:report.accountKey,partitions:[...target.partitions].sort(),tables:target.tables.map(t=>[t.partition,t.instance]).sort((a,b)=>json(a).localeCompare(json(b))),...(target.checkedPartitions?{checkedPartitions:[...target.checkedPartitions].sort()}:{} )});
  putScope(tx,token,scope,{accountKey:report.accountKey,conversationKey:report.conversationKey,state:'needs_confirmation',checkedAt:i.at});
  putSourceGuard(tx,{owner_id:token.owner_id,contact_id:token.contact_id,binding_id:token.binding_id,conversation_id:token.conversation_id,source_generation:token.source_generation,guard_id:i.guardId,runtime_id:runtime(tx),state:'active'});
  // Seal仍保留围栏；渠道清洁关闭确认后才允许Finalize发布稳定终态。
  tx.run("UPDATE history_source_recertification SET stage='activation',updated_at=? WHERE owner_id=? AND id=?",[i.at,token.owner_id,i.id]);return true;
 }),
 action('Finalize','write',(tx,i:any)=>{
  const token=i.token as ReadEligibility;assertReadEligibility(tx,token);const op=pending(tx,{ownerId:token.owner_id,id:i.id});
  if(op.stage!=='activation'||op.guard_state!=='active'||op.guard_id!==i.guardId||op.token_json!==json(token))fail('history_recertify_stale');
  const guard=getSourceGuard(tx,token.owner_id,token.contact_id);
  if(!guard||guard.binding_id!==token.binding_id||guard.conversation_id!==token.conversation_id||guard.source_generation!==token.source_generation||guard.guard_id!==i.guardId||guard.runtime_id!==runtime(tx)||guard.state!=='lost')fail('history_recertify_not_authorized');
  if(!tx.get("SELECT 1 FROM read_goal WHERE owner_id=? AND id=? AND state='complete' AND eligibility_json=?",[token.owner_id,op.goal_id,op.token_json]))fail('history_recertify_incomplete');
  assertHistoryReadBoundary(tx,token,{kind:'history'});
  const fence=getProof(tx,token.owner_id,token.contact_id);
  if(!fence||fence.reason!==JSON.parse(String(op.old_fence_json)).reason)fail('history_recertify_stale');
  putScope(tx,token,fence!.tables_json,{state:'ok',checkedAt:i.at});
  tx.run("UPDATE history_source_recertification SET state='completed',stage='completed',guard_state='lost',updated_at=?,finished_at=? WHERE owner_id=? AND id=?",[i.at,i.at,token.owner_id,i.id]);
  tx.run('UPDATE contact SET source_revision=source_revision+1 WHERE owner_id=? AND id=?',[token.owner_id,token.contact_id]);
  // 修复通过后登记清理请求（ADR-175）：与完成同一事务，重启后据此续跑，清理本身不在此事务内执行。
  requestSupersededCleanup(tx,token.owner_id,token.contact_id,i.at);return true;
 }),
 action('NoteFailure','write',(tx,i:any)=>{const op=operation(tx,i.ownerId,i.id);if(op.state!=='running')return false;tx.run("UPDATE history_source_recertification SET failure_code=?,guard_state='lost',updated_at=? WHERE owner_id=? AND id=?",[typeof i.code==='string'&&/^[a-z][a-z0-9_]{0,127}$/.test(i.code)?i.code:'history_recertify_failed',i.at,i.ownerId,i.id]);if(isSourceContinuityLost(new StorageFailure(i.code))){const token=JSON.parse(String(op.old_token_json)) as ReadEligibility;
   if(tx.get("SELECT 1 FROM conversation_binding WHERE owner_id=? AND contact_id=? AND id=? AND state='verified'",[token.owner_id,token.contact_id,token.binding_id]))fenceContinuity(tx,token,'C01',i.code);}
  if(op.new_binding_id)loseSourceGuard(tx,i.ownerId,String(op.contact_id),{bindingId:String(op.new_binding_id)});return true;}),
 action('Fail','write',(tx,i:any)=>{const op=operation(tx,i.ownerId,i.id);if(op.state!=='running')return false;const code=typeof i.code==='string'&&/^[a-z][a-z0-9_]{0,127}$/.test(i.code)?i.code:'history_recertify_failed';tx.run("UPDATE history_source_recertification SET state=?,stage=?,failure_code=?,guard_state='lost',updated_at=?,finished_at=? WHERE owner_id=? AND id=?",[i.interrupted?'interrupted':'failed',i.stage??op.stage,code,i.at,i.at,i.ownerId,i.id]);fenceSource(tx,JSON.parse(String(op.old_token_json)) as ReadEligibility,'C01');if(op.new_binding_id)loseSourceGuard(tx,i.ownerId,String(op.contact_id),{bindingId:String(op.new_binding_id)});return true;}),
 ...historyRecertifyCandidatesActions,
];
