import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, stat, copyFile, mkdir, symlink, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture, owner, record, report, restart} from './sqlite-clear-support.mjs';

const registryModule = new URL('./fixtures/history/continuity-diagnostic-registry.mjs', import.meta.url).href;
async function diagnosticRows(root) {
  const rows = [];
  for (const suffix of ['', '.1', '.2', '.3']) {
    const path = join(root, 'logs', `history-continuity.jsonl${suffix}`);
    try {
      assert.ok((await stat(path)).size <= 1024 * 1024, '测试每份日志最多读取1MiB且最多四份');
      rows.push(...(await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return rows;
}
function assertSafe(rows) {
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).filter(key => key !== 'errorCode').sort(), ['branch', 'contactPrefix', 'entry', 'time']);
    assert.ok(Number.isFinite(typeof row.time === 'number' ? row.time : Date.parse(row.time)));
    assert.match(row.contactPrefix, /^[0-9a-f]{8}$/);
    if (row.errorCode !== undefined) assert.match(row.errorCode, /^[a-z][a-z0-9_]{0,127}$/);
  }
  assert.doesNotMatch(JSON.stringify(rows), /合成正文|合成甲|合成乙|[0-9a-f]{8}-[0-9a-f-]{27}/i);
}
async function seed(t, normalUse = true) {
  const f = await fixture(t, {registryModule});
  f.state.pageRecords = [record('shard-a', '1')];
  f.channel.guardSession = {loss: new Promise(() => {})};
  f.state.inspectFactory = scope => ({...report,
    continuity: normalUse ? 'same-source-instances-normal-use-v1' : 'synthetic-generation-1',
    capabilities: {normalHistory: 'supported', snapshotBarrier: 'supported', partitionCoverage: 'supported'},
    accountKey: scope.accountKey, conversationKey: scope.conversationKey, sourceGeneration: scope.token.source_generation});
  await f.current.history.synchronize(f.contactA);
  return f;
}
async function markLost(f, contactId = f.contactA, extra = {}) {
  const token = await f.current.contacts.eligibility(contactId);
  return f.current.storage.execute('history.markContinuityLost', {token, ...extra});
}
test('真正提交的来源失证只追加一条安全围栏诊断，重复围栏不重复记录', async t => {
  const f = await seed(t);
  const token = await f.current.contacts.eligibility(f.contactA);
  await f.current.storage.execute('history.markContinuityLost', {token});
  const rows = await diagnosticRows(f.root);
  assert.equal(rows.length, 1, '真正新增围栏提交后应持久追加日志');
  assert.equal(rows[0].entry, 'history.markContinuityLost');
  assert.equal(rows[0].contactPrefix, f.contactA.slice(0, 8));
  assert.equal(rows[0].branch, 'L01');
  assertSafe(rows);
  await f.current.storage.execute('history.markContinuityLost', {token});
  assert.deepEqual(await diagnosticRows(f.root), rows);
});

test('实际账号变化提交待确认后保留L01诊断与固定错误码',async t=>{
  const f=await seed(t);
  await markLost(f,f.contactA,{errorCode:'history_account_changed'});
  const rows=await diagnosticRows(f.root);
  assert.equal(rows.length,1);
  assert.deepEqual([rows[0].entry,rows[0].branch,rows[0].errorCode],['history.markContinuityLost','L01','history_account_changed']);
  assertSafe(rows);
});

test('真实readPreflight来源代次冲突记录G02及调用入口', async t => {
  const f = await seed(t, false);
  await f.current.storage.execute('fixture.continuityDiagnosticSourceChanged', {ownerId: owner, contactId: f.contactA});
  await assert.rejects(f.current.history.synchronize(f.contactA), {code: 'history_source_continuity_unverified'});
  const rows = await diagnosticRows(f.root);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].entry, rows[0].branch, rows[0].contactPrefix], ['history.readPreflight', 'G02', f.contactA.slice(0, 8)]);
  assertSafe(rows);
});

