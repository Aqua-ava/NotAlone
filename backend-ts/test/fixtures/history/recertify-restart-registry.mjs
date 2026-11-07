import {registry as base} from '../../../src/storage/sqlite/registry.ts';

// 只读观测真实重新认证和重启后的持久状态，不修改来源或认证结果。
const snapshot = {
  name: 'fixture.recertifyRestartSnapshot', mode: 'read', retryBusy: true,
  execute(tx, input) {
    const rows = table => tx.all(`SELECT * FROM ${table} WHERE owner_id=? AND contact_id=? ORDER BY rowid`,
      [input.ownerId, input.contactId]);
    return {
      runtime: tx.get('SELECT runtime_id,epoch FROM database_instance WHERE slot=1'),
      bindings: rows('conversation_binding'), scopes: rows('history_continuity_scope'), leases: rows('history_guard_lease'),
      fences: rows('history_continuity_fence'), operations: rows('history_source_recertification'),
      goals: rows('read_goal'), captures: rows('sync_capture'), messages: rows('message'),
    };
  },
};

export const registry = {...base, actions: [...base.actions, snapshot]};
