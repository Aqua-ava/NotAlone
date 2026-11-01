import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { StorageFailure, type StorageRow, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistoryRecord, HistorySupportReport, HistoryTarget } from './contracts.ts';
import { verifiedTerminalReason, prepareRecord } from './normalize.ts';
import {currentSourceScopeCTE,currentSourcePredicate} from './current-scope.ts';
import {rememberSourceTerminal,type SourceTerminalReason} from './terminal.ts';
import {failHistoryQuoteInTransaction,quoteParserVersion,saveHistoryQuoteInTransaction} from './quote-store.ts';

/** 逐条排除判定：来源删除（05）与清空截断（06）分别记账，都不写回正文或原始载荷。 */
export type IngestExclusion = 'source_excluded' | 'clear_excluded';
export interface IngestObserved { localKey: string | null; serverKey: string | null }
export interface IngestRecordsInput {
  tx: StorageTransaction; token: ReadEligibility; report: HistorySupportReport; target: HistoryTarget;
  captureId: string; at: number; records: readonly HistoryRecord[];
  // 06 接线点：返回排除码时不建立/不改写消息；未命中继续按来源身份幂等写入。
  exclude?: (observed: IngestObserved) => IngestExclusion | null;
}

function sameMessage(row: StorageRow, record: ReturnType<typeof prepareRecord>['value']): boolean {
  return row.sender_role === record.sender && row.kind === record.kind && row.text_body === record.text && row.original_type === record.originalType
    && (row.sent_at === null || record.sentAt === null || String(row.sent_at) === record.sentAt && row.time_precision === record.timePrecision);
}
function aliasMessage(tx: StorageTransaction, token: ReadEligibility, scheme: string, key: string): StorageRow | undefined {
  return tx.get('SELECT m.* FROM message_alias a JOIN message m ON m.owner_id=a.owner_id AND m.id=a.message_id WHERE a.owner_id=? AND a.contact_id=? AND a.binding_id=? AND a.scheme=? AND a.external_key=?', [token.owner_id, token.contact_id, token.binding_id, scheme, key]);
}
function sourceExcluded(tx: StorageTransaction, token: ReadEligibility, prepared: ReturnType<typeof prepareRecord>, report: HistorySupportReport): boolean {
  if (!prepared.localKey) return false;
  return Boolean(tx.get("SELECT 1 FROM history_source_exclusion WHERE owner_id=? AND conversation_id=? AND ((scheme='local' AND external_key=?) OR (scheme='server' AND external_key=?))", [token.owner_id, token.conversation_id, prepared.localKey, report.serverAliasSemantics === 'verified_within_scope' ? prepared.serverKey : null]));
}
type TerminalReason=SourceTerminalReason;
const terminalReasons=['source_recalled','source_absent','source_system_replaced'];
/** 已捕获终态按精确出现键保留；不借用昵称、相同正文或未经认证的服务端别名。 */
function sourceTerminals(input:Pick<IngestRecordsInput,'tx'|'token'|'target'|'records'>):Map<string,TerminalReason>{
 const {tx,token,target}=input,result=new Map<string,TerminalReason>();
 const keys=[...new Set(input.records.map(record=>prepareRecord(record,token.source_generation,target).localKey).filter((key):key is string=>key!==null))];
 if(!keys.length)return result;
 const placeholders=keys.map(()=>'?').join(',');
 for(const row of tx.all(`SELECT DISTINCT r.observed_key external_key,CASE WHEN r.reason_code='metadata_only' THEN 'source_system_replaced' ELSE r.reason_code END reason FROM capture_record r
  JOIN sync_capture c ON c.owner_id=r.owner_id AND c.contact_id=r.contact_id AND c.id=r.capture_id
  JOIN read_goal g ON g.owner_id=c.owner_id AND g.contact_id=c.contact_id AND g.id=c.goal_id
  WHERE r.owner_id=? AND r.contact_id=? AND g.binding_id=? AND r.availability='available' AND r.observed_scheme='source-table-local-v1' AND r.observed_key IN (${placeholders})
  AND ((r.state='excluded' AND r.reason_code IN ('source_recalled','source_system_replaced'))
   OR (r.state='quarantined' AND r.reason_code='metadata_only' AND json_extract(r.raw_payload,'$.originalType')='10000'))
  UNION ALL SELECT a.external_key,q.reason FROM history_message_quarantine q JOIN message_alias a
  ON a.owner_id=q.owner_id AND a.contact_id=q.contact_id AND a.message_id=q.message_id
  WHERE q.owner_id=? AND q.contact_id=? AND a.binding_id=? AND a.scheme='local' AND a.external_key IN (${placeholders}) AND q.reason IN ('source_recalled','source_system_replaced')
  UNION ALL SELECT external_key,reason FROM history_source_terminal WHERE owner_id=? AND contact_id=? AND binding_id=? AND reason<>'source_absent' AND external_key IN (${placeholders})`,
  [token.owner_id,token.contact_id,token.binding_id,...keys,token.owner_id,token.contact_id,token.binding_id,...keys,token.owner_id,token.contact_id,token.binding_id,...keys]))result.set(String(row.external_key),row.reason as TerminalReason);
 for(const record of input.records){
  const prepared=prepareRecord(record,token.source_generation,target),direct=verifiedTerminalReason(record),reason=direct==='source_absent'?null:
   direct??(record.originalType==='10000'&&record.kind==='other'&&record.text===null&&(!prepared.reason||prepared.reason==='metadata_only')?'source_system_replaced':null);
  if(reason&&prepared.localKey)result.set(prepared.localKey,reason);
 }
 return result;
}
function quarantineMessage(tx:StorageTransaction,token:ReadEligibility,id:unknown,reason:string):boolean{
 const old=tx.get('SELECT reason FROM history_message_quarantine WHERE owner_id=? AND contact_id=? AND message_id=?',[token.owner_id,token.contact_id,id as string]);
 if(old&&(old.reason===reason||terminalReasons.includes(String(old.reason))||reason==='message_state_unverified'))return false;
 tx.run('INSERT INTO history_message_quarantine VALUES(?,?,?,?) ON CONFLICT(owner_id,contact_id,message_id) DO UPDATE SET reason=excluded.reason',[token.owner_id,token.contact_id,id as string,reason]);
 tx.run('UPDATE message SET interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND contact_id=? AND id=?',[token.owner_id,token.contact_id,id as string]);return true;
}
/** 未知状态及文字变为系统消息时先失效；后续页写入失败也不能撤销保护。 */
export function quarantineUnverifiedRecords(input: Pick<IngestRecordsInput,'tx'|'token'|'report'|'target'|'records'|'exclude'>,terminals=sourceTerminals(input)): string[] {
 const {tx,token,report,target}=input;
 let changed=false;const updatedMessageIds=new Set<string>();
 for(const record of input.records){
  const prepared=prepareRecord(record,token.source_generation,target);
  const metadataOnly=record.metadataOnly===true&&(!prepared.reason||prepared.reason==='metadata_only');
  const systemTransition=(record.stateAssurance==='verified'||metadataOnly)&&record.originalType==='10000'&&record.kind==='other';
  const terminalReason=verifiedTerminalReason(record)??(prepared.localKey?terminals.get(prepared.localKey)??null:null);
  if(terminalReason==='source_absent')continue;
  if(record.metadataOnly!==undefined&&!prepared.localKey)continue;
  if((record.stateAssurance==='verified'||metadataOnly)&&!systemTransition&&!terminalReason)continue;
  // 终态必须精确定位一条来源；身份缺失不能扩大为整位联系人的失效。
  if((record.messageState==='recalled'||record.messageState==='absent')&&!prepared.localKey)continue;
  const exclusion=prepared.localKey&&(sourceExcluded(tx,token,prepared,report)?'source_excluded':input.exclude?.({localKey:prepared.localKey,serverKey:prepared.serverKey})??null);
  const local=prepared.localKey?aliasMessage(tx,token,'local',prepared.localKey):undefined;
  const server=report.serverAliasSemantics==='verified_within_scope'&&prepared.serverKey?aliasMessage(tx,token,'server',prepared.serverKey):undefined;
  if(exclusion&&!local&&!server)continue;
  const affected=local||server?[...new Map([local,server].filter((v):v is StorageRow=>Boolean(v)).map(v=>[v.id,v])).values()]
   :prepared.localKey?[]:tx.all("SELECT * FROM message WHERE owner_id=? AND contact_id=? AND binding_id=? AND availability='available'",[token.owner_id,token.contact_id,token.binding_id]);
  for(const old of affected)if(!systemTransition||terminalReason!==null||old.kind==='text'){
   const updated=quarantineMessage(tx,token,old.id,terminalReason??'message_state_unverified');changed=updated||changed;
   if(updated)updatedMessageIds.add(String(old.id));
  }
 }
 if(changed)tx.run('UPDATE contact SET source_revision=source_revision+1 WHERE owner_id=? AND id=?',[token.owner_id,token.contact_id]);
 return [...updatedMessageIds];
}
/**
 * 同一页的逐条接受：先排除，再按稳定来源身份幂等建立消息，最后补可认证字段。
 * 调用者必须已在同一事务复验读资格、游标和固定目标；本函数不发起任何外部读取。
 */
