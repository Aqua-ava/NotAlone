import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { StorageFailure, type StorageRow, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistoryRecord, HistorySupportReport, HistoryTarget } from './contracts.ts';
import { verifiedTerminalReason, prepareRecord } from './normalize.ts';

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
function nextDisplayPosition(tx:StorageTransaction):bigint {
  return tx.get('SELECT max(coalesce((SELECT max(display_no) FROM message),0),coalesce((SELECT max(display_no) FROM capture_record),0))+1 AS n')!.n as bigint;
}
function sourceExcluded(tx: StorageTransaction, token: ReadEligibility, prepared: ReturnType<typeof prepareRecord>, report: HistorySupportReport): boolean {
  if (!prepared.localKey) return false;
  return Boolean(tx.get("SELECT 1 FROM history_source_exclusion WHERE owner_id=? AND conversation_id=? AND ((scheme='local' AND external_key=?) OR (scheme='server' AND external_key=?))", [token.owner_id, token.conversation_id, prepared.localKey, report.serverAliasSemantics === 'verified_within_scope' ? prepared.serverKey : null]));
}
/** 未知状态及文字变为系统消息时先失效；后续页写入失败也不能撤销保护。 */
export function quarantineUnverifiedRecords(input: Pick<IngestRecordsInput,'tx'|'token'|'report'|'target'|'records'|'exclude'>): void {
 const {tx,token,report,target}=input;
 let changed=false;
 for(const record of input.records){
  const systemTransition=record.stateAssurance==='verified'&&record.originalType==='10000'&&record.kind==='other';
  const terminalReason=verifiedTerminalReason(record);
  if(terminalReason==='source_absent')continue;
  if(record.stateAssurance==='verified'&&!systemTransition&&!terminalReason)continue;
  const prepared=prepareRecord(record,token.source_generation,target);
  // 终态必须精确定位一条来源；身份缺失不能扩大为整位联系人的失效。
  if((record.messageState==='recalled'||record.messageState==='absent')&&!prepared.localKey)continue;
  const exclusion=prepared.localKey&&(sourceExcluded(tx,token,prepared,report)?'source_excluded':input.exclude?.({localKey:prepared.localKey,serverKey:prepared.serverKey})??null);
  const local=prepared.localKey?aliasMessage(tx,token,'local',prepared.localKey):undefined;
  const server=report.serverAliasSemantics==='verified_within_scope'&&prepared.serverKey?aliasMessage(tx,token,'server',prepared.serverKey):undefined;
  if(exclusion&&!local&&!server)continue;
  const recallVerified=terminalReason==='source_recalled'&&!(local&&server&&local.id!==server.id);
  const affected=local||server?[...new Map([local,server].filter((v):v is StorageRow=>Boolean(v)).map(v=>[v.id,v])).values()]
   :prepared.localKey?[]:tx.all("SELECT * FROM message WHERE owner_id=? AND contact_id=? AND binding_id=? AND availability='available'",[token.owner_id,token.contact_id,token.binding_id]);
  for(const old of affected){
   if(systemTransition&&terminalReason===null&&old.kind!=='text')continue;
   const existing=tx.get('SELECT reason FROM history_message_quarantine WHERE owner_id=? AND contact_id=? AND message_id=?',[token.owner_id,token.contact_id,old.id]);
   if(!existing)tx.run('INSERT INTO history_message_quarantine VALUES(?,?,?,?)',[token.owner_id,token.contact_id,old.id,recallVerified?'source_recalled':'message_state_unverified']);
   else if(recallVerified&&existing.reason!=='source_recalled')tx.run("UPDATE history_message_quarantine SET reason='source_recalled' WHERE owner_id=? AND contact_id=? AND message_id=?",[token.owner_id,token.contact_id,old.id]);
   else continue;
   tx.run('UPDATE message SET interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND contact_id=? AND id=?',[token.owner_id,token.contact_id,old.id]);changed=true;
  }
 }
 if(changed)tx.run('UPDATE contact SET source_revision=source_revision+1 WHERE owner_id=? AND id=?',[token.owner_id,token.contact_id]);
}
/**
 * 同一页的逐条接受：先排除，再按稳定来源身份幂等建立消息，最后补可认证字段。
 * 调用者必须已在同一事务复验读资格、游标和固定目标；本函数不发起任何外部读取。
 */
