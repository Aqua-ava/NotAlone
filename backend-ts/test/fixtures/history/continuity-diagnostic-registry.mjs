import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';

const actions = [
  {name: 'fixture.continuityDiagnosticRollback', mode: 'write', retryBusy: false, execute(tx, input) {
    tx.run('INSERT INTO history_continuity_fence VALUES(?,?,?)',
      [input.ownerId, input.contactId, 'history_source_continuity_unverified']);
    tx.recordDiagnostic({kind: 'history_continuity_fence', contactPrefix: input.contactId.slice(0, 8), branch: 'L01'});
    throw new StorageFailure('synthetic_diagnostic_rollback');
  }},
  {name: 'fixture.continuityDiagnosticLoseGuard', mode: 'write', retryBusy: false, execute(tx, input) {
    if (!tx.get('SELECT 1 FROM history_guard_lease WHERE owner_id=? AND contact_id=?', [input.ownerId, input.contactId]))
      throw new StorageFailure('synthetic_guard_missing');
    tx.run("UPDATE history_guard_lease SET state='lost' WHERE owner_id=? AND contact_id=?", [input.ownerId, input.contactId]);
    return true;
  }},
  // 仅构造罕见的认证失败补建围栏，不绕过产品入口产生审计日志。
  {name: 'fixture.continuityDiagnosticRemoveFence', mode: 'write', retryBusy: false, execute(tx, input) {
    tx.run('DELETE FROM history_continuity_fence WHERE owner_id=? AND contact_id=?', [input.ownerId, input.contactId]);
    return true;
  }},
  {name: 'fixture.continuityDiagnosticFences', mode: 'read', retryBusy: false, execute(tx, input) {
    return tx.all('SELECT contact_id FROM history_continuity_fence WHERE owner_id=? ORDER BY contact_id', [input.ownerId]);
  }},
];

export const registry = {...base, actions: [...base.actions, ...actions]};
