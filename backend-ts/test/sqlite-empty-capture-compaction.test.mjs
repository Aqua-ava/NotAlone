import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { record, fixture, select } from './fixtures/history/sync-support.mjs';

const databaseFile = f => join(f.root, 'managed/sqlite/notalone.sqlite');
const emptyCaptureCount = (f, goalId) => {
  const db = new DatabaseSync(databaseFile(f), { readOnly: true });
  try {
    return Number(db.prepare(`SELECT COUNT(*) n FROM sync_capture c WHERE c.goal_id=? AND NOT EXISTS
      (SELECT 1 FROM capture_record r WHERE r.owner_id=c.owner_id AND r.capture_id=c.id)`).get(goalId).n);
  } finally { db.close(); }
};
async function prepared(t) {
  const f = await fixture(t);
  f.state.historyRecords = [record('1')];
  const binding = await select(f);
  await f.history.synchronize(binding.contact_id);
  const token = await f.contacts.eligibility(binding.contact_id);
  const goalId = (await f.history.coverage(binding.contact_id)).incremental.goalId;
  assert.ok(goalId);
  const accept = (cursorIn, cursorOut, records = []) => {
    const input = { token, goalId, captureId: randomUUID(), at: Date.now(),
      page: { target: f.state.targetDescriptor, cursorIn, cursorOut, caughtUp: true, records }, runtimeToken: f.storage.status.runtimeId };
    return f.storage.execute('history.acceptIncrementalPage', input).then(result => ({ input, result }));
  };
  return { f, binding, goalId, accept };
}

test('增量连续空页每个目标只保留最新一条，游标与页数照常推进，最新响应重放幂等', async t => {
  const { f, goalId, accept } = await prepared(t);
  await accept('tail-1', 'tail-2');
  await accept('tail-2', 'tail-3');
  const last = await accept('tail-3', 'tail-4');
  assert.equal(emptyCaptureCount(f, goalId), 1, '连续空页压缩为最新一条');
  assert.equal(last.result.incremental.pagesAccepted, 3, '被压缩的空页仍计入已接受页数');
  const replay = await f.storage.execute('history.acceptIncrementalPage', last.input);
  assert.equal(replay.incremental.pagesAccepted, 3, '最新空页重放不重复推进');
  const next = await accept('tail-4', 'tail-5');
  assert.equal(next.result.incremental.pagesAccepted, 4, '压缩后游标仍可继续接续');
  assert.equal(emptyCaptureCount(f, goalId), 1);
});

test('带记录的增量页及其来源不被空页压缩影响', async t => {
  const { f, binding, goalId, accept } = await prepared(t);
  await accept('tail-1', 'tail-2');
  await accept('tail-2', 'tail-3', [record('2')]);
  await accept('tail-3', 'tail-4');
  await accept('tail-4', 'tail-5');
  assert.equal(emptyCaptureCount(f, goalId), 1);
  const db = new DatabaseSync(databaseFile(f), { readOnly: true });
  try {
    assert.equal(Number(db.prepare('SELECT COUNT(*) n FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id WHERE c.goal_id=?').get(goalId).n), 1, '带记录页的来源记录保留');
  } finally { db.close(); }
  assert.equal((await f.history.read(binding.contact_id)).messages.length, 2, '消息与来源追溯不变');
});

test('目标收到新空页时顺带清除其存量旧空页，不动带记录页和其他目标的页', async t => {
  const { f, goalId, accept } = await prepared(t);
  await accept('tail-1', 'tail-2', [record('2')]);
  const db = new DatabaseSync(databaseFile(f));
  let seeded;
  try {
    const goal = db.prepare('SELECT owner_id,contact_id FROM read_goal WHERE id=?').get(goalId);
    const historyGoal = db.prepare("SELECT id FROM read_goal WHERE kind='history' AND contact_id=? LIMIT 1").get(goal.contact_id).id;
    let no = Number(db.prepare('SELECT max(acceptance_no) m FROM sync_capture').get().m);
    const insert = db.prepare(`INSERT INTO sync_capture(owner_id,id,contact_id,goal_id,read_epoch,runtime_token,captured_at,adapter_version,cursor_in,cursor_out,state,response_digest,acceptance_no)
      VALUES(?,?,?,?,1,'rt',1,'1','a','b','accepted','d',?)`);
    seeded = [goalId, goalId, goalId, historyGoal, historyGoal].map(target => {
      const id = randomUUID(); insert.run(goal.owner_id, id, goal.contact_id, target, ++no); return { id, target };
    });
  } finally { db.close(); }
  assert.equal(emptyCaptureCount(f, goalId), 3, '存量空页尚未清除');
  await accept('tail-2', 'tail-3');
  const check = new DatabaseSync(databaseFile(f), { readOnly: true });
  try {
    const alive = new Set(check.prepare('SELECT id FROM sync_capture').all().map(row => row.id));
    assert.ok(!seeded.slice(0, 3).some(row => alive.has(row.id)), '该目标的存量旧空页被清除');
    assert.ok(alive.has(seeded[3].id) && alive.has(seeded[4].id), '历史目标的页不受影响');
    assert.equal(Number(check.prepare('SELECT COUNT(*) n FROM capture_record r JOIN sync_capture c ON c.owner_id=r.owner_id AND c.id=r.capture_id WHERE c.goal_id=?').get(goalId).n), 1, '带记录页保留');
  } finally { check.close(); }
  assert.equal(emptyCaptureCount(f, goalId), 1, '该目标只剩最新一条空页');
});
