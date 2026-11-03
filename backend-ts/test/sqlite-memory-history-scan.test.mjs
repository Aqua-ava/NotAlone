import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture, owner, record } from './fixtures/memory-sqlite/support.mjs';
import { controlledFiles } from '../src/storage/sqlite/files.ts';
import { scheduleActions } from '../src/memory/sqlite/runs.ts';
import { createExtractionPolicyVersion } from '../src/memory/extraction/policy-version.ts';

test('历史到期扫描保持顺序和阻塞语义，未完成历史不读取正文统计，也不重复计算增量待处理', async t => {
  const f = await fixture(t), [a, b] = f.saved;
  f.channel.page = async (_scope, target, cursor) => ({ target: target.descriptor, cursorIn: cursor,
    cursorOut: null, records: Array.from({ length: 60 }, (_, index) => record(String(index + 1))),
    completedPartitions: ['shard-a'], exhausted: true });
  await f.service.synchronize(a.contact_id); await f.service.synchronize(b.contact_id);
  const db = new DatabaseSync(controlledFiles(f.root, false).database, { readOnly: true });
  t.after(() => db.close());
  let incrementalScans = 0; const historyContacts = [];
  const all = (sql, values = []) => {
    if (sql.includes("f.first_goal_kind='incremental' AND")) incrementalScans++;
    if (sql.includes("f.first_goal_kind='history' OR")) historyContacts.push(values[1]);
    const statement = db.prepare(sql); statement.setReadBigInts(true); return statement.all(...values);
  };
  const tx = { all, get: (sql, values) => all(sql, values)[0], run: () => { throw Error('只读扫描不得写入'); } };
  const at = 1700000000000;
  const due = () => scheduleActions.find(action => action.name === 'memoryExtraction.dueHistoryContacts').execute(tx, { ownerId: owner });
  const next = () => scheduleActions.find(action => action.name === 'memoryExtraction.nextHistoryDueAt').execute(tx, { ownerId: owner, now: at });
  assert.deepEqual(due(), [a.contact_id, b.contact_id].sort()); assert.equal(next(), at);
  assert.equal(incrementalScans, 0, '历史阻塞判定不需要读取未使用的增量消息统计');

  const policy = await createExtractionPolicyVersion();
  await f.storage.execute('memoryExtraction.startHistoryBatch', { ownerId: owner, contactId: a.contact_id,
    requestKey: randomUUID(), policyConfig: policy.newTaskConfig(), now: at });
  assert.deepEqual(due(), [b.contact_id], '已有未完成处理轮次的联系人不能再次到期'); assert.equal(next(), at);
  f.channel.page = async () => { throw Error('合成历史中断'); };
  await assert.rejects(f.service.synchronize(b.contact_id));
  historyContacts.length = 0;
  assert.deepEqual(due(), []); assert.equal(next(), null);
  assert.ok(!historyContacts.includes(b.contact_id), '未完成历史应在读取消息统计前退出');
  assert.equal(incrementalScans, 0);
});
