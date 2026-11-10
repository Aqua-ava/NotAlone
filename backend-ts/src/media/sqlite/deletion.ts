import {sourceDeletionIds} from '../../history/sqlite/source-deletion.ts';
import { createHash } from 'node:crypto';
import { sameFileIdentity } from '../../storage/sqlite/deletion/file-identity.ts';
import { StorageFailure, type StorageRow, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import type { CheckResult, DeletionAuthority, DeletionDomain, DeletionOperation, DeletionRegistration, DeletionScope, DeletionTarget, FileDeletionTarget, ManagedAddress, RowDeletionTarget } from '../../storage/sqlite/deletion/contracts.ts';

const fail = (code: string): never => { throw new StorageFailure(code); };
const passed = (proof: string): CheckResult => ({result: 'passed', proof});
const blocked = (proof: string): CheckResult => ({result: 'blocked', proof});
export const isMediaDeletionScope = (scope: DeletionScope): scope is Extract<DeletionScope, {messageId: string}> => scope.kind === 'media_result_clear' || scope.kind === 'media_result_replace';
const isMedia=isMediaDeletionScope;
const same = (left: unknown, right: unknown): boolean => canonical(left) === canonical(right);
export function canonical(value: unknown): string { return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item); }
export const identity = (kind: string, key: Record<string, string>): string => createHash('sha256').update(canonical([kind, key])).digest('hex');
const rowKinds = {
  message_media: {keys: ['owner_id', 'message_id'], ownerKey: 'owner_id'},
  media_extraction_attempt: {keys: ['owner_id', 'id'], ownerKey: 'owner_id'},
  media_file: {keys: ['owner_id', 'id'], ownerKey: 'owner_id'},
};

/** 单独清媒体只推进媒体自己的代次；不会撤销联系人其他资料或读取许可。 */
export const mediaDeletionAuthority: DeletionAuthority = {
  fence(tx, ownerId, scope) {
    if (!isMedia(scope)) return fail('media_deletion_scope_invalid');
    const head = tx.get('SELECT media_generation FROM message_media WHERE owner_id=? AND contact_id=? AND message_id=?', [ownerId, scope.contactId, scope.messageId]);
    if (!head) return fail('media_not_found');
    if (scope.kind === 'media_result_replace') return head.media_generation as bigint;
    tx.run("UPDATE message_media SET media_generation=media_generation+1,head_revision=head_revision+1,state='cleared' WHERE owner_id=? AND contact_id=? AND message_id=?", [ownerId, scope.contactId, scope.messageId]);
    return (head.media_generation as bigint) + 1n;
  },
  verify(tx, op) {
    if (!isMedia(op.scope)) return blocked('media_deletion_scope_invalid');
    const head = tx.get('SELECT media_generation FROM message_media WHERE owner_id=? AND contact_id=? AND message_id=?', [op.ownerId, op.scope.contactId, op.scope.messageId]);
    if (typeof head?.media_generation === 'bigint' && head.media_generation >= op.acceptedGeneration) return passed('media_generation_fenced');
    // 来源/联系人删除可能先清掉head；旧操作仍须走文件身份、闭包和存储面的完整复核。
    const persisted = tx.get('SELECT 1 FROM deletion_operation WHERE operation_id=? AND owner_identity=? AND message_identity=? AND accepted_generation=?', [op.operationId, op.ownerId, op.scope.messageId, op.acceptedGeneration]);
    const empty = !tx.get('SELECT 1 FROM media_extraction_attempt WHERE owner_id=? AND message_id=?', [op.ownerId, op.scope.messageId])
      && !tx.get('SELECT 1 FROM media_file WHERE owner_id=? AND message_id=?', [op.ownerId, op.scope.messageId]);
    return !head && persisted && empty ? passed('media_head_removed_execution_empty') : blocked('media_generation_missing_or_stale');
  },
};

