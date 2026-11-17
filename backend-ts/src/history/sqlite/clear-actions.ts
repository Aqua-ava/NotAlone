import { StorageFailure, type StorageAction, type StorageRow, type StorageTransaction } from '../../storage/sqlite/contracts.ts';
import { boundaryProtocol, membersManifestSha256, maxBoundaryMembers, type PreparedBoundary, type PreparedBoundaryMember } from './boundary.ts';

/**
 * 06 清空聊天与显式重读的具名存储动作。
 * 边界候选持久化（pending）与原子接受（verified）分开：候选成员在验证前不是正式排除。
 * 所有外部渠道读取都在事务外，本文件只处理受控短事务与代次复验。
 */
const action = (name: string, mode: 'read' | 'write', execute: (tx: StorageTransaction, input: any) => unknown): StorageAction =>
  ({ name: `history.${name}`, mode, retryBusy: true, execute });
const fail = (code: string): never => { throw new StorageFailure(code); };
const id = (value: unknown): string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f]/.test(value) ? value : fail('history_clear_request_invalid');
const sha = (value: unknown): string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : fail('history_clear_request_invalid');
const generation = (value: unknown): bigint => typeof value === 'string' && /^(0|[1-9][0-9]{0,17})$/.test(value) ? BigInt(value) : fail('history_clear_request_invalid');
const boundedText = (value: unknown, max = 512): string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : fail('history_clear_request_invalid');
const integerCount = (value: unknown, max = maxBoundaryMembers): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fail('history_clear_request_invalid');
const row = (value: StorageRow | undefined, code: string): StorageRow => value ?? fail(code);
/** 旧结构升级夹具可能只安装到本票之前的迁移；缺表时按“尚未具备该能力”拒绝，不把升级测试变成SQL错误。 */
function hasTable(tx: StorageTransaction, name: string): boolean {
  return Boolean(tx.get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?", [name]));
}

function clearOperation(tx: StorageTransaction, ownerId: string, operationId: string, contactId: string): StorageRow {
  return row(tx.get("SELECT * FROM deletion_operation WHERE owner_identity=? AND operation_id=? AND scope_kind='contact_history' AND contact_identity=?", [ownerId, operationId, contactId]), 'history_clear_operation_invalid');
}
function currentContact(tx: StorageTransaction, ownerId: string, contactId: string): StorageRow {
  return row(tx.get("SELECT * FROM contact WHERE owner_id=? AND id=? AND state='active'", [ownerId, contactId]), 'history_contact_not_found');
}
function cutoffFor(tx: StorageTransaction, ownerId: string, operationId: string): StorageRow | undefined {
  return tx.get('SELECT * FROM history_cutoff WHERE owner_id=? AND operation_id=?', [ownerId, operationId]);
}
function conversationFor(tx: StorageTransaction, ownerId: string, contactId: string): StorageRow | undefined {
  return tx.get(`SELECT b.id AS binding_id,b.conversation_id,c.barrier_generation
   FROM conversation_binding b JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id
   JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id
   WHERE b.owner_id=? AND b.contact_id=? AND b.state='verified' AND a.identity_state='verified'
   ORDER BY b.id LIMIT 1`, [ownerId, contactId]);
}
/** 接受 B 前复验当前读取资格仍然存在；关闭开关或撤销后不得偷接受元数据。 */
function assertCurrentEligibility(tx: StorageTransaction, ownerId: string, contactId: string): void {
  const live = tx.get(`SELECT 1 FROM owner o JOIN contact p ON p.owner_id=o.owner_id
   JOIN conversation_binding b ON b.owner_id=p.owner_id AND b.contact_id=p.id
   JOIN channel_conversation c ON c.owner_id=b.owner_id AND c.id=b.conversation_id
   JOIN channel_account a ON a.owner_id=c.owner_id AND a.id=c.account_id
   JOIN read_grant g ON g.owner_id=b.owner_id AND g.binding_id=b.id AND g.contact_id=p.id
   JOIN binding_verification v ON v.owner_id=g.owner_id AND v.id=g.verification_id AND v.binding_id=b.id
   WHERE o.owner_id=? AND p.id=? AND o.state='active' AND o.read_enabled=1 AND p.state='active' AND b.state='verified'
   AND a.identity_state='verified' AND g.revoked_at IS NULL AND g.selection_generation=p.selection_generation
   AND v.identity_generation=b.identity_generation`, [ownerId, contactId]);
  if (!live) fail('read_not_authorized');
}
function latestVerifiedCutoff(tx: StorageTransaction, ownerId: string, conversationId: string): StorageRow | undefined {
  return tx.get("SELECT * FROM history_cutoff WHERE owner_id=? AND conversation_id=? AND state='verified' ORDER BY barrier_generation DESC LIMIT 1", [ownerId, conversationId]);
}
function cutoffView(value: StorageRow | undefined) {
  if (!value) return null;
  return { conversationId: String(value.conversation_id), barrierGeneration: String(value.barrier_generation),
    state: value.state as 'pending' | 'verified' | 'blocked', operationId: String(value.operation_id),
    manifestSha256: value.manifest_sha256 === null ? null : String(value.manifest_sha256),
    memberCount: value.member_count === null ? null : Number(value.member_count),
    boundaryToken: value.boundary_token === null ? null : String(value.boundary_token),
    reason: value.reason === null ? null : String(value.reason),
    establishedAt: value.established_at === null ? null : String(value.established_at) };
}
function boundaryInput(input: any): { ownerId: string; operationId: string; contactId: string; barrierGeneration: bigint; accountKey: string; conversationKey: string; prepared: PreparedBoundary } {
  const prepared = input?.prepared as PreparedBoundary | undefined;
  if (!prepared || !prepared.target || !Array.isArray(prepared.members) || !prepared.proof || !prepared.support) fail('history_boundary_candidate_incomplete');
  return { ownerId: id(input.ownerId), operationId: id(input.operationId), contactId: id(input.contactId),
    barrierGeneration: generation(input.barrierGeneration),
    accountKey: boundedText(input.accountKey), conversationKey: boundedText(input.conversationKey), prepared: prepared as PreparedBoundary };
}
function validatePrepared(prepared: PreparedBoundary): { members: PreparedBoundaryMember[]; manifest: string } {
  const target = prepared.target;
  if (target?.protocol !== 'private-history-v1' || !boundedText(target.descriptor, 64_000) || !boundedText(target.sourceGeneration)
    || !Array.isArray(target.partitions) || !target.partitions.length || target.partitions.length > 10_000
    || !Array.isArray(target.tables) || target.tables.length > 10_000
    || target.partitions.some(partition => !target.tables.some(table => table.partition === partition))
    || target.tables.some(table => !target.partitions.includes(table.partition))) fail('history_boundary_target_changed');
  if (!Array.isArray(prepared.members) || prepared.members.length > maxBoundaryMembers) fail('history_boundary_candidate_incomplete');
  if (!prepared.proof || !Array.isArray(prepared.proof.partitions)) fail('history_boundary_candidate_incomplete');
  const proofCounts = new Map<string, number>();
  for (const evidence of prepared.proof.partitions) {
    if (!evidence || typeof evidence.partition !== 'string' || proofCounts.has(evidence.partition)) fail('history_boundary_candidate_incomplete');
    proofCounts.set(evidence.partition, Number(evidence.memberCount));
  }
  if (prepared.support?.status !== 'supported' || prepared.support?.protocol !== 'private-history-v1'
    || prepared.support?.identity !== 'source-table-local-v1'
    || prepared.support?.capabilities?.[boundaryProtocol] !== 'supported') fail('history_boundary_support_unverified');
  const seen = new Set<string>();
  const members = prepared.members.map((member, memberNo) => {
    if (!member || !boundedText(member.partition) || !boundedText(member.tableInstance) || !boundedText(member.localKey, 2048)) fail('history_boundary_member_invalid');
    if (!target.partitions.includes(member.partition) || !target.tables.some(table => table.partition === member.partition && table.instance === member.tableInstance)) fail('history_boundary_member_invalid');
    if (seen.has(member.localKey)) fail('history_boundary_member_duplicate');
    seen.add(member.localKey);
    return { memberNo, partition: member.partition, tableInstance: member.tableInstance, localKey: member.localKey };
  });
  members.sort((left, right) => left.localKey.localeCompare(right.localKey)).forEach((member, memberNo) => { member.memberNo = memberNo; });
  // 每分片成员数必须等于该分片实际成员，不能只在总和上凑数。
  const actualCounts = new Map<string, number>();
  for (const member of members) actualCounts.set(member.partition, (actualCounts.get(member.partition) ?? 0) + 1);
  for (const partition of target.partitions) {
    if ((proofCounts.get(partition) ?? -1) !== (actualCounts.get(partition) ?? 0)) fail('history_boundary_candidate_incomplete');
  }
  const manifest = membersManifestSha256(target.descriptor, members);
  if (manifest !== prepared.manifestSha256) fail('history_boundary_manifest_mismatch');
  if (!boundedText(prepared.boundaryToken, 64_000)) fail('history_boundary_proof_invalid');
  return { members, manifest };
}

export const historyClearActions: StorageAction[] = [
  /** 清空操作登记后推进会话单调 barrier generation 并建立待接受候选；不读取渠道。 */
  action('clearBegin', 'write', (tx, raw) => {
    const input = raw as { ownerId: string; contactId: string; operationId: string; at: number };
    const ownerId = id(input.ownerId), contactId = id(input.contactId), operationId = id(input.operationId);
    if (!Number.isSafeInteger(input.at) || input.at < 0) fail('history_clear_request_invalid');
    const operation = clearOperation(tx, ownerId, operationId, contactId);
    const existing = cutoffFor(tx, ownerId, operationId);
    if (existing) {
      // 重试沿用同一 barrier generation；被中断的候选复位为 pending，不把 B 后移。
      if (existing.state === 'blocked') tx.run("UPDATE history_cutoff SET state='pending',reason=NULL WHERE owner_id=? AND operation_id=?", [ownerId, operationId]);
      return { state: existing.state === 'verified' ? 'verified' : 'pending', conversationId: String(existing.conversation_id),
        barrierGeneration: String(existing.barrier_generation), reason: null };
    }
    if (operation.state === 'completed') fail('history_clear_completed');
    const conversation = conversationFor(tx, ownerId, contactId);
    if (!conversation) return { state: 'unavailable', conversationId: null, barrierGeneration: '0', reason: 'history_no_active_binding' };
    currentContact(tx, ownerId, contactId);
    const barrier = (conversation.barrier_generation as bigint) + 1n;
    tx.run('UPDATE channel_conversation SET barrier_generation=? WHERE owner_id=? AND id=?', [barrier, ownerId, conversation.conversation_id]);
    tx.run("INSERT INTO history_cutoff(owner_id,conversation_id,barrier_generation,operation_id,contact_id,state,created_at) VALUES(?,?,?,?,?,'pending',?)",
      [ownerId, conversation.conversation_id, barrier, operationId, contactId, input.at]);
    return { state: 'pending', conversationId: String(conversation.conversation_id), barrierGeneration: String(barrier), reason: null };
  }),
  /** 完整 manifest 与精确成员在同一事务持久化；pending 候选不生效。 */
  action('boundaryPersist', 'write', (tx, raw) => {
    const input = boundaryInput(raw);
    const operation = clearOperation(tx, input.ownerId, input.operationId, input.contactId);
    if (operation.state === 'completed') fail('history_clear_completed');
    const contact = currentContact(tx, input.ownerId, input.contactId);
    if (contact.data_generation !== operation.accepted_generation) fail('history_clear_generation_stale');
    const cutoff = row(cutoffFor(tx, input.ownerId, input.operationId), 'history_boundary_generation_stale');
    if (cutoff.state === 'verified') return { state: 'verified', barrierGeneration: String(cutoff.barrier_generation),
      manifestSha256: String(cutoff.manifest_sha256), memberCount: Number(cutoff.member_count) };
    if (cutoff.barrier_generation !== input.barrierGeneration) fail('history_boundary_generation_stale');
    const conversation = row(tx.get('SELECT barrier_generation FROM channel_conversation WHERE owner_id=? AND id=?', [input.ownerId, cutoff.conversation_id]), 'history_conversation_not_found');
    if (conversation.barrier_generation !== cutoff.barrier_generation) fail('history_boundary_generation_stale');
    const { members, manifest } = validatePrepared(input.prepared);
    tx.run('DELETE FROM history_cutoff_member WHERE owner_id=? AND conversation_id=? AND barrier_generation=?', [input.ownerId, cutoff.conversation_id, cutoff.barrier_generation]);
    for (const member of members) tx.run(`INSERT INTO history_cutoff_member(owner_id,conversation_id,barrier_generation,member_no,partition,table_instance,scheme,external_key)
      VALUES(?,?,?,?,?,?,'local',?)`, [input.ownerId, cutoff.conversation_id, cutoff.barrier_generation, member.memberNo, member.partition, member.tableInstance, member.localKey]);
    tx.run(`UPDATE history_cutoff SET source_generation=?,account_key=?,conversation_key=?,protocol=?,target_json=?,support_json=?,proof_json=?,
      manifest_sha256=?,boundary_token=?,member_count=? WHERE owner_id=? AND operation_id=?`,
      [input.prepared.target.sourceGeneration, input.accountKey, input.conversationKey, input.prepared.target.protocol,
        JSON.stringify(input.prepared.target), JSON.stringify(input.prepared.support), JSON.stringify(input.prepared.proof),
        manifest, input.prepared.boundaryToken, members.length, input.ownerId, input.operationId]);
    return { state: 'pending', barrierGeneration: String(cutoff.barrier_generation), manifestSha256: manifest, memberCount: members.length };
  }),
  /** 原子接受 B：复验开关、授权、联系人和代次后，把完整候选切为 verified。 */
  action('boundaryAccept', 'write', (tx, raw) => {
    const input = raw as { ownerId: string; operationId: string; contactId: string; barrierGeneration: string; at: number };
    const ownerId = id(input.ownerId), operationId = id(input.operationId), contactId = id(input.contactId);
    const barrier = generation(input.barrierGeneration);
    if (!Number.isSafeInteger(input.at) || input.at < 0) fail('history_clear_request_invalid');
    const operation = clearOperation(tx, ownerId, operationId, contactId);
    if (operation.state === 'completed') fail('history_clear_completed');
    const cutoff = row(cutoffFor(tx, ownerId, operationId), 'history_boundary_generation_stale');
    if (cutoff.state === 'verified') return { ...cutoffView(cutoff)!, state: 'verified' as const };
    if (cutoff.barrier_generation !== barrier) fail('history_boundary_generation_stale');
    const contact = currentContact(tx, ownerId, contactId);
    if (contact.data_generation !== operation.accepted_generation) fail('history_clear_generation_stale');
    const conversation = row(tx.get('SELECT barrier_generation FROM channel_conversation WHERE owner_id=? AND id=?', [ownerId, cutoff.conversation_id]), 'history_conversation_not_found');
    if (conversation.barrier_generation !== cutoff.barrier_generation) fail('history_boundary_generation_stale');
    assertCurrentEligibility(tx, ownerId, contactId);
    const persisted = tx.all('SELECT member_no,partition,table_instance,external_key FROM history_cutoff_member WHERE owner_id=? AND conversation_id=? AND barrier_generation=? ORDER BY member_no',
      [ownerId, cutoff.conversation_id, cutoff.barrier_generation]);
    if (!cutoff.manifest_sha256 || !cutoff.boundary_token || !cutoff.target_json) fail('history_boundary_candidate_incomplete');
    if (persisted.length !== Number(cutoff.member_count)) fail('history_boundary_candidate_incomplete');
    const target = JSON.parse(String(cutoff.target_json)) as PreparedBoundary['target'];
    const manifest = membersManifestSha256(target.descriptor, persisted.map(value => ({ partition: String(value.partition), tableInstance: String(value.table_instance), localKey: String(value.external_key) })));
    if (manifest !== cutoff.manifest_sha256) fail('history_boundary_manifest_mismatch');
    tx.run("UPDATE history_cutoff SET state='verified',established_at=? WHERE owner_id=? AND operation_id=? AND state='pending'", [input.at, ownerId, operationId]);
    return { state: 'verified', conversationId: String(cutoff.conversation_id), barrierGeneration: String(cutoff.barrier_generation),
      operationId, manifestSha256: String(cutoff.manifest_sha256), memberCount: persisted.length,
      boundaryToken: String(cutoff.boundary_token), establishedAt: String(input.at) };
  }),
  /** 失败只清本次未生效候选；已接受 B 不可撤销/后移。 */
  action('boundaryInvalidate', 'write', (tx, raw) => {
    const input = raw as { ownerId: string; operationId: string; reason: string };
    const ownerId = id(input.ownerId), operationId = id(input.operationId), reason = id(input.reason);
    const cutoff = cutoffFor(tx, ownerId, operationId);
    if (!cutoff) return { invalidated: false, reason: 'history_boundary_absent' };
    if (cutoff.state === 'verified') return { invalidated: false, reason: 'history_boundary_already_accepted' };
    tx.run('DELETE FROM history_cutoff_member WHERE owner_id=? AND conversation_id=? AND barrier_generation=?', [ownerId, cutoff.conversation_id, cutoff.barrier_generation]);
    tx.run(`UPDATE history_cutoff SET state='blocked',reason=?,source_generation=NULL,account_key=NULL,conversation_key=NULL,protocol=NULL,
      target_json=NULL,support_json=NULL,proof_json=NULL,manifest_sha256=NULL,boundary_token=NULL,member_count=NULL
      WHERE owner_id=? AND operation_id=? AND state IN ('pending','blocked')`, [reason, ownerId, operationId]);
    return { invalidated: true, reason: null };
  }),
  /** 恢复未完成清空时读取原删除请求键；plan 幂等并重新施加写者 fence。 */
  action('clearRequest', 'read', (tx, raw) => {
    const ownerId = id((raw as { ownerId: string; operationId: string }).ownerId);
    const operationId = id((raw as { ownerId: string; operationId: string }).operationId);
    const operation = tx.get("SELECT request_key FROM deletion_operation WHERE owner_identity=? AND operation_id=? AND scope_kind='contact_history'", [ownerId, operationId]);
    return operation ? { requestKey: String(operation.request_key) } : null;
  }),
  /** 公开状态：缺边界时必须可区分 boundary_pending，不能当作清空成功。 */
  action('clearStatus', 'read', (tx, raw) => {
    const ownerId = id((raw as { ownerId: string }).ownerId), contactId = id((raw as { contactId: string }).contactId);
    const contact = tx.get("SELECT id FROM contact WHERE owner_id=? AND id=?", [ownerId, contactId]);
    if (!contact) return { contactId, operationId: null, operationState: null, phase: 'none', completed: false, boundary: null, failureCode: null, storedMessages: 0, storedSources: 0, openGoals: 0 };
    const operation = tx.get("SELECT * FROM deletion_operation WHERE owner_identity=? AND contact_identity=? AND scope_kind='contact_history' ORDER BY created_at DESC,rowid DESC LIMIT 1", [ownerId, contactId]);
    const cutoff = operation ? cutoffFor(tx, ownerId, String(operation.operation_id)) : undefined;
    const boundary = cutoffView(cutoff);
    const messageCount = Number((tx.get(`SELECT count(*) AS n FROM message WHERE owner_id=? AND contact_id=? AND availability='available'
      AND EXISTS (SELECT 1 FROM capture_record r WHERE r.owner_id=message.owner_id AND r.contact_id=message.contact_id AND r.message_id=message.id AND r.state='normalized' AND r.availability='available')`, [ownerId, contactId])!.n as bigint));
    const sourceCount = Number((tx.get('SELECT count(*) AS n FROM capture_record WHERE owner_id=? AND contact_id=?', [ownerId, contactId])!.n as bigint));
    const goalCount = Number((tx.get('SELECT count(*) AS n FROM read_goal WHERE owner_id=? AND contact_id=?', [ownerId, contactId])!.n as bigint));
    const failure = operation ? tx.get("SELECT minimal_proof FROM deletion_check WHERE operation_id=? AND plan_revision=? AND result='blocked' ORDER BY check_kind LIMIT 1", [operation.operation_id, operation.plan_revision]) : undefined;
    const state = operation ? String(operation.state) : null;
    const phase = !operation ? 'none'
      : state === 'completed' && boundary?.state === 'verified' ? 'completed'
        : state === 'blocked' ? (boundary?.state === 'verified' ? 'cleanup_blocked' : 'boundary_pending')
          : boundary?.state === 'verified' ? 'cleaning' : 'boundary_pending';
    return { contactId, operationId: operation ? String(operation.operation_id) : null, operationState: state, phase,
      completed: phase === 'completed', boundary,
      failureCode: failure ? String(failure.minimal_proof) : null,
      storedMessages: messageCount, storedSources: sourceCount, openGoals: goalCount };
  }),
  /** 查询某次清空操作的已接受切面（B 不可后移；候选不冒充已接受）。 */
  action('cutoffStatus', 'read', (tx, raw) => {
    const ownerId = id((raw as { ownerId: string; operationId: string }).ownerId);
    const operationId = id((raw as { ownerId: string; operationId: string }).operationId);
    return cutoffView(tx.get('SELECT * FROM history_cutoff WHERE owner_id=? AND operation_id=?', [ownerId, operationId]));
  }),
  /** 显式重读：重新核验账号/身份后撤销旧许可并建立新许可与独立操作。 */
  action('restoreBegin', 'write', (tx, raw) => {
    const input = raw as { ownerId: string; contactId: string; requestKey: string; authorizationId: string;
      verificationId: string; grantId: string; at: number; proof: { supportProfile: string; sourceGeneration: string; accountKey: string; conversationKey: string } };
    const ownerId = id(input.ownerId), contactId = id(input.contactId), requestKey = id(input.requestKey);
    if (!Number.isSafeInteger(input.at) || input.at < 0) fail('history_clear_request_invalid');
    const existing = tx.get('SELECT * FROM history_restore WHERE owner_id=? AND request_key=?', [ownerId, requestKey]);
    if (existing) {
      if (existing.contact_id !== contactId) fail('history_restore_request_conflict');
      return { existing: true, ...restoreView(existing) };
    }
    const contact = currentContact(tx, ownerId, contactId);
    const binding = row(tx.get(`SELECT b.* FROM conversation_binding b JOIN channel_account a ON a.owner_id=b.owner_id AND a.id=(SELECT account_id FROM channel_conversation WHERE owner_id=b.owner_id AND id=b.conversation_id)
      WHERE b.owner_id=? AND b.contact_id=? AND b.state='verified' AND a.identity_state='verified' ORDER BY b.id LIMIT 1`, [ownerId, contactId]), 'history_restore_binding_unavailable');
    const grant = row(tx.get('SELECT * FROM read_grant WHERE owner_id=? AND contact_id=? AND binding_id=? AND revoked_at IS NULL', [ownerId, contactId, binding.id]), 'read_not_authorized');
    const conversation = row(tx.get('SELECT * FROM channel_conversation WHERE owner_id=? AND id=?', [ownerId, binding.conversation_id]), 'history_conversation_not_found');
    const account = row(tx.get('SELECT * FROM channel_account WHERE owner_id=? AND id=? AND identity_state=\'verified\'', [ownerId, conversation.account_id]), 'history_restore_identity_unverified');
    const proof = input.proof;
    if (!proof || !boundedText(proof.sourceGeneration) || proof.sourceGeneration !== account.source_generation
      || !boundedText(proof.supportProfile) || !boundedText(proof.accountKey) || !boundedText(proof.conversationKey)
      || proof.accountKey !== account.external_key || proof.conversationKey !== conversation.external_key) fail('history_restore_identity_unverified');
    const authorizationId = boundedText(input.authorizationId), verificationId = boundedText(input.verificationId), grantId = boundedText(input.grantId);
    const selectionGeneration = (contact.selection_generation as bigint) + 1n;
    tx.run("UPDATE read_grant SET revoked_at=?,reason='explicit_restore' WHERE owner_id=? AND id=? AND revoked_at IS NULL", [input.at, ownerId, grant.id]);
    tx.run('UPDATE contact SET selection_generation=? WHERE owner_id=? AND id=?', [selectionGeneration, ownerId, contactId]);
    tx.run(`INSERT INTO binding_verification(owner_id,id,binding_id,identity_generation,method,proof_format,proof,verified_at)
      VALUES(?,?,?,?,'channel_metadata','identity-metadata-v1',?,?)`,
      [ownerId, verificationId, binding.id, binding.identity_generation, JSON.stringify({ support_profile: proof.supportProfile,
        source_generation: proof.sourceGeneration, account_id: proof.accountKey, conversation_key: proof.conversationKey }), input.at]);
    tx.run(`INSERT INTO read_grant(owner_id,id,contact_id,binding_id,verification_id,selection_generation,granted_at)
      VALUES(?,?,?,?,?,?,?)`, [ownerId, grantId, contactId, binding.id, verificationId, selectionGeneration, input.at]);
    const cutoff = latestVerifiedCutoff(tx, ownerId, String(conversation.id));
    tx.run(`INSERT INTO history_restore(owner_id,request_key,contact_id,authorization_id,conversation_id,binding_id,verification_id,grant_id,
      selection_generation,barrier_generation,cutoff_operation_id,goal_id,state,created_at,completed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL,'authorized',?,NULL)`,
      [ownerId, requestKey, contactId, authorizationId, conversation.id, binding.id, verificationId, grantId,
        selectionGeneration, conversation.barrier_generation, cutoff ? cutoff.operation_id : null, input.at]);
    return { existing: false, ...restoreView(historyRestoreRow(tx, ownerId, requestKey)!) };
  }),
  /** 把显式重读目标绑定到本次独立授权；只有该授权可绕过本次清空产生的排除。 */
  action('restoreAttach', 'write', (tx, raw) => {
    const input = raw as { ownerId: string; contactId: string; requestKey: string; goalId: string };
    const ownerId = id(input.ownerId), contactId = id(input.contactId), requestKey = id(input.requestKey), goalId = id(input.goalId);
    const restore = row(tx.get('SELECT * FROM history_restore WHERE owner_id=? AND request_key=?', [ownerId, requestKey]), 'history_restore_not_found');
    if (restore.contact_id !== contactId) fail('history_restore_request_conflict');
    if (restore.goal_id !== null && restore.goal_id !== goalId) fail('history_restore_goal_conflict');
    if (restore.state === 'completed') return { attached: false, reason: 'history_restore_completed', ...restoreView(restore) };
    const goal = row(tx.get('SELECT * FROM read_goal WHERE owner_id=? AND id=? AND contact_id=?', [ownerId, goalId, contactId]), 'history_goal_not_found');
    if (goal.grant_id !== restore.grant_id || !['running', 'incomplete', 'complete'].includes(String(goal.state))) fail('history_restore_goal_conflict');
    tx.run("UPDATE history_restore SET goal_id=?,state='active' WHERE owner_id=? AND request_key=? AND state IN ('authorized','active')", [goalId, ownerId, requestKey]);
    return { attached: true, reason: null, ...restoreView(historyRestoreRow(tx, ownerId, requestKey)!) };
  }),
  /** 重读目标完成后结束该独立授权；已完成的授权保持幂等。 */
  action('restoreComplete', 'write', (tx, raw) => {
    const input = raw as { ownerId: string; contactId: string; requestKey: string; at: number };
    const ownerId = id(input.ownerId), contactId = id(input.contactId), requestKey = id(input.requestKey);
    if (!Number.isSafeInteger(input.at) || input.at < 0) fail('history_clear_request_invalid');
    const restore = row(tx.get('SELECT * FROM history_restore WHERE owner_id=? AND request_key=?', [ownerId, requestKey]), 'history_restore_not_found');
    if (restore.contact_id !== contactId) fail('history_restore_request_conflict');
    if (restore.state === 'completed') return restoreView(restore);
    if (restore.goal_id === null) fail('history_restore_goal_not_attached');
    const goal = row(tx.get('SELECT state FROM read_goal WHERE owner_id=? AND id=? AND contact_id=?', [ownerId, restore.goal_id, contactId]), 'history_goal_not_found');
    if (goal.state !== 'complete') fail('history_restore_incomplete');
    tx.run("UPDATE history_restore SET state='completed',completed_at=? WHERE owner_id=? AND request_key=?", [input.at, ownerId, requestKey]);
    return restoreView(historyRestoreRow(tx, ownerId, requestKey)!);
  }),
  action('restoreStatus', 'read', (tx, raw) => {
    const ownerId = id((raw as { ownerId: string; contactId?: string }).ownerId);
    const contactId = (raw as { contactId?: string }).contactId;
    const restore = contactId
      ? tx.get('SELECT * FROM history_restore WHERE owner_id=? AND contact_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', [ownerId, id(contactId)])
      : tx.get('SELECT * FROM history_restore WHERE owner_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1', [ownerId]);
    if (!restore) return null;
    const goal = restore.goal_id === null ? null : tx.get('SELECT * FROM read_goal WHERE owner_id=? AND id=?', [ownerId, restore.goal_id]);
    return { ...restoreView(restore), goal: goal ? {
      id: String(goal.id), state: String(goal.state), coverageState: String(goal.coverage_state),
      cursor: goal.cursor === null ? null : String(goal.cursor), failureCode: goal.failure_code === null ? null : String(goal.failure_code),
      target: JSON.parse(String(goal.target_json)), report: JSON.parse(String(goal.support_json)) } : null };
  }),
];

function historyRestoreRow(tx: StorageTransaction, ownerId: string, requestKey: string): StorageRow | undefined {
  return tx.get('SELECT * FROM history_restore WHERE owner_id=? AND request_key=?', [ownerId, requestKey]);
}
function restoreView(value: StorageRow) {
  return { requestKey: String(value.request_key), authorizationId: String(value.authorization_id), contactId: String(value.contact_id),
    grantId: String(value.grant_id), verificationId: String(value.verification_id), selectionGeneration: String(value.selection_generation),
    barrierGeneration: String(value.barrier_generation), cutoffOperationId: value.cutoff_operation_id === null ? null : String(value.cutoff_operation_id),
    goalId: value.goal_id === null ? null : String(value.goal_id), state: String(value.state),
    createdAt: String(value.created_at), completedAt: value.completed_at === null ? null : String(value.completed_at) };
}

/** 接受页时判定一条来源身份是否属于任一已接受 B；显式重读授权可跨该联系人的清空边界恢复。 */
export function clearBoundaryExclusion(tx: StorageTransaction, input: { ownerId: string; conversationId: string; externalKey: string; restoreOperationId: string | null }): boolean {
  if (!hasTable(tx, 'history_cutoff_member') || !hasTable(tx, 'history_cutoff')) return false;
  const excluded = tx.get(`SELECT 1 FROM history_cutoff_member m
   JOIN history_cutoff c ON c.owner_id=m.owner_id AND c.conversation_id=m.conversation_id AND c.barrier_generation=m.barrier_generation
   WHERE m.owner_id=? AND m.conversation_id=? AND m.scheme='local' AND m.external_key=? AND c.state='verified' LIMIT 1`,
   [input.ownerId, input.conversationId, input.externalKey]);
  if (!excluded) return false;
  // 旧排除记录不删除；显式重读只在本次独立授权生效期间按读取代次放行，普通增量仍拒绝。
  return input.restoreOperationId === null;
}
/** undefined 表示不是显式重读目标；null 表示重读授权没有对应清空边界。 */
export function restoreOperationForGoal(tx: StorageTransaction, ownerId: string, goalId: string): string | null | undefined {
  if (!hasTable(tx, 'history_restore')) return undefined;
  const restore = tx.get("SELECT cutoff_operation_id FROM history_restore WHERE owner_id=? AND goal_id=? AND state IN ('active','completed')", [ownerId, goalId]);
  return restore === undefined ? undefined : restore.cutoff_operation_id === null ? null : String(restore.cutoff_operation_id);
}
export function completeRestoreGoal(tx: StorageTransaction, ownerId: string, goalId: string, at: number): void {
  if (!hasTable(tx, 'history_restore')) return;
  tx.run("UPDATE history_restore SET state='completed',completed_at=? WHERE owner_id=? AND goal_id=? AND state='active'", [at, ownerId, goalId]);
}
/** 05 删除复核用：该清空操作是否已有被原子接受的完整 B。 */
export function verifiedCutoffForOperation(tx: StorageTransaction, ownerId: string, operationId: string, contactId: string): StorageRow | undefined {
  if (!hasTable(tx, 'history_cutoff')) return undefined;
  return tx.get("SELECT * FROM history_cutoff WHERE owner_id=? AND operation_id=? AND contact_id=? AND state='verified'", [ownerId, operationId, contactId]);
}