test('真实正常来源守卫握手拒绝物理目标变化并记录N04', async t => {
  const f = await seed(t), token = await f.current.contacts.eligibility(f.contactA);
  const scope = await f.current.storage.execute('history.scope', {token});
  const changed = await f.channel.target(scope);
  changed.tables[0].instance = 'synthetic-replaced-physical-table';
  f.channel.target = async () => changed;
  await assert.rejects(f.current.history.synchronize(f.contactA), {code: 'history_source_continuity_unverified'});
  const rows = await diagnosticRows(f.root);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].entry, rows[0].branch, rows[0].contactPrefix], ['history.prepareNormalUseGuard', 'N04', f.contactA.slice(0, 8)]);
  assertSafe(rows);
});

test('来源错误码夹带正文或姓名时省略错误码且不影响围栏诊断', async t => {
  const f = await seed(t);
  await markLost(f, f.contactA, {errorCode: '合成甲：合成正文1'});
  const rows = await diagnosticRows(f.root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].errorCode, undefined);
  assertSafe(rows);
});

for (const rebuildFence of [false, true]) test(`真实认证失败${rebuildFence ? '补建围栏记录C01' : '保留已有围栏且不重复记录'}`, async t => {
  const f = await seed(t), token = await f.current.contacts.eligibility(f.contactA), id = randomUUID();
  await markLost(f);
  await f.current.storage.execute('history.recertifyPrepare', {token, id, requestKey: 'synthetic-diagnostic-failure', at: Date.now()});
  if (rebuildFence) await f.current.storage.execute('fixture.continuityDiagnosticRemoveFence', {ownerId: owner, contactId: f.contactA});
  await f.current.storage.execute('history.recertifyFail', {ownerId: owner, id, code: 'history_source_changed', at: Date.now()});
  const rows = await diagnosticRows(f.root);
  assert.equal(rows.length, rebuildFence ? 2 : 1);
  if (rebuildFence) assert.deepEqual([rows[1].entry, rows[1].branch, rows[1].contactPrefix], ['history.recertifyFail', 'C01', f.contactA.slice(0, 8)]);
  assertSafe(rows);
  await f.current.storage.execute('history.recertifyFail', {ownerId: owner, id, code: 'history_source_changed', at: Date.now()});
  assert.deepEqual(await diagnosticRows(f.root), rows);
});

test('真正回滚的事务不写诊断且不把待写事件泄漏到下次成功事务', async t => {
  const f = await seed(t);
  await assert.rejects(f.current.storage.execute('fixture.continuityDiagnosticRollback', {ownerId: owner, contactId: f.contactA}),
    {code: 'synthetic_diagnostic_rollback'});
  assert.deepEqual(await diagnosticRows(f.root), []);
  assert.deepEqual(await f.current.storage.execute('fixture.continuityDiagnosticFences', {ownerId: owner}), []);
  await markLost(f, f.contactA, {errorCode: 'history_source_changed'});
  const rows = await diagnosticRows(f.root);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entry, 'history.markContinuityLost');
  assert.equal(rows[0].errorCode, 'history_source_changed');
  assertSafe(rows);
});

test('同目录干净重开后追加新联系人围栏日志并保留原记录', async t => {
  const f = await seed(t);
  await markLost(f);
  const original = await diagnosticRows(f.root);
  assert.equal(original.length, 1);
  await restart(f, t);
  await f.current.history.synchronize(f.contactB);
  await markLost(f, f.contactB);
  const rows = await diagnosticRows(f.root);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], original[0]);
  assert.equal(rows[1].contactPrefix, f.contactB.slice(0, 8));
  assertSafe(rows);
});