interface Selection { attempts: StorageRow[]; files: StorageRow[]; heads: StorageRow[] }
/** 来源只沿实际生产、输入及父文件关系闭包；同一消息的其他来源不能替换旧证明。 */
function select(tx: StorageTransaction, op: DeletionOperation): Selection {
  const {ownerId, scope} = op;
  const deletionSources=new Set(sourceDeletionIds(tx,op));
  if (scope.kind === 'discussion') return {attempts: [], files: [], heads: []};
  const params = scope.kind === 'account' ? [ownerId] : [ownerId, scope.contactId];
  const clause = scope.kind === 'account' ? 'owner_id=?' : 'owner_id=? AND contact_id=?';
  const attempts = tx.all(`SELECT * FROM media_extraction_attempt WHERE ${clause}`, params);
  const files = tx.all(`SELECT * FROM media_file WHERE ${clause}`, params);
  const heads = tx.all(`SELECT * FROM message_media WHERE ${clause}`, params);
  const chosenAttempts = new Set<string>();
  const chosenFiles = new Set<string>();
  for (const a of attempts) {
    const match = a.cleanup_operation_id === op.operationId || (isMedia(scope)
      ? scope.kind === 'media_result_clear' && a.message_id === scope.messageId && (a.accepted_media_generation as bigint) < op.acceptedGeneration
      : scope.kind === 'source' ? deletionSources.has(String(a.record_id))
        : scope.kind === 'account' || scope.kind === 'contact' || (a.accepted_data_generation as bigint) < op.acceptedGeneration);
    if (match) chosenAttempts.add(String(a.id));
  }
  for (const f of files) {
    if (f.cleanup_operation_id === op.operationId || (scope.kind === 'media_result_replace' && f.message_id === scope.messageId
      && (f.publish_state === 'retired' || f.publish_state === 'cleanup_pending'
        || (f.publish_state === 'staged' && attempts.some(a => a.id === f.produced_attempt_id && !['pending', 'running'].includes(String(a.state))))))) chosenFiles.add(String(f.id));
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const f of files) if (!chosenFiles.has(String(f.id)) && (chosenAttempts.has(String(f.produced_attempt_id)) || (f.parent_file_id && chosenFiles.has(String(f.parent_file_id))))) {
      chosenFiles.add(String(f.id)); changed = true;
    }
    for (const a of attempts) if (!chosenAttempts.has(String(a.id)) && a.input_file_id && chosenFiles.has(String(a.input_file_id))) {
      chosenAttempts.add(String(a.id)); changed = true;
    }
  }
  // 替换仅清旧组合；仍支撑current文件的生产尝试及其证明保留。
  if (scope.kind === 'media_result_replace') {
    for (const a of attempts) if (a.state === 'completed'
      && !files.some(f => f.produced_attempt_id === a.id && !chosenFiles.has(String(f.id)))
      && files.some(f => f.produced_attempt_id === a.id && chosenFiles.has(String(f.id)))) chosenAttempts.add(String(a.id));
  }
  const sourceMessages = new Set(scope.kind === 'source' ? tx.all('SELECT DISTINCT message_id FROM capture_record WHERE owner_id=? AND contact_id=? AND id IN (SELECT value FROM json_each(?))', [ownerId, scope.contactId, JSON.stringify([...deletionSources])]).map(row=>row.message_id) : []);
  const selectedHeads = isMedia(scope) ? [] : heads.filter(h => {
    const related = attempts.filter(a => a.message_id === h.message_id);
    if (related.some(a => !chosenAttempts.has(String(a.id)))) return false;
    return related.some(a => chosenAttempts.has(String(a.id))) || sourceMessages.has(h.message_id) || scope.kind === 'account' || scope.kind === 'contact'
      || !!tx.get("SELECT 1 FROM message WHERE owner_id=? AND id=? AND availability='deleting'", [ownerId, h.message_id]);
  });
  return {attempts: attempts.filter(a => chosenAttempts.has(String(a.id))), files: files.filter(f => chosenFiles.has(String(f.id))), heads: selectedHeads};
}
/** 依赖域只以本操作实际清除的文件版本为种子，不把媒体代次当联系人资料代次。 */
export function mediaDeletionFileIds(tx:StorageTransaction,op:DeletionOperation):string[]{
  if(!isMedia(op.scope))return [];
  return select(tx,op).files.map(file=>String(file.id));
}
function holderKeys(a: StorageRow | undefined, fileId?: string): string[] {
  return [...(a ? [`mediaAttempt:${a.id}`] : []), ...(fileId ? [`mediaFile:${fileId}`,`mediaProbe:${fileId}`] : [])];
}
function rowTarget(op: DeletionOperation, kind: keyof typeof rowKinds, row: StorageRow, keys: string[]): RowDeletionTarget {
  const key: Record<string, string> = kind === 'message_media' ? {owner_id: op.ownerId, message_id: String(row.message_id)} : {owner_id: op.ownerId, id: String(row.id)};
  return {kind: 'row', domain: 'media', rowKind: kind, key, identity: identity(kind, key), holderKeys: keys};
}
function address(file: StorageRow): ManagedAddress | null {
  if (!file.managed_address) return null;
  let result: ManagedAddress;
  try { result = JSON.parse(String(file.managed_address)) as ManagedAddress; } catch { return fail('media_file_identity_unverified'); }
  if (result.area !== 'media' || result.kind !== 'file' || result.locator !== file.managed_locator || !sameFileIdentity(result.identity, JSON.parse(String(file.expected_file_identity)))) return fail('media_file_identity_unverified');
  return result;
}
function collect(tx: StorageTransaction, op: DeletionOperation): DeletionTarget[] {
  const selected = select(tx, op), targets: DeletionTarget[] = [];
  // 先清字节，再清带FK的三实体；注册时本域也必须先于history/identity。
  for (const file of selected.files) {
    if (file.content_state === 'erased') continue;
    const location = address(file), attempt = selected.attempts.find(a => a.id === file.produced_attempt_id)
      ?? tx.get('SELECT * FROM media_extraction_attempt WHERE owner_id=? AND id=?', [op.ownerId, file.produced_attempt_id]);
    if (location && attempt) targets.push({kind: 'file', domain: 'media', ownerId: op.ownerId, fileId: String(file.id), generation: String(attempt.accepted_media_generation), address: location, holderKeys: holderKeys(attempt, String(file.id))});
  }
  for (const file of selected.files) targets.push(rowTarget(op, 'media_file', file, holderKeys(selected.attempts.find(a => a.id === file.produced_attempt_id)
    ?? tx.get('SELECT * FROM media_extraction_attempt WHERE owner_id=? AND id=?', [op.ownerId, file.produced_attempt_id]), String(file.id))));
  for (const attempt of selected.attempts) targets.push(rowTarget(op, 'media_extraction_attempt', attempt, holderKeys(attempt)));
  for (const head of selected.heads) targets.push(rowTarget(op, 'message_media', head, []));
  return targets;
}
function planned(tx: StorageTransaction, op: DeletionOperation, target: DeletionTarget): boolean {
  return tx.all("SELECT target_payload FROM deletion_target WHERE operation_id=? AND domain='media' AND target_payload IS NOT NULL", [op.operationId])
    .some(row => same(JSON.parse(String(row.target_payload)), target));
}
function authorizeFile(tx: StorageTransaction, op: DeletionOperation, target: FileDeletionTarget): void {
  if (target.domain !== 'media' || target.ownerId !== op.ownerId || !planned(tx, op, target)) return fail('media_deletion_target_invalid');
  const file = tx.get('SELECT * FROM media_file WHERE owner_id=? AND id=?', [op.ownerId, target.fileId]);
  // 另一已登记操作可能先清掉同一固定副本；定位永不复用，仍核对没有新live文件占用。
  if (!file) {
    if (tx.get('SELECT 1 FROM media_file WHERE owner_id=? AND managed_locator=?', [op.ownerId, target.address.locator])) return fail('media_file_retained');
    return;
  }
  if (file.content_state === 'erased') return;
  const producer = tx.get('SELECT accepted_media_generation FROM media_extraction_attempt WHERE owner_id=? AND id=?', [op.ownerId, file.produced_attempt_id]);
  if (file.publish_state !== 'cleanup_pending' || String(producer?.accepted_media_generation) !== target.generation || !same(address(file), target.address)) return fail('media_file_retained');
  if (tx.get("SELECT 1 FROM media_file WHERE owner_id=? AND parent_file_id=? AND publish_state='current' AND content_state='present'", [op.ownerId, target.fileId])) return fail('media_parent_still_required');
  if (!select(tx, op).files.some(f => f.id === target.fileId)) return fail('media_deletion_target_invalid');
}