export function ingestRecords(input: IngestRecordsInput): { quarantined: boolean } {
  const { tx, token, report, target, captureId, at, records } = input;
  quarantineUnverifiedRecords(input);
  let quarantined = false;
  for (const [index, inputRecord] of records.entries()) {
    const prepared = prepareRecord(inputRecord, token.source_generation, target);
    const record = prepared.value;
    let reason: string | null = prepared.reason;
    let message: StorageRow | undefined;
    let excluded = false;
    if(reason==='source_recalled'||reason==='source_absent')excluded=true;
    if(excluded&&prepared.localKey){
      const exclusion=sourceExcluded(tx,token,prepared,report)?'source_excluded':input.exclude?.({localKey:prepared.localKey,serverKey:prepared.serverKey})??null;
      if(exclusion)reason=exclusion;
    }
    if (inputRecord.stateAssurance!=='verified') {
      const exclusion=prepared.localKey&&(sourceExcluded(tx,token,prepared,report)?'source_excluded':input.exclude?.({localKey:prepared.localKey,serverKey:prepared.serverKey})??null);
      if (exclusion) { reason=exclusion; excluded=true; }
    }
    if (!reason) {
      const exclusion = sourceExcluded(tx, token, prepared, report) ? 'source_excluded' as const : input.exclude?.({ localKey: prepared.localKey, serverKey: prepared.serverKey }) ?? null;
      if (exclusion) { reason = exclusion; excluded = true; }
    }
    if (!reason && prepared.localKey && tx.get(`SELECT 1 FROM capture_record r
      JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
      JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
      WHERE r.owner_id=? AND r.contact_id=? AND r.observed_key=? AND r.reason_code='source_recalled'
        AND r.display_no IS NOT NULL AND r.availability='available' AND g.binding_id=? LIMIT 1`,
      [token.owner_id,token.contact_id,prepared.localKey,token.binding_id])) { reason='source_recalled';excluded=true; }
    if (!reason) {
      const local = aliasMessage(tx, token, 'local', prepared.localKey!);
      const server = report.serverAliasSemantics === 'verified_within_scope' && prepared.serverKey ? aliasMessage(tx, token, 'server', prepared.serverKey) : undefined;
      if (local && server && local.id !== server.id) reason = 'message_identity_conflict';
      else {
        message = local ?? server;
        if (message && !sameMessage(message, record)) reason = 'message_identity_conflict';
        else if (message && tx.get('SELECT 1 FROM history_message_quarantine WHERE owner_id=? AND contact_id=? AND message_id=?',[token.owner_id,token.contact_id,message.id])) reason = 'message_state_unverified';
      }
      if (!reason) {
        if (!message) {
          const id = randomUUID();
          const display = nextDisplayPosition(tx);
          tx.run(`INSERT INTO message(owner_id,id,contact_id,binding_id,identity_scheme,external_key,sender_role,kind,text_body,original_type,sent_at,time_precision,order_scheme,order_key,display_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [token.owner_id, id, token.contact_id, token.binding_id, 'source-table-local-v1', prepared.localKey, record.sender, record.kind, record.text, record.originalType, record.sentAt === null ? null : BigInt(record.sentAt), record.timePrecision, record.orderScheme, record.orderKey, display]);
          message = tx.get('SELECT * FROM message WHERE owner_id=? AND id=?', [token.owner_id, id]);
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
          if (updates.length) tx.run(`UPDATE message SET ${updates.join(',')},interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND id=?`, [...args, token.owner_id, message.id]);
        }
        for (const [scheme, key] of [['local', prepared.localKey], ['server', report.serverAliasSemantics === 'verified_within_scope' ? prepared.serverKey : null]] as const)
          if (key) tx.run('INSERT OR IGNORE INTO message_alias(owner_id,id,contact_id,binding_id,scheme,external_key,message_id) VALUES(?,?,?,?,?,?,?)', [token.owner_id, randomUUID(), token.contact_id, token.binding_id, scheme, key, message!.id]);
      }
    }
    if (!reason && message && prepared.localKey && tx.get(`SELECT 1 FROM capture_record r
      JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
      JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
      WHERE r.owner_id=? AND r.contact_id=? AND r.message_id=? AND r.observed_key=?
        AND r.state='normalized' AND r.availability='available'
        AND g.binding_id=? AND g.accepted_data_generation<=? LIMIT 1`,
      [token.owner_id,token.contact_id,message.id,prepared.localKey,token.binding_id,BigInt(token.data_generation)])) continue;
    if (excluded && prepared.localKey && tx.get(`SELECT 1 FROM capture_record r
      JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
      JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
      WHERE r.owner_id=? AND r.contact_id=? AND r.observed_key=? AND r.state='excluded'
        AND r.reason_code=? AND r.availability='available'
        AND g.binding_id=? AND g.accepted_data_generation<=? LIMIT 1`,
      [token.owner_id,token.contact_id,prepared.localKey,reason,token.binding_id,BigInt(token.data_generation)])) continue;
    if (reason && reason !== 'source_excluded' && reason !== 'clear_excluded' && reason !== 'source_recalled' && reason !== 'source_absent') {
      quarantined = true;
      if (prepared.localKey && tx.get(`SELECT 1 FROM capture_record r
        JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id
        JOIN read_goal g ON g.owner_id=c.owner_id AND g.id=c.goal_id
        WHERE r.owner_id=? AND r.contact_id=? AND r.observed_key=? AND r.state='quarantined'
          AND r.reason_code=? AND r.raw_payload=? AND r.availability='available'
          AND g.binding_id=? AND g.accepted_data_generation=? LIMIT 1`,
        [token.owner_id,token.contact_id,prepared.localKey,reason,prepared.raw,token.binding_id,BigInt(token.data_generation)])) continue;
    }
    // 已规范化文字的正文只存于消息表；来源记录保留不含正文的必要渠道字段。
    const singleTextCopy=!reason&&record.kind==='text';
    const sourcePayload=singleTextCopy?JSON.stringify({...record,text:null}):prepared.raw;
    const noKnownMessage=reason==='source_recalled'&&prepared.localKey&&!aliasMessage(tx,token,'local',prepared.localKey)
      &&!(report.serverAliasSemantics==='verified_within_scope'&&prepared.serverKey&&aliasMessage(tx,token,'server',prepared.serverKey));
    const displayNo=noKnownMessage?nextDisplayPosition(tx):null;
    tx.run('INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version,reason_code,display_no) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', [token.owner_id, randomUUID(), token.contact_id, captureId, index, excluded ? 'excluded' : reason ? 'quarantined' : 'normalized', reason ? null : message!.id, excluded ? null : sourcePayload, prepared.localKey ? 'source-table-local-v1' : null, prepared.localKey, singleTextCopy?'2':'1', reason,displayNo]);
  }
  return { quarantined };
}
