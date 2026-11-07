import {snapshotContinuity} from './source-proof-snapshot.mjs';
import {registry as base} from '../../../src/storage/sqlite/registry.ts';

// 只读观测来源恢复和重启后的持久状态。
const snapshot = {
  name: 'fixture.recoverySnapshot', mode: 'read', retryBusy: true,
  execute(tx, input) {
    const rows = table => tx.all(`SELECT * FROM ${table} WHERE owner_id=? AND contact_id=? ORDER BY rowid`,
      [input.ownerId, input.contactId]);
    return {
      ...snapshotContinuity(tx,input.ownerId,input.contactId),runtime: tx.get('SELECT runtime_id,epoch FROM database_instance WHERE slot=1'),
      bindings: rows('conversation_binding'),
      goals: rows('read_goal'), captures: rows('sync_capture'), messages: rows('message'),
    };
  },
};

export const registry = {...base, actions: [...base.actions, snapshot]};