function purge(tx: StorageTransaction, op: DeletionOperation): boolean {
  const selected = select(tx, op);
  if (selected.files.some(f => f.content_state !== 'erased')) return false;
  // 输入/生产/父件FK为延迟约束，整个闭包在此短事务内删除，不逐目标打断循环关系。
  for (const f of selected.files) tx.run('DELETE FROM media_file WHERE owner_id=? AND id=?', [op.ownerId, f.id]);
  for (const a of selected.attempts) tx.run('DELETE FROM media_extraction_attempt WHERE owner_id=? AND id=?', [op.ownerId, a.id]);
  for (const h of selected.heads) {
    if (!tx.get('SELECT 1 FROM media_extraction_attempt WHERE owner_id=? AND message_id=?', [op.ownerId, h.message_id])
      && !tx.get('SELECT 1 FROM media_file WHERE owner_id=? AND message_id=?', [op.ownerId, h.message_id])) tx.run('DELETE FROM message_media WHERE owner_id=? AND message_id=?', [op.ownerId, h.message_id]);
  }
  return true;
}

export const mediaDeletionDomain: DeletionDomain = {
  id: 'media', rowKinds,
  fence(tx, op) {
    const selected = select(tx, op);
    if (op.scope.kind === 'media_result_replace' && selected.files.some(f => f.publish_state === 'current')) return fail('media_parent_still_required');
    for (const file of selected.files) tx.run("UPDATE media_file SET cleanup_operation_id=COALESCE(cleanup_operation_id,?),publish_state='cleanup_pending' WHERE owner_id=? AND id=?", [op.operationId, op.ownerId, file.id]);
    for (const attempt of selected.attempts) {
      if (op.scope.kind === 'media_result_replace' && selected.files.some(f => f.produced_attempt_id === attempt.id && f.publish_state === 'current')) continue;
      tx.run("UPDATE media_extraction_attempt SET cleanup_operation_id=COALESCE(cleanup_operation_id,?),state='revoked',result_outcome='no_result',lease_token=NULL,lease_expires_at=NULL,finished_at=COALESCE(finished_at,?) WHERE owner_id=? AND id=?", [op.operationId, Date.now(), op.ownerId, attempt.id]);
    }
    if (!isMedia(op.scope)) for (const head of selected.heads) tx.run("UPDATE message_media SET state='invalidated' WHERE owner_id=? AND message_id=?", [op.ownerId, head.message_id]);
    return selected.attempts.map(a => ({namespace: 'media.extract', key: String(a.request_key)}));
  },
  collect,
  clearRow(tx, op, target) {
    if (target.domain !== 'media' || !Object.hasOwn(rowKinds, target.rowKind) || target.key.owner_id !== op.ownerId || target.identity !== identity(target.rowKind, target.key) || !planned(tx, op, target)) return fail('media_deletion_target_invalid');
    if (purge(tx, op)) return;
    const present = select(tx, op).files.filter(f => f.content_state !== 'erased');
    if (present.some(f => !f.managed_address)) return fail('media_file_identity_unverified');
    const filePlans = tx.all("SELECT target_payload FROM deletion_target WHERE operation_id=? AND domain='media' AND storage_kind='file' AND target_payload IS NOT NULL", [op.operationId]).map(r => JSON.parse(String(r.target_payload)) as FileDeletionTarget);
    if (present.some(f => !filePlans.some(t => t.fileId === f.id && same(t.address, address(f))))) return fail('media_files_remain');
    // 晚到身份会把新文件目标追加到旧行目标之后；其字节清完的回调再原子清行。

  },
  authorizeFile,
  fileCleared(tx, op, target) {
    authorizeFile(tx, op, target);
    tx.run("UPDATE media_file SET content_state='erased',publish_state='cleanup_pending',managed_locator=NULL,expected_file_identity=NULL,managed_address=NULL,quality_proof=NULL,image_quality_evidence=NULL,content_digest=NULL,byte_size=NULL,format=NULL,mime_type=NULL WHERE owner_id=? AND id=?", [op.ownerId, target.fileId]);
    purge(tx, op);
  },
  verify(tx, op) {
    const selected = select(tx, op), empty = !selected.attempts.length && !selected.files.length && !selected.heads.length;
    return {database_rows: empty ? passed('media_rows_cleared') : blocked('media_rows_remain'),
      derived_eligibility: empty ? passed('media_old_execution_revoked') : blocked('media_execution_closure_remains'),
      trace_payloads: empty ? passed('media_private_proofs_cleared') : blocked('media_private_proofs_remain'),
      request_replay: empty ? passed('media_request_tombstones_recorded') : blocked('media_request_closure_remains'),
      scope_suppression: {result: 'not_applicable', proof: 'media_clear_preserves_message_placeholder'}};
  },
};

