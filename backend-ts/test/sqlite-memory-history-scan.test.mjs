import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { fixture, owner, record } from './fixtures/memory-sqlite/support.mjs';
import { controlledFiles } from '../src/storage/sqlite/files.ts';
import { scheduleActions } from '../src/memory/sqlite/runs.ts';
import { createExtractionPolicyVersion } from '../src/memory/extraction/policy-version.ts';

test('统一到期扫描保持顺序和阻塞语义，每个所选联系人只读取一次轻量候选', async t => {
  const f = await fixture(t), [a, b] = f.saved;
  f.channel.page = async (_scope, target, cursor) => ({ target: target.descriptor, cursorIn: cursor,
    cursorOut: null, records: Array.from({ length: 60 }, (_, index) => record(String(index + 1))),
    completedPartitions: ['shard-a'], exhausted: true });
  await f.service.synchronize(a.contact_id); await f.service.synchronize(b.contact_id);
  const db = new DatabaseSync(controlledFiles(f.root, false).database, { readOnly: true });
  t.after(() => db.close());
  const scannedContacts = [];
  const all = (sql, values = []) => {
    if (sql.includes('schedule_candidate_messages AS MATERIALIZED')) {
      scannedContacts.push(values[1]);
      assert.doesNotMatch(sql,/text_body|raw_payload/,'到期扫描不读取聊天正文');
    }
    const statement = db.prepare(sql); statement.setReadBigInts(true); return statement.all(...values);
  };
  const tx = { all, get: (sql, values) => all(sql, values)[0], run: () => { throw Error('只读扫描不得写入'); } };
  const at = 1700000000000;
  const ids=[a.contact_id,b.contact_id].sort();
  const scan = (contactIds=ids) => scheduleActions.find(action => action.name === 'memoryExtraction.scanSchedule').execute(tx, { ownerId: owner, now: at, contactIds });
  assert.deepEqual(scan(),{contacts:ids.map(contactId=>({contactId,incrementalDueAt:null,historyDue:true}))});
  assert.deepEqual(scannedContacts,ids,'历史和增量共享同一批候选，不各扫一次');

  const policy = await createExtractionPolicyVersion();
  await f.storage.execute('memoryExtraction.startHistoryBatch', { ownerId: owner, contactId: a.contact_id,
    requestKey: randomUUID(), policyConfig: policy.newTaskConfig(), now: at });
  scannedContacts.length=0;
  assert.deepEqual(scan(),{contacts:ids.map(contactId=>({contactId,incrementalDueAt:null,historyDue:contactId===b.contact_id}))},'已有未完成处理轮次的联系人不能再次到期');
  assert.deepEqual(scannedContacts,ids);
  f.channel.page = async () => { throw Error('合成历史中断'); };
  await assert.rejects(f.service.synchronize(b.contact_id));
  assert.deepEqual(scan(),{contacts:ids.map(contactId=>({contactId,incrementalDueAt:null,historyDue:false}))},'未完成历史保持不可到期');
  scannedContacts.length=0;
  assert.deepEqual(scan([a.contact_id]),{contacts:[{contactId:a.contact_id,incrementalDueAt:null,historyDue:false}]});
  assert.deepEqual(scannedContacts,[a.contact_id],'联系人定向唤醒不读取其他联系人的候选');
});
