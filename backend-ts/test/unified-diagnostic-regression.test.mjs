import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, chmod, rm, readdir, readFile, appendFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UnifiedDiagnosticLog, readDiagnosticRecords } from '../src/diagnostics/unified-log.mjs';
import { checkedDiagnosticEvent, checkedDiagnosticRecord } from '../src/diagnostics/unified-contract.mjs';
async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-diagnostic-regression-')));
  await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true })); return root;
}
const event = count => ({ event: 'diagnostics.changed', count });
test('事件名拒绝隐式字符串转换和自定义序列化，敏感合成输入不能落盘', async t => {
  const root = await fixture(t), log = new UnifiedDiagnosticLog(root, { proc: 'main' });
  let coercions = 0;
  const privateValue = { toString() { coercions++; return 'diagnostics.changed'; }, toJSON() { return 'SYNTHETIC_PRIVATE_PAYLOAD'; } };
  log.diagnose({ event: privateValue }); log.diagnose(event(1)); await log.flush();
  const files = await readdir(path.join(root, 'logs'));
  const text = (await Promise.all(files.map(file => readFile(path.join(root, 'logs', file), 'utf8')))).join('');
  assert.ok(!text.includes('SYNTHETIC_PRIVATE_PAYLOAD'));
  assert.equal(checkedDiagnosticEvent({ event: privateValue }), undefined);
  assert.equal(checkedDiagnosticRecord({ event: privateValue, time: new Date().toISOString(), level: 'info', proc: 'main' }), undefined);
  assert.equal(coercions, 0);
  assert.equal(log.stats().rejected, 1); assert.equal((await readDiagnosticRecords(root)).length, 1);
});
test('低流量连续运行跨过16天，在日期轮转时清除过期文件', async t => {
  const root = await fixture(t); let now = Date.now(); const log = new UnifiedDiagnosticLog(root, { proc: 'main', now: () => now });
  log.diagnose(event(1)); await log.flush(); const original = await readdir(path.join(root, 'logs'));
  now += 16 * 86400_000; log.diagnose(event(2)); await log.flush();
  const files = await readdir(path.join(root, 'logs'));
  assert.ok(original.every(file => !files.includes(file))); assert.equal(files.length, 1);
  assert.deepEqual((await readDiagnosticRecords(root)).map(row => row.count), [2]);
});
test('持续追加期间读取有界完整行快照，已有时间线不会整包丢失', async t => {
  const root = await fixture(t), main = new UnifiedDiagnosticLog(root, { proc: 'main' }), backend = new UnifiedDiagnosticLog(root, { proc: 'backend' });
  for (let i = 0; i < 400; i++) main.diagnose(event(i)); backend.diagnose(event(100000));
  await Promise.all([main.flush(), backend.flush()]);
  const reads = [], writer = (async () => {
    for (let batch = 0; batch < 100; batch++) { for (let i = 0; i < 4; i++) main.diagnose(event(400 + batch * 4 + i)); await main.flush(); }
  })();
  for (let i = 0; i < 80; i++) reads.push(await readDiagnosticRecords(root));
  const results = reads; await writer;
  assert.ok(results.every(rows => rows.length >= 401), `已有记录丢失的快照数：${results.filter(rows => rows.length < 401).length}`);
  assert.ok(results.every(rows => rows.some(row => row.count === 0) && rows.some(row => row.count === 100000)));
  assert.equal((await readDiagnosticRecords(root)).length, 801);
});

test('查询跳过不安全邻接文件和未完成尾行，保留其他完整记录', async t => {
  const root = await fixture(t), log = new UnifiedDiagnosticLog(root, { proc: 'main' });
  log.diagnose(event(1)); await log.flush();
  const directory = path.join(root, 'logs'), file = path.join(directory, (await readdir(directory))[0]);
  await appendFile(file, '{"event":"diagnostics.changed"');
  const target = path.join(root, 'private-target'); await writeFile(target, 'SYNTHETIC_PRIVATE_PAYLOAD', { mode: 0o600 });
  await symlink(target, path.join(directory, `backend-${new Date().toISOString().slice(0, 10)}-1.jsonl`));
  assert.deepEqual((await readDiagnosticRecords(root)).map(row => row.count), [1]);
  assert.equal(await readFile(target, 'utf8'), 'SYNTHETIC_PRIVATE_PAYLOAD');
});