/** 公共宿主及发布事务共用同一完整注册；本域排在会删除来源/授权父行的领域之前。 */
export function composeMediaDeletionRegistration(base: DeletionRegistration): DeletionRegistration {
  const contentDomains=new Set(['memory_documents','memory_management','reply_candidates','discussion_calls','memory_extraction','discussion']);
  const domains=base.domains.filter(d => d.id !== 'media').map(domain => ({...domain,
    fence(tx: StorageTransaction, op: DeletionOperation) { return isMedia(op.scope)&&!contentDomains.has(domain.id) ? [] : domain.fence(tx, op); },
    collect(tx: StorageTransaction, op: DeletionOperation) { return isMedia(op.scope)&&!contentDomains.has(domain.id) ? [] : domain.collect(tx, op); },
    verify(tx: StorageTransaction, op: DeletionOperation) {
      if (!isMedia(op.scope)||contentDomains.has(domain.id)) return domain.verify(tx, op);
      const irrelevant = {result: 'not_applicable' as const, proof: 'single_media_scope_has_no_other_domain_changes'};
      return {database_rows: irrelevant, derived_eligibility: irrelevant, trace_payloads: irrelevant, request_replay: irrelevant, scope_suppression: irrelevant};
    },
  }));
  return {authority: {
    fence(tx, owner, scope) { return isMedia(scope) ? mediaDeletionAuthority.fence(tx, owner, scope) : base.authority.fence(tx, owner, scope); },
    verify(tx, op) { return isMedia(op.scope) ? mediaDeletionAuthority.verify(tx, op) : base.authority.verify(tx, op); },
  }, domains: [...domains.filter(domain=>contentDomains.has(domain.id)),mediaDeletionDomain,...domains.filter(domain=>!contentDomains.has(domain.id))],
   requiredDomains: ['media', ...base.requiredDomains.filter(d => d !== 'media')]};
}