for (const kind of ['contact', 'account']) test(`真实DeletionService${kind === 'contact' ? '联系人删除过滤本人' : '账号删除清空'}全部诊断轮转文件`, async t => {
  const f = await seed(t);
  await f.current.history.synchronize(f.contactB);
  await markLost(f); await markLost(f, f.contactB);
  const original = await diagnosticRows(f.root);
  assert.equal(original.length, 2);
  // 复制真实worker产出的合成记录，模拟已保留的三份历史轮转文件。
  const path = join(f.root, 'logs', 'history-continuity.jsonl');
  for (const suffix of ['.1', '.2', '.3']) await copyFile(path, `${path}${suffix}`);
  const op = await f.current.deletion.plan({ownerId: owner, requestKey: `synthetic-diagnostic-delete-${kind}`,
    scope: kind === 'contact' ? {kind, contactId: f.contactA} : {kind}});
  assert.equal((await f.current.deletion.advance(op)).state, 'completed');
  const rows = await diagnosticRows(f.root);
  assert.equal(rows.length, kind === 'contact' ? 4 : 0);
  for (const row of rows) assert.equal(row.contactPrefix, f.contactB.slice(0, 8));
  assertSafe(rows);
});

test('日志路径被符号链接替换时仍提交来源围栏并封禁后续来源正文读取', async t => {
  const f = await seed(t);
  assert.equal((await f.current.history.readChat(f.contactA)).messages.length, 1);
  const directory = join(f.root, 'logs'), outside = join(f.root, 'synthetic-outside-log');
  await mkdir(directory, {recursive: true, mode: 0o700});
  await writeFile(outside, 'synthetic-unchanged-marker', {mode: 0o600});
  await symlink(outside, join(directory, 'history-continuity.jsonl'));
  const pages = f.state.pageCalls;
  assert.equal(await markLost(f), false);
  assert.deepEqual(await f.current.storage.execute('fixture.continuityDiagnosticFences', {ownerId: owner}),
    [{contact_id: f.contactA}]);
  assert.equal((await f.current.history.coverage(f.contactA)).failureCode, 'history_source_continuity_unverified');
  await assert.rejects(f.current.history.synchronize(f.contactA), {code: 'history_source_recovery_unsupported'});
  assert.equal(f.state.pageCalls, pages, '诊断失败后仍不再读取正文');
  assert.equal(await readFile(outside, 'utf8'), 'synthetic-unchanged-marker');
});

for (const kind of ['contact', 'account']) test(`真实${kind === 'contact' ? '联系人' : '账号'}删除遇日志符号链接必须blocked并保留日志`, async t => {
  const f = await seed(t);
  await markLost(f);
  const current = join(f.root, 'logs', 'history-continuity.jsonl');
  const preserved = join(f.root, 'synthetic-preserved-diagnostic.jsonl');
  const before = await readFile(current, 'utf8');
  await rename(current, preserved);
  await symlink(preserved, current);
  const op = await f.current.deletion.plan({ownerId: owner, requestKey: `synthetic-diagnostic-blocked-${kind}`,
    scope: kind === 'contact' ? {kind, contactId: f.contactA} : {kind}});
  assert.equal((await f.current.deletion.advance(op)).state, 'blocked');
  assert.equal((await f.current.deletion.status(op)).state, 'blocked');
  assert.equal(await readFile(preserved, 'utf8'), before, '清日志失败不能跟随链接改写目标');
});

test('无有效删除runner不能调用内部清日志入口且保留真实日志', async t => {
  const f = await seed(t);
  await markLost(f);
  const before = await diagnosticRows(f.root);
  assert.equal(before.length, 1);
  await assert.rejects(f.current.storage.execute('storage.eraseContinuityDiagnostics', {
    ownerId: owner, operationId: randomUUID(), token: 'synthetic-forged-runner', planRevision: 0n,
  }), {code: 'deletion_stale_runner'});
  assert.deepEqual(await diagnosticRows(f.root), before);
  const op = await f.current.deletion.plan({ownerId: owner, requestKey: 'synthetic-diagnostic-runner-rejected',
    scope: {kind: 'contact', contactId: f.contactA}});
  await assert.rejects(f.current.storage.execute('storage.eraseContinuityDiagnostics', {
    ownerId: owner, operationId: op.operationId, token: 'synthetic-forged-runner', planRevision: op.planRevision,
  }), {code: 'deletion_stale_runner'});
  assert.deepEqual(await diagnosticRows(f.root), before);
  assertSafe(before);
});