export function ingestRecords(input: IngestRecordsInput): { quarantined: boolean; createdMessageIds: string[]; updatedMessageIds: string[] } {
  const { tx, token, report, target, captureId, at, records } = input;
  const terminals=sourceTerminals(input),updatedMessageIds=new Set(quarantineUnverifiedRecords(input,terminals));
  let quarantined = false;const pendingStates=new Set<string>(),createdMessageIds:string[]=[];
  for (const [index, inputRecord] of records.entries()) {
    const prepared = prepareRecord(inputRecord, token.source_generation, target);
    // 页前保护不能被本页较早的正常出现解除；逐项重放保持真实观察顺序。
    if(inputRecord.stateAssurance!=='verified'||inputRecord.originalType==='10000'&&inputRecord.kind==='other')
      for(const id of quarantineUnverifiedRecords({...input,records:[inputRecord]},terminals))updatedMessageIds.add(id);
    const record = prepared.value;
    let reason: string | null = prepared.reason;
    let message: StorageRow | undefined;
    let excluded = false;
    if(reason&&(terminalReasons.includes(reason)||reason==='metadata_only'))excluded=true;
    if(!reason&&prepared.localKey&&terminals.has(prepared.localKey)){reason=terminals.get(prepared.localKey)!;excluded=true;}
    if (inputRecord.stateAssurance!=='verified') {
      const exclusion=prepared.localKey&&(sourceExcluded(tx,token,prepared,report)?'source_excluded':input.exclude?.({localKey:prepared.localKey,serverKey:prepared.serverKey})??null);
      if (exclusion) { reason=exclusion; excluded=true; }
    }
    if (!reason) {
      const exclusion = sourceExcluded(tx, token, prepared, report) ? 'source_excluded' as const : input.exclude?.({ localKey: prepared.localKey, serverKey: prepared.serverKey }) ?? null;
      if (exclusion) { reason = exclusion; excluded = true; }
    }
    if(prepared.localKey&&terminals.has(prepared.localKey)&&reason!=='source_excluded'&&reason!=='clear_excluded'
      &&!sourceExcluded(tx,token,prepared,report)&&!input.exclude?.({localKey:prepared.localKey,serverKey:prepared.serverKey}))rememberSourceTerminal(tx,token,prepared.localKey,terminals.get(prepared.localKey)!);
    if (!reason) {
      const local = aliasMessage(tx, token, 'local', prepared.localKey!);
      const server = report.serverAliasSemantics === 'verified_within_scope' && prepared.serverKey ? aliasMessage(tx, token, 'server', prepared.serverKey) : undefined;
      if (local && server && local.id !== server.id) reason = 'message_identity_conflict';
      else {
        message = local ?? server;
        if (message && !sameMessage(message, record)) reason = 'message_identity_conflict';
        else if (message) {
          const quarantine=tx.get('SELECT reason FROM history_message_quarantine WHERE owner_id=? AND contact_id=? AND message_id=?',[token.owner_id,token.contact_id,message.id]);
          if(quarantine){
            if(quarantine.reason==='message_state_unverified'&&local?.id===message.id){
              tx.run('DELETE FROM history_message_quarantine WHERE owner_id=? AND contact_id=? AND message_id=?',[token.owner_id,token.contact_id,message.id]);
              tx.run('UPDATE message SET interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND contact_id=? AND id=?',[token.owner_id,token.contact_id,message.id]);
              tx.run('UPDATE contact SET source_revision=source_revision+1 WHERE owner_id=? AND id=?',[token.owner_id,token.contact_id]);
              updatedMessageIds.add(String(message.id));
            }else reason='message_state_unverified';
          }
        }
      }
      if (!reason) {
        if (!message) {
          const id = randomUUID();
          const display = (tx.get('SELECT coalesce(max(display_no),0)+1 AS n FROM message')!.n as bigint);
          tx.run(`INSERT INTO message(owner_id,id,contact_id,binding_id,identity_scheme,external_key,sender_role,kind,text_body,original_type,sent_at,time_precision,order_scheme,order_key,display_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [token.owner_id, id, token.contact_id, token.binding_id, 'source-table-local-v1', prepared.localKey, record.sender, record.kind, record.text, record.originalType, record.sentAt === null ? null : BigInt(record.sentAt), record.timePrecision, record.orderScheme, record.orderKey, display]);
          message = tx.get('SELECT * FROM message WHERE owner_id=? AND id=?', [token.owner_id, id]);
          createdMessageIds.push(id);
        } else if (message.availability !== 'available') {
          // 删除中的消息不接收迟到补写，整页随事务回滚且检查点不推进。
          throw new StorageFailure('history_deletion_in_progress');
        }
        if (message) {
          const updates: string[] = []; const args: SQLInputValue[] = [];
          if (message.sent_at === null && record.sentAt !== null) { updates.push('sent_at=?', 'time_precision=?'); args.push(BigInt(record.sentAt), record.timePrecision); }
          if (record.orderScheme !== null && (message.order_scheme !== record.orderScheme || message.order_key !== record.orderKey)) { updates.push('order_scheme=?', 'order_key=?'); args.push(record.orderScheme, record.orderKey); }
          // 状态只记录渠道给出的原始值；未知或缺失不猜测完成，也不清除已有观察。
          if (record.status !== undefined && record.status !== null && String(record.status) !== String(message.status_code ?? '')) { updates.push('status_code=?', 'status_observed_at=?'); args.push(String(record.status), BigInt(at)); }
          if (updates.length) {tx.run(`UPDATE message SET ${updates.join(',')},interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND id=?`, [...args, token.owner_id, message.id]);updatedMessageIds.add(String(message.id));}
        }
        for (const [scheme, key] of [['local', prepared.localKey], ['server', report.serverAliasSemantics === 'verified_within_scope' ? prepared.serverKey : null]] as const)
          if (key) tx.run('INSERT OR IGNORE INTO message_alias(owner_id,id,contact_id,binding_id,scheme,external_key,message_id) VALUES(?,?,?,?,?,?,?)', [token.owner_id, randomUUID(), token.contact_id, token.binding_id, scheme, key, message!.id]);
      }
    }
    if(reason==='message_state_unverified'&&prepared.localKey)pendingStates.add(prepared.localKey);
    else if (reason && reason !== 'source_excluded' && reason !== 'clear_excluded' && reason !== 'metadata_only' && !terminalReasons.includes(reason)) quarantined = true;
    else if(prepared.localKey)pendingStates.delete(prepared.localKey);
    if(!reason&&prepared.localKey&&record.stateAssurance==='verified'){
      // 仅清理同一绑定、代次、状态和服务端身份的无正文未知状态；有任何下游引用时保留。
      tx.run(`DELETE FROM capture_record WHERE owner_id=? AND contact_id=? AND id IN (
        SELECT r.id FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
        JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
        WHERE r.owner_id=? AND r.contact_id=? AND r.observed_key=? AND r.state='quarantined'
          AND r.reason_code='message_state_unverified' AND r.availability='available'
          AND g.binding_id=? AND g.accepted_data_generation=? AND json_valid(r.raw_payload)
          AND json_extract(r.raw_payload,'$.text') IS NULL AND json_extract(r.raw_payload,'$.status') IS ?
          AND json_extract(r.raw_payload,'$.serverId') IS ?
          AND NOT EXISTS (SELECT 1 FROM event_source x WHERE x.owner_id=r.owner_id AND x.record_id=r.id)
          AND NOT EXISTS (SELECT 1 FROM run_input x WHERE x.owner_id=r.owner_id AND x.record_id=r.id)
          AND NOT EXISTS (SELECT 1 FROM step_input x WHERE x.owner_id=r.owner_id AND x.record_id=r.id)
          AND NOT EXISTS (SELECT 1 FROM memory_citation x WHERE x.owner_id=r.owner_id AND x.record_id=r.id)
          AND NOT EXISTS (SELECT 1 FROM reply_context_item x WHERE x.owner_id=r.owner_id AND x.record_id=r.id)
          AND NOT EXISTS (SELECT 1 FROM reply_candidate_input_source x WHERE x.owner_id=r.owner_id AND x.record_id=r.id)
          AND NOT EXISTS (SELECT 1 FROM media_extraction_attempt x WHERE x.owner_id=r.owner_id AND x.record_id=r.id))`,
        [token.owner_id,token.contact_id,token.owner_id,token.contact_id,prepared.localKey,token.binding_id,BigInt(token.data_generation),record.status??null,record.serverId]);
    }
    if (!reason && message && prepared.localKey) {
      const priorSource=tx.get(`SELECT r.id FROM capture_record r
      JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
      JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
      WHERE r.owner_id=? AND r.contact_id=? AND r.message_id=? AND r.observed_key=?
        AND r.state='normalized' AND r.availability='available'
        AND g.binding_id=? AND g.accepted_data_generation<=?
        AND NOT EXISTS (SELECT 1 FROM capture_record q JOIN sync_capture qc ON qc.owner_id=q.owner_id AND qc.id=q.capture_id
          JOIN read_goal qg ON qg.owner_id=qc.owner_id AND qg.id=qc.goal_id
          WHERE q.owner_id=r.owner_id AND q.contact_id=r.contact_id AND q.observed_key=r.observed_key
          AND qg.binding_id=g.binding_id AND q.state='quarantined' AND q.availability='available'
          AND (c.acceptance_no IS NULL OR qc.acceptance_no>c.acceptance_no
            OR (qc.acceptance_no=c.acceptance_no AND q.item_no>r.item_no))) LIMIT 1`,
      [token.owner_id,token.contact_id,message.id,prepared.localKey,token.binding_id,BigInt(token.data_generation)]);
      if(priorSource){
        const quoteInput={token,recordId:String(priorSource.id),messageId:String(message.id),version:quoteParserVersion};
        const quoteResult=prepared.quote?saveHistoryQuoteInTransaction(tx,{...quoteInput,content:prepared.quote,proofDigest:prepared.quote.proofDigest})
          :prepared.quoteErrorCode?failHistoryQuoteInTransaction(tx,{...quoteInput,errorCode:prepared.quoteErrorCode}):null;
        if(quoteResult?.changed)updatedMessageIds.add(String(message.id));
        continue;
      }
    }
    if (excluded && prepared.localKey && tx.get(`SELECT 1 FROM capture_record r
      JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
      JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
      WHERE r.owner_id=? AND r.contact_id=? AND r.observed_key=? AND r.state='excluded'
        AND r.reason_code=? AND r.availability='available'
        AND g.binding_id=? AND g.accepted_data_generation<=? LIMIT 1`,
      [token.owner_id,token.contact_id,prepared.localKey,reason,token.binding_id,BigInt(token.data_generation)])) continue;
    if (reason && !excluded && prepared.localKey && tx.get(`SELECT 1 FROM capture_record r
      JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
      JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
      WHERE r.owner_id=? AND r.contact_id=? AND r.observed_key=? AND r.state='quarantined'
        AND r.reason_code=? AND r.raw_payload=? AND r.availability='available'
        AND g.binding_id=? AND g.accepted_data_generation=?
        AND NOT EXISTS (SELECT 1 FROM capture_record later JOIN sync_capture lc ON lc.owner_id=later.owner_id AND lc.id=later.capture_id
          JOIN read_goal lg ON lg.owner_id=lc.owner_id AND lg.id=lc.goal_id
          WHERE later.owner_id=r.owner_id AND later.contact_id=r.contact_id AND later.observed_key=r.observed_key
          AND lg.binding_id=g.binding_id AND later.availability='available' AND lc.acceptance_no IS NOT NULL
          AND (c.acceptance_no IS NULL OR lc.acceptance_no>c.acceptance_no
            OR (lc.acceptance_no=c.acceptance_no AND later.item_no>r.item_no))) LIMIT 1`,
      [token.owner_id,token.contact_id,prepared.localKey,reason,prepared.raw,token.binding_id,BigInt(token.data_generation)])) continue;
    // 正文存于消息表，来源记录仅保留渠道信息。
    const singleTextCopy=!reason&&record.kind==='text';
    const sourcePayload=singleTextCopy?JSON.stringify({...record,text:null}):prepared.raw;
    const recordId=randomUUID();
    tx.run('INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version,reason_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [token.owner_id, recordId, token.contact_id, captureId, index, excluded ? 'excluded' : reason ? 'quarantined' : 'normalized', reason ? null : message!.id, excluded ? null : sourcePayload, prepared.localKey ? 'source-table-local-v1' : null, prepared.localKey, singleTextCopy?'2':'1', reason]);
    if(!reason&&!excluded&&message&&prepared.quote){
      saveHistoryQuoteInTransaction(tx,{token,recordId,messageId:String(message.id),version:quoteParserVersion,content:prepared.quote,proofDigest:prepared.quote.proofDigest});
    }else if(!reason&&!excluded&&message&&prepared.quoteErrorCode){
      failHistoryQuoteInTransaction(tx,{token,recordId,messageId:String(message.id),version:quoteParserVersion,errorCode:prepared.quoteErrorCode});
    }
  }
  return { quarantined:quarantined||pendingStates.size>0, createdMessageIds, updatedMessageIds:[...updatedMessageIds] };
}
