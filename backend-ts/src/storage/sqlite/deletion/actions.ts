import { createHash, randomUUID } from 'node:crypto';
import { StorageFailure, type StorageAction, type StorageLease, type StorageRow, type StorageTransaction } from '../contracts.ts';
import { checkKinds, type CheckKind, type CheckResult, type DeletionOperation, type DeletionRegistration, type DeletionScope, type DeletionSnapshot, type DeletionTarget } from './contracts.ts';

const fail = (code: string): never => { throw new StorageFailure(code); };
function synchronous<T>(value: T): T {
  if (value && typeof (value as {then?: unknown}).then === 'function') {
    void Promise.resolve(value).catch(() => {});
    fail('async_transaction_forbidden');
  }
  return value;
}
const id = (value: unknown): string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x1f]/.test(value) ? value : fail('deletion_input_invalid');
const proof = (value: CheckResult): CheckResult => {
  if (!value || !['passed', 'blocked', 'not_applicable'].includes(value.result) || !/^[a-z][a-z0-9_]{0,79}$/.test(value.proof)) fail('deletion_proof_invalid');
  return value;
};
const canonical = (v: unknown): string => JSON.stringify(v, (_k, value) => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, value[k]])) : value);
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex');
function scope(value: DeletionScope): DeletionScope {
  if (!value || !['source', 'contact', 'contact_history', 'account', 'discussion', 'media_result_clear', 'media_result_replace'].includes(value.kind)) return fail('deletion_input_invalid');
  const fields = value.kind === 'account' ? [] : value.kind === 'source' ? ['contactId', 'sourceId'] : value.kind === 'discussion' ? ['contactId', 'discussionId'] : value.kind.startsWith('media_') ? ['contactId', 'messageId'] : ['contactId'];
  if (canonical(Object.keys(value).sort()) !== canonical(['kind', ...fields].sort())) return fail('deletion_input_invalid');
  for (const field of fields) id((value as unknown as Record<string, string>)[field]);
  return value;
}
function operation(row: StorageRow): DeletionOperation {
  const kind = row.scope_kind as DeletionScope['kind'];
  return { operationId: row.operation_id as string, ownerId: row.owner_identity as string,
    scope: { kind, ...(row.contact_identity ? { contactId: row.contact_identity } : {}), ...(row.source_identity ? { sourceId: row.source_identity } : {}), ...(row.discussion_identity ? { discussionId: row.discussion_identity } : {}), ...(row.message_identity ? { messageId: row.message_identity } : {}) } as DeletionScope,
    acceptedGeneration: row.accepted_generation as bigint, planRevision: row.plan_revision as bigint, state: row.state as DeletionOperation['state'],
    createdAt: new Date(Number(row.created_at)).toISOString(), completedAt: row.completed_at === null ? null : new Date(Number(row.completed_at)).toISOString() };
}
function find(tx: StorageTransaction, input: { ownerId: string; operationId: string }): StorageRow {
  return tx.get('SELECT * FROM deletion_operation WHERE owner_identity=? AND operation_id=?', [id(input.ownerId), id(input.operationId)]) ?? fail('deletion_not_found');
}
function snapshot(tx: StorageTransaction, row: StorageRow): DeletionSnapshot {
  return { ...operation(row), targets: tx.all('SELECT * FROM deletion_target WHERE operation_id=? ORDER BY target_no', [row.operation_id]).map(t => ({ targetNo: t.target_no as bigint, target: t.target_payload ? JSON.parse(t.target_payload as string) : null, state: t.state as 'pending' | 'cleared' | 'failed', attempts: t.attempts as bigint })),
    checks: tx.all('SELECT * FROM deletion_check WHERE operation_id=? AND plan_revision=? ORDER BY check_kind,check_no', [row.operation_id, row.plan_revision]).map(c => ({ kind: c.check_kind as CheckKind, domain: c.check_no as string, result: { result: c.result as CheckResult['result'], proof: c.minimal_proof as string } })) };
}
const namespace = (lease: StorageLease, name: string) => {
  if (!/^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/.test(name)) fail('deletion_namespace_invalid');
  return `${lease.databaseId}:${name}`;
};
export function requestAllowed(tx: StorageTransaction, lease: StorageLease, ownerId: string, requestNamespace: string, key: string): boolean {
  return !tx.get('SELECT 1 FROM request_tombstone WHERE owner_identity=? AND request_namespace=? AND request_key=?', [id(ownerId), namespace(lease, requestNamespace), id(key)]);
}
export function tombstoneRequest(tx: StorageTransaction, lease: StorageLease, input: { ownerId: string; namespace: string; key: string; generation: bigint; operationId?: string }): void {
  if (typeof input.generation !== 'bigint' || input.generation < 0n) fail('deletion_input_invalid');
  tx.run(`INSERT INTO request_tombstone VALUES(?,?,?,'revoked',?,?,?) ON CONFLICT(owner_identity,request_namespace,request_key) DO NOTHING`, [id(input.ownerId), namespace(lease, input.namespace), id(input.key), input.generation, input.operationId ?? null, Date.now()]);
}
function registration(config?: DeletionRegistration): DeletionRegistration {
  if (!config || !config.requiredDomains.length || config.requiredDomains.some(d => !config.domains.some(h => h.id === d)) || new Set(config.domains.map(d => d.id)).size !== config.domains.length) return fail('deletion_domain_unavailable');
  return config;
}
function validateTarget(config: DeletionRegistration, target: DeletionTarget, ownerId: string): void {
  const domain = config.domains.find(d => d.id === target.domain) ?? fail('deletion_domain_unavailable');
  if (!Array.isArray(target.holderKeys) || target.holderKeys.some(k => typeof k !== 'string' || !/^[a-z][a-zA-Z0-9]*:[a-zA-Z0-9_-]{1,128}$/.test(k))) fail('deletion_target_invalid');
  if (target.kind === 'row') {
    const shape = domain.rowKinds[target.rowKind];
    if (!shape || target.key[shape.ownerKey] !== ownerId || canonical([...shape.keys].sort()) !== canonical(Object.keys(target.key).sort())) fail('deletion_target_invalid');
    Object.values(target.key).forEach(id); id(target.identity);
  } else if (target.kind === 'file') {
    if (target.ownerId !== ownerId) fail('deletion_target_invalid');
    id(target.fileId);
    if (!/^\d+$/.test(target.generation) || !target.address || !['runtime', 'media', 'cache'].includes(target.address.area)
      || !['file', 'directory'].includes(target.address.kind) || !Array.isArray(target.address.ancestors)) fail('deletion_target_invalid');
    const parts = target.address.locator.split('/');
    if (!parts.length || parts.length > 32 || parts.some(p => !/^[a-zA-Z0-9_.-]{1,128}$/.test(p) || p === '.' || p === '..') || target.address.ancestors.length !== parts.length) fail('deletion_target_invalid');
    for (const item of [target.address.identity, ...target.address.ancestors]) if (!item || ['dev', 'ino', 'birthtimeNs', 'uid'].some(k => !/^\d+$/.test((item as unknown as Record<string, string>)[k]))) fail('deletion_target_invalid');
  } else fail('deletion_target_invalid');
}
function refresh(tx: StorageTransaction, row: StorageRow, config: DeletionRegistration, lease: StorageLease): boolean {
  const manifest = canonical(config.domains.map(d => d.id).sort());
  if (manifest !== row.domain_manifest) fail('deletion_registry_changed');
  const op = operation(row); let changed = false;
  for (const domain of config.domains) {
    for (const request of synchronous(domain.fence(tx, op))) tombstoneRequest(tx, lease, { ownerId: op.ownerId, ...request, generation: op.acceptedGeneration, operationId: op.operationId });
    for (const target of synchronous(domain.collect(tx, op))) {
      if (target.domain !== domain.id) fail('deletion_target_invalid');
      validateTarget(config, target, op.ownerId);
      const key = hash(target.kind === 'row' ? [target.rowKind, target.key, target.identity] : [target.fileId, target.generation]);
      const old = tx.get('SELECT * FROM deletion_target WHERE operation_id=? AND domain=? AND target_key=?', [op.operationId, domain.id, key]);
      if (old) {
        if (old.target_payload !== canonical(target)) fail('deletion_target_conflict');
        if (old.state === 'cleared') { tx.run("UPDATE deletion_target SET state='pending' WHERE operation_id=? AND target_no=?", [op.operationId, old.target_no]); changed = true; }
        continue;
      }
      const next = (tx.get('SELECT COALESCE(MAX(target_no),0)+1 n FROM deletion_target WHERE operation_id=?', [op.operationId])!.n as bigint);
      tx.run(`INSERT INTO deletion_target(operation_id,target_no,storage_kind,domain,target_key,row_kind,row_key_snapshot,managed_locator,expected_identity,target_payload,plan_revision,state) VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending')`, [op.operationId, next, target.kind, domain.id, key, target.kind === 'row' ? target.rowKind : null, target.kind === 'row' ? canonical(target.key) : null, target.kind === 'file' ? target.address.locator : null, canonical(target.kind === 'file' ? target.address.identity : target.identity), canonical(target), op.planRevision + 1n]);
      changed = true;
    }
  }
  if (changed) tx.run("UPDATE deletion_operation SET plan_revision=plan_revision+1,state='fenced' WHERE operation_id=?", [op.operationId]);
  return changed;
}
export function planDeletion(tx: StorageTransaction, lease: StorageLease, configInput: DeletionRegistration | undefined, input: { ownerId: string; requestKey: string; scope: DeletionScope }): DeletionSnapshot {
  const config = registration(configInput), owner = id(input.ownerId), key = id(input.requestKey), target = scope(input.scope);
  const ns = `${lease.databaseId}:delete.${target.kind}`;
  const existing = tx.get('SELECT * FROM deletion_operation WHERE owner_identity=? AND request_namespace=? AND request_key=?', [owner, ns, key]);
  if (existing) {
    if (canonical(operation(existing).scope) !== canonical(target)) fail('deletion_request_conflict');
    return snapshot(tx, existing);
  }
  const generation = synchronous(config.authority.fence(tx, owner, target));
  if (typeof generation !== 'bigint' || generation < 0n) fail('deletion_fence_invalid');
  const operationId = randomUUID();
  const fields = target as unknown as Record<string, string>;
  tx.run(`INSERT INTO deletion_operation VALUES(?,?,?,?,?,?,?,?,?,?,'fenced',1,?,NULL,NULL,?,NULL)`, [operationId, owner, ns, key, target.kind, fields.contactId ?? null, fields.sourceId ?? null, fields.discussionId ?? null, fields.messageId ?? null, generation, canonical(config.domains.map(d => d.id).sort()), Date.now()]);
  refresh(tx, find(tx, { ownerId: owner, operationId }), config, lease);
  return snapshot(tx, find(tx, { ownerId: owner, operationId }));
}
function claim(tx: StorageTransaction, input: any, lease: StorageLease): StorageRow {
  const row = find(tx, input);
  if (row.runner_token !== input.token || row.runner_runtime !== lease.runtimeId || row.plan_revision !== input.planRevision || row.state === 'completed') fail('deletion_stale_runner');
  return row;
}
function record(tx: StorageTransaction, op: DeletionOperation, kind: CheckKind, domain: string, result: CheckResult): void {
  proof(result);
  tx.run('INSERT OR REPLACE INTO deletion_check VALUES(?,?,?,?,?,?,?,?)', [op.operationId, op.planRevision, kind, domain, result.result, Date.now(), 'deletion-v1', result.proof]);
}
export function createDeletionActions(configInput?: DeletionRegistration): StorageAction[] {
  const action = (name: string, mode: 'read' | 'write', execute: (tx: StorageTransaction, input: any, lease: StorageLease) => unknown): StorageAction => ({ name: `deletion.${name}`, mode, retryBusy: mode === 'write', execute });
  return [
    action('plan', 'write', (tx, input, lease) => planDeletion(tx, lease, configInput, input)),
    action('status', 'read', (tx, input) => snapshot(tx, find(tx, input))),
    action('list', 'read', (tx, input) => {
      const rows = input.contactId
        ? tx.all("SELECT * FROM deletion_operation WHERE owner_identity=? AND contact_identity=? AND scope_kind='discussion' AND state!='completed' ORDER BY created_at DESC,operation_id DESC LIMIT 50", [id(input.ownerId), id(input.contactId)])
        : tx.all(`SELECT * FROM deletion_operation WHERE owner_identity=? AND (
            (scope_kind='contact' AND state!='completed') OR operation_id IN (
              SELECT operation_id FROM deletion_operation WHERE owner_identity=? ORDER BY created_at DESC,operation_id DESC LIMIT 50
            )
          ) ORDER BY created_at DESC,operation_id DESC`, [id(input.ownerId), id(input.ownerId)]);
      return rows.map(row => snapshot(tx, row));
    }),
    action('requestAllowed', 'read', (tx, input, lease) => requestAllowed(tx, lease, input.ownerId, input.namespace, input.key)),
    action('claim', 'write', (tx, input, lease) => {
      const config = registration(configInput), row = find(tx, input);
      if (row.state === 'completed') return { ...snapshot(tx, row), token: null };
      if (row.runner_token && row.runner_runtime === lease.runtimeId) fail('deletion_busy');
      refresh(tx, row, config, lease);
      const token = randomUUID();
      tx.run("UPDATE deletion_operation SET runner_token=?,runner_runtime=?,state='cleaning' WHERE operation_id=?", [token, lease.runtimeId, row.operation_id]);
      return { ...snapshot(tx, find(tx, input)), token };
    }),
    action('recollect', 'write', (tx, input, lease) => {
      const config = registration(configInput), row = claim(tx, input, lease);
      refresh(tx, row, config, lease);
      tx.run("UPDATE deletion_operation SET state='cleaning' WHERE operation_id=?", [row.operation_id]);
      return { ...snapshot(tx, find(tx, input)), token: input.token };
    }),
    action('clearTarget', 'write', (tx, input, lease) => {
      const config = registration(configInput), row = claim(tx, input, lease), op = operation(row);
      const targetRow = tx.get('SELECT * FROM deletion_target WHERE operation_id=? AND target_no=?', [op.operationId, input.targetNo]) ?? fail('deletion_target_invalid');
      if (targetRow.state === 'cleared') return;
      const target = JSON.parse(targetRow.target_payload as string) as DeletionTarget; validateTarget(config, target, op.ownerId);
      const domain = config.domains.find(d => d.id === target.domain)!;
      if (target.kind === 'row') synchronous(domain.clearRow(tx, op, target)); else synchronous(domain.fileCleared(tx, op, target));
      tx.run("UPDATE deletion_target SET state='cleared',attempts=attempts+1,last_error_code=NULL WHERE operation_id=? AND target_no=?", [op.operationId, input.targetNo]);
    }),
    action('authorizeFile', 'write', (tx, input, lease) => {
      const config = registration(configInput), row = claim(tx, input, lease), op = operation(row);
      const targetRow = tx.get("SELECT * FROM deletion_target WHERE operation_id=? AND target_no=? AND storage_kind='file' AND state!='cleared'", [op.operationId, input.targetNo]) ?? fail('deletion_target_invalid');
      const target = JSON.parse(targetRow.target_payload as string) as DeletionTarget;
      validateTarget(config, target, op.ownerId);
      if (target.kind === 'file') synchronous(config.domains.find(d => d.id === target.domain)!.authorizeFile(tx, op, target));
      else fail('deletion_target_invalid');
    }),
    action('sealTargets', 'write', (tx, input, lease) => {
      const row = claim(tx, input, lease), op = operation(row);
      if (tx.get("SELECT 1 FROM deletion_target WHERE operation_id=? AND state!='cleared'", [op.operationId])) fail('deletion_targets_remain');
      for (const kind of ['runtime_files', 'runtime_live_refs'] as const) {
        const checked = proof(input.checks?.[kind]);
        if (checked.result !== 'passed') fail('deletion_runtime_unverified');
        record(tx, op, kind, 'coordinator', checked);
      }
      // 敏感定位先从账本清除，再维护页/WAL；维护失败仍沿同操作重试。
      tx.run('UPDATE deletion_target SET row_key_snapshot=NULL,managed_locator=NULL,expected_identity=NULL,target_payload=NULL,last_error_code=NULL WHERE operation_id=?', [op.operationId]);
    }),
    action('blocked', 'write', (tx, input, lease) => {
      const row = claim(tx, input, lease), op = operation(row);
      if (input.targetNo != null) tx.run("UPDATE deletion_target SET state='failed',attempts=attempts+1,last_error_code=? WHERE operation_id=? AND target_no=? AND state!='cleared'", [id(input.code), op.operationId, input.targetNo]);
      record(tx, op, 'final_recheck', 'coordinator', { result: 'blocked', proof: /^[a-z][a-z0-9_]{0,79}$/.test(input.code) ? input.code : 'cleanup_failed' });
      tx.run("UPDATE deletion_operation SET state='blocked',runner_token=NULL,runner_runtime=NULL WHERE operation_id=?", [op.operationId]);
      return snapshot(tx, find(tx, input));
    }),
    action('verify', 'write', (tx, input, lease) => {
      const config = registration(configInput), row = claim(tx, input, lease);
      if (refresh(tx, row, config, lease)) {
        tx.run('UPDATE deletion_operation SET runner_token=NULL,runner_runtime=NULL WHERE operation_id=?', [row.operation_id]);
        return snapshot(tx, find(tx, input));
      }
      const op = operation(row);
      tx.run("UPDATE deletion_operation SET state='verifying' WHERE operation_id=?", [op.operationId]);
      record(tx, op, 'write_fence', 'authority', synchronous(config.authority.verify(tx, op)));
      for (const domain of config.domains) {
        const checks = synchronous(domain.verify(tx, op));
        for (const kind of ['database_rows', 'derived_eligibility', 'trace_payloads', 'request_replay', 'scope_suppression'] as const) record(tx, op, kind, domain.id, checks[kind]);
      }
      record(tx, op, 'sqlite_pages_wal', 'coordinator', input.checks?.sqlite_pages_wal ?? { result: 'blocked', proof: 'missing_verification' });
      const remaining = tx.get("SELECT count(*) n FROM deletion_target WHERE operation_id=? AND state!='cleared'", [op.operationId])!.n;
      record(tx, op, 'final_recheck', 'coordinator', { result: remaining === 0n ? 'passed' : 'blocked', proof: remaining === 0n ? 'closure_rechecked' : 'targets_remain' });
      const checks = tx.all('SELECT * FROM deletion_check WHERE operation_id=? AND plan_revision=?', [op.operationId, op.planRevision]);
      const complete = remaining === 0n && checkKinds.every(k => checks.some(c => c.check_kind === k)) && checks.every(c => c.result !== 'blocked');
      tx.run('UPDATE deletion_operation SET state=?,completed_at=?,runner_token=NULL,runner_runtime=NULL WHERE operation_id=?', [complete ? 'completed' : 'blocked', complete ? Date.now() : null, op.operationId]);
      if (complete) tx.run('UPDATE deletion_target SET row_key_snapshot=NULL,managed_locator=NULL,expected_identity=NULL,target_payload=NULL,last_error_code=NULL WHERE operation_id=?', [op.operationId]);
      return snapshot(tx, find(tx, input));
    }),
    { name: 'deletion.compact', mode: 'maintenance', retryBusy: false, execute(maintenance) {
      if (maintenance.checkpoint().busy !== 0n) fail('deletion_checkpoint_busy');
      maintenance.vacuum();
      if (maintenance.checkpoint().busy !== 0n) fail('deletion_checkpoint_busy');
      maintenance.check();
      const state = maintenance.inspect();
      if (state.freePages !== 0n || state.walBytes !== 0n || state.journalBytes !== 0n || state.tempStore !== 2n || state.secureDelete !== 1n || state.unexpectedFiles !== 0) fail('deletion_sqlite_residue');
      return { result: 'passed', proof: 'checkpoint_vacuum_verified', storageState: state };
    } },
  ];
}
