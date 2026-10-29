import { registry as base } from '../../../src/storage/sqlite/registry.ts';
// 测试替身只改受控账号来源代次，模拟真实来源换代；不代表生产入口。
const changeSourceGeneration = { name: 'fixture.changeSourceGeneration', mode: 'write', retryBusy: true,
  execute(tx, input) {
    tx.run('UPDATE channel_account SET source_generation=? WHERE owner_id=?', [input.sourceGeneration, input.ownerId]);
    return true;
  } };
export const registry = { migrations: base.migrations, actions: [...base.actions, changeSourceGeneration] };
