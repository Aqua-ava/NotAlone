import { createHash, randomUUID } from 'node:crypto';
import { StorageFailure, type StorageAction, type StorageTransaction, type StorageRow } from '../../storage/sqlite/contracts.ts';
import { assertReadEligibility } from '../../contacts/sqlite/actions.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistoryPage, HistoryTarget, HistorySupportReport } from './contracts.ts';
import { prepareRecord } from './normalize.ts';
import { readCoverage, readMessages } from './read.ts';
const fail=(code:string):never=>{throw new StorageFailure(code);};
const action=(name:string,mode:'read'|'write',execute:(tx:StorageTransaction,i:any)=>unknown):StorageAction=>({name,mode,retryBusy:true,execute});
export function assertSupport(report:HistorySupportReport):void {
 if(report?.status==='unsupported')fail('history_support_unsupported');
 if(report?.status!=='supported'||report.protocol!=='private-history-v1'||report.identity!=='source-table-local-v1'
  ||!report.accountKey||!report.conversationKey||!report.sourceGeneration||!report.profileId||!report.adapterVersion||!report.programVersion||!report.build||!report.statusSemantics||!report.continuity
  ||!Array.isArray(report.declaredPrimaryKey)||!report.declaredPrimaryKey.length
  ||!/^[a-f0-9]{64}$/.test(report.artifactSha256)||!/^[a-f0-9]{64}$/.test(report.schemaFingerprint))fail('history_support_unverified');
}
function goalFor(tx:StorageTransaction,owner:string,id:string):StorageRow {return tx.get('SELECT * FROM read_goal WHERE owner_id=? AND id=?',[owner,id])??fail('history_goal_not_found');}
function currentGoal(tx:StorageTransaction,token:ReadEligibility,id:string):StorageRow {
 assertReadEligibility(tx,token);const goal=goalFor(tx,token.owner_id,id);
 if(goal.eligibility_json!==JSON.stringify(token)||goal.contact_id!==token.contact_id||goal.binding_id!==token.binding_id)fail('history_goal_stale');
 return goal;
}
function sameMessage(row:StorageRow,r:ReturnType<typeof prepareRecord>['value']):boolean {
 return row.sender_role===r.sender&&row.kind===r.kind&&row.text_body===r.text&&row.original_type===r.originalType
  &&(row.sent_at===null||r.sentAt===null||String(row.sent_at)===r.sentAt&&row.time_precision===r.timePrecision);
}
export const historyActions:StorageAction[]=[
 action('history.scope','read',(tx,i)=>{assertReadEligibility(tx,i.token);const row=tx.get(`SELECT a.external_key AS account_key,c.external_key AS conversation_key FROM channel_account a JOIN channel_conversation c ON c.owner_id=a.owner_id AND c.account_id=a.id WHERE a.owner_id=? AND a.id=? AND c.id=?`,[i.token.owner_id,i.token.account_id,i.token.conversation_id])??fail('history_scope_invalid');return {token:i.token,accountKey:row.account_key,conversationKey:row.conversation_key};}),
 action('history.pending','read',(tx,i)=>{assertReadEligibility(tx,i.token);const goal=tx.get("SELECT * FROM read_goal WHERE owner_id=? AND contact_id=? AND state IN ('running','incomplete') AND eligibility_json=? ORDER BY created_at DESC,rowid DESC LIMIT 1",[i.token.owner_id,i.token.contact_id,JSON.stringify(i.token)]);if(goal&&goal.support_json!==JSON.stringify(i.report))fail('history_support_changed');return goal?{id:goal.id,target:JSON.parse(String(goal.target_json)),cursor:goal.cursor}:null;}),
 action('history.begin','write',(tx,i)=>{
  const token=i.token as ReadEligibility;assertReadEligibility(tx,token);assertSupport(i.report);
  const target=i.target as HistoryTarget;
  if(target?.protocol!=='private-history-v1'||target.sourceGeneration!==token.source_generation||typeof target.descriptor!=='string'||!target.descriptor||target.descriptor.length>64_000||!Array.isArray(target.partitions)||!target.partitions.length||target.partitions.length>10000||target.partitions.some(p=>typeof p!=='string'||!p||p.length>512)||new Set(target.partitions).size!==target.partitions.length)fail('history_target_unverified');
  // 精确清空/来源抑制尚未由16提供时保持关闭，不能靠时间戳或重选绕过。
  if(BigInt(token.barrier_generation)!==0n||tx.get('SELECT 1 FROM history_deletion_fence WHERE owner_id=? AND contact_id=?',[token.owner_id,token.contact_id]))fail('history_suppression_unverified');
  tx.run(`INSERT INTO read_goal(owner_id,id,contact_id,binding_id,grant_id,accepted_data_generation,accepted_barrier_generation,kind,target_protocol,target_descriptor,target_json,eligibility_json,support_json,state,coverage_state,created_at) VALUES(?,?,?,?,?,?,?,'history',?,?,?,?,?,'running','partial',?)`,[token.owner_id,i.id,token.contact_id,token.binding_id,token.grant_id,BigInt(token.data_generation),BigInt(token.barrier_generation),target.protocol,target.descriptor,JSON.stringify(target),JSON.stringify(token),JSON.stringify(i.report),i.at]);
  return {id:i.id,target,cursor:null};
 }),
 action('history.acceptPage','write',(tx,i)=>{
  const token=i.token as ReadEligibility;const goal=currentGoal(tx,token,i.goalId);const page=i.page as HistoryPage;
  const digest=createHash('sha256').update(JSON.stringify(page)).digest('hex');
  const prior=tx.get('SELECT response_digest FROM sync_capture WHERE owner_id=? AND id=?',[token.owner_id,i.captureId]);
  if(prior){if(prior.response_digest!==digest)fail('history_capture_replay_conflict');return readCoverage(tx,token.owner_id,token.contact_id);}
  if(goal.state!=='running'&&goal.state!=='incomplete')fail('history_goal_closed');
  const target=JSON.parse(String(goal.target_json)) as HistoryTarget;
  if(page?.target!==goal.target_descriptor||page.cursorIn!==goal.cursor||!Array.isArray(page.records)||page.records.length>1000||!Array.isArray(page.completedPartitions)||page.completedPartitions.some(p=>!target.partitions.includes(p))||typeof page.exhausted!=='boolean'||page.exhausted&&page.cursorOut!==null||!page.exhausted&&(typeof page.cursorOut!=='string'||!page.cursorOut||page.cursorOut===page.cursorIn))fail('history_page_invalid');
  const report=JSON.parse(String(goal.support_json)) as HistorySupportReport;
  tx.run("INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,cursor_in,cursor_out,state,response_digest) VALUES(?,?,?,?,?,?,?,?,?,?,'accepted',?)",[token.owner_id,i.captureId,token.contact_id,goal.id,BigInt(token.read_epoch),i.runtimeToken,i.at,report.adapterVersion,page.cursorIn,page.cursorOut,digest]);
  let quarantined=false;
  for(const [index,input]of page.records.entries()){
   const prepared=prepareRecord(input,token.source_generation,target.partitions);const r=prepared.value;let reason=prepared.reason;let message:StorageRow|undefined;
   const excluded=prepared.localKey&&tx.get('SELECT 1 FROM history_source_exclusion WHERE owner_id=? AND conversation_id=? AND external_key=?',[token.owner_id,token.conversation_id,prepared.localKey]);
   if(excluded)reason='source_excluded';
   if(!reason){
    const local=tx.get("SELECT m.* FROM message_alias a JOIN message m ON m.owner_id=a.owner_id AND m.id=a.message_id WHERE a.owner_id=? AND a.contact_id=? AND a.binding_id=? AND a.scheme='local' AND a.external_key=?",[token.owner_id,token.contact_id,token.binding_id,prepared.localKey]);
    const server=prepared.serverKey?tx.get("SELECT m.* FROM message_alias a JOIN message m ON m.owner_id=a.owner_id AND m.id=a.message_id WHERE a.owner_id=? AND a.contact_id=? AND a.binding_id=? AND a.scheme='server' AND a.external_key=?",[token.owner_id,token.contact_id,token.binding_id,prepared.serverKey]):undefined;
    if(local&&server&&local.id!==server.id)reason='message_identity_conflict';
    else {message=local??server;if(message&&!sameMessage(message,r))reason='message_identity_conflict';}
    if(!reason){
     if(!message){const id=randomUUID();const display=(tx.get('SELECT coalesce(max(display_no),0)+1 AS n FROM message')!.n as bigint);
      tx.run(`INSERT INTO message(owner_id,id,contact_id,binding_id,identity_scheme,external_key,sender_role,kind,text_body,original_type,sent_at,time_precision,order_scheme,order_key,display_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[token.owner_id,id,token.contact_id,token.binding_id,'source-table-local-v1',prepared.localKey,r.sender,r.kind,r.text,r.originalType,r.sentAt===null?null:BigInt(r.sentAt),r.timePrecision,r.orderScheme,r.orderKey,display]);message={id};}
     if(message.sent_at!==undefined&&(message.sent_at===null&&r.sentAt!==null||r.orderScheme!==null&&(message.order_scheme!==r.orderScheme||message.order_key!==r.orderKey)))
      tx.run('UPDATE message SET sent_at=coalesce(sent_at,?),time_precision=coalesce(time_precision,?),order_scheme=coalesce(?,order_scheme),order_key=coalesce(?,order_key),interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND id=?',[r.sentAt===null?null:BigInt(r.sentAt),r.timePrecision,r.orderScheme,r.orderKey,token.owner_id,message.id]);
     for(const [scheme,key]of [['local',prepared.localKey],['server',prepared.serverKey]])if(key)tx.run('INSERT OR IGNORE INTO message_alias(owner_id,contact_id,binding_id,scheme,external_key,message_id) VALUES(?,?,?,?,?,?)',[token.owner_id,token.contact_id,token.binding_id,scheme!,key,message.id]);
    }
   }
   if(reason&&reason!=='source_excluded')quarantined=true;
   tx.run('INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version,reason_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',[token.owner_id,randomUUID(),token.contact_id,i.captureId,index,reason==='source_excluded'?'excluded':reason?'quarantined':'normalized',reason?null:message!.id,excluded?null:prepared.raw,prepared.localKey?'source-table-local-v1':null,prepared.localKey,'1',reason]);
  }
  const partitions=new Set<string>([...JSON.parse(String(goal.completed_partitions)),...page.completedPartitions]);
  const unresolved=quarantined||Boolean(tx.get("SELECT 1 FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id WHERE c.owner_id=? AND c.goal_id=? AND r.state='quarantined'",[token.owner_id,goal.id]));
  const complete=page.exhausted&&target.partitions.every(p=>partitions.has(p))&&!unresolved;
  const state=complete?'complete':page.exhausted?'incomplete':'running';const code=unresolved?'history_identity_quarantined':page.exhausted&&!complete?'history_partitions_missing':null;
  if(quarantined)tx.run("UPDATE sync_capture SET state='quarantined',error_code='history_identity_quarantined' WHERE owner_id=? AND id=?",[token.owner_id,i.captureId]);
  tx.run('UPDATE read_goal SET cursor=?,completed_partitions=?,state=?,coverage_state=?,failure_code=? WHERE owner_id=? AND id=?',[page.cursorOut,JSON.stringify([...partitions]),state,complete?'complete':'partial',code,token.owner_id,goal.id]);
  return readCoverage(tx,token.owner_id,token.contact_id);
 }),
 action('history.interrupt','write',(tx,i)=>{const goal=currentGoal(tx,i.token,i.goalId);if(goal.state==='running')tx.run("UPDATE read_goal SET state='incomplete',failure_code=? WHERE owner_id=? AND id=?",[i.code,i.token.owner_id,goal.id]);return readCoverage(tx,i.token.owner_id,i.token.contact_id);}),
 action('history.source','read',(tx,i)=>{
  readCoverage(tx,i.ownerId,i.contactId);
  const row=tx.get(`SELECT r.*,c.goal_id,c.captured_at,c.adapter_version,c.cursor_in,c.cursor_out,g.support_json
   FROM capture_record r JOIN message m ON m.owner_id=r.owner_id AND m.contact_id=r.contact_id AND m.id=r.message_id
   JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
   JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
   WHERE r.owner_id=? AND r.contact_id=? AND r.id=? AND r.state='normalized' AND m.availability='available'`,[i.ownerId,i.contactId,i.recordId])??fail('history_source_not_found');
  return {recordId:row.id,contactId:row.contact_id,messageId:row.message_id,captureId:row.capture_id,goalId:row.goal_id,
   itemNo:Number(row.item_no),capturedAt:String(row.captured_at),adapterVersion:row.adapter_version,normalizerVersion:row.normalizer_version,
   cursorIn:row.cursor_in,cursorOut:row.cursor_out,raw:JSON.parse(String(row.raw_payload)),support:JSON.parse(String(row.support_json))};
 }),
 action('history.coverage','read',(tx,i)=>readCoverage(tx,i.ownerId,i.contactId)),
 action('history.read','read',(tx,i)=>readMessages(tx,i.ownerId,i.contactId,i.limit,i.before)),
];
