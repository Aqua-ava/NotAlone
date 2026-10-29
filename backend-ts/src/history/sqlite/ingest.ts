import { randomUUID } from 'node:crypto';
import type { SQLInputValue } from 'node:sqlite';
import { StorageFailure, type StorageRow, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { ReadEligibility } from '../../contacts/sqlite/contracts.ts';
import type { HistoryRecord, HistorySupportReport, HistoryTarget } from './contracts.ts';
import { prepareRecord } from './normalize.ts';

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
/**
 * 同一页的逐条接受：先排除，再按稳定来源身份幂等建立消息，最后补可认证字段。
 * 调用者必须已在同一事务复验读资格、游标和固定目标；本函数不发起任何外部读取。
 */
export function ingestRecords(input: IngestRecordsInput): { quarantined: boolean } {
  const { tx, token, report, target, captureId, at, records } = input;
  let quarantined = false;
  for (const [index, inputRecord] of records.entries()) {
    const prepared = prepareRecord(inputRecord, token.source_generation, target);
    const record = prepared.value;
    let reason: string | null = prepared.reason;
    let message: StorageRow | undefined;
    let excluded = false;
    if (!reason) {
      const exclusion = sourceExcluded(tx, token, prepared, report) ? 'source_excluded' as const : input.exclude?.({ localKey: prepared.localKey, serverKey: prepared.serverKey }) ?? null;
      if (exclusion) { reason = exclusion; excluded = true; }
    }
    if (!reason) {
      const local = aliasMessage(tx, token, 'local', prepared.localKey!);
      const server = report.serverAliasSemantics === 'verified_within_scope' && prepared.serverKey ? aliasMessage(tx, token, 'server', prepared.serverKey) : undefined;
      if (local && server && local.id !== server.id) reason = 'message_identity_conflict';
      else {
        message = local ?? server;
        if (message && !sameMessage(message, record)) reason = 'message_identity_conflict';
      }
      if (!reason) {
        if (!message) {
          const id = randomUUID();
          const display = (tx.get('SELECT coalesce(max(display_no),0)+1 AS n FROM message')!.n as bigint);
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
    if (reason && reason !== 'source_excluded' && reason !== 'clear_excluded') quarantined = true;
    tx.run('INSERT INTO capture_record(owner_id,id,contact_id,capture_id,item_no,state,message_id,raw_payload,observed_scheme,observed_key,normalizer_version,reason_code) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [token.owner_id, randomUUID(), token.contact_id, captureId, index, excluded ? 'excluded' : reason ? 'quarantined' : 'normalized', reason ? null : message!.id, excluded ? null : prepared.raw, prepared.localKey ? 'source-table-local-v1' : null, prepared.localKey, '1', reason]);
  }
  return { quarantined };
}
