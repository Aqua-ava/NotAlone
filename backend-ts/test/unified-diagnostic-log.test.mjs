import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, readdir, readFile, lstat, chmod, mkdir, symlink, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { UnifiedDiagnosticLog, readDiagnosticRecords } from '../src/diagnostics/unified-log.mjs';
async function fixture(t) { const root = await realpath(await mkdtemp(path.join(tmpdir(), 'notalone-unified-log-'))); await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true })); return root; }
const event = { event: 'request.finished', module: 'memory.management', caller: 'management_read', durationMs: 2 };
test('诊断异步写入私有文件，拒绝敏感字段；关闭后静默且可重新开启', async t => {
  const root = await fixture(t), log = new UnifiedDiagnosticLog(root, { proc: 'main', development: true });
  log.diagnose(event); log.diagnose({ ...event, message: '绝不能落盘的合成正文' }); await log.flush();
  assert.equal((await readDiagnosticRecords(root)).length, 1);
  assert.equal((await lstat(path.join(root, 'logs'))).mode & 0o777, 0o700);
  const files = await readdir(path.join(root, 'logs'));
  assert.equal((await lstat(path.join(root, 'logs', files[0]))).mode & 0o777, 0o600);
  assert.ok(!(await readFile(path.join(root, 'logs', files[0]), 'utf8')).includes('合成正文'));
  await log.setEnabled(false); log.diagnose(event); await log.flush(); assert.equal((await readDiagnosticRecords(root)).length, 1);
  await log.setEnabled(true); log.diagnose(event); await log.flush(); assert.equal((await readDiagnosticRecords(root)).length, 2);
  assert.equal(log.stats().rejected, 1); await log.clear(); assert.equal((await readDiagnosticRecords(root)).length, 0);
});
test('写前轮转、日期轮转、跨进程总预算和保留期清理', async t => {
  const root = await fixture(t); let now = Date.now();
  const options = { development: true, maxFileBytes: 512, maxTotalBytes: 2048, now: () => now };
  const main = new UnifiedDiagnosticLog(root, { ...options, proc: 'main' }), backend = new UnifiedDiagnosticLog(root, { ...options, proc: 'backend' });
  for (let i = 0; i < 80; i++) { main.diagnose(event); backend.diagnose(event); } await Promise.all([main.flush(), backend.flush()]);
  const directory = path.join(root, 'logs'); let files = await readdir(directory);
  assert.ok(files.length > 1); let total = 0;
  for (const name of files) { const stat = await lstat(path.join(directory, name)); assert.ok(stat.size <= 512); total += stat.size; } assert.ok(total <= 2048);
  const previous = files.filter(name => name.startsWith('main-')); now += 86400_000; main.diagnose(event); await main.flush(); files = await readdir(directory);
  assert.ok(files.some(name => name.startsWith('main-') && !previous.includes(name)));
  const old = new Date(now - 15 * 86400_000); for (const name of files) await utimes(path.join(directory, name), old, old);
  const restarted = new UnifiedDiagnosticLog(root, { ...options, proc: 'main' }); await restarted.flush();
  assert.ok((await readdir(directory)).every(name => !name.startsWith('main-')));
});
test('符号链接和宽松目录权限令日志静默停写，不改动链接目标', async t => {
  const root = await fixture(t), target = path.join(root, 'target'); await writeFile(target, '不可改动', { mode: 0o600 }); await symlink(target, path.join(root, 'logs'));
  const log = new UnifiedDiagnosticLog(root, { proc: 'main', development: true }); assert.doesNotThrow(() => log.diagnose(event)); await log.flush(); assert.equal(await readFile(target, 'utf8'), '不可改动');
  await rm(path.join(root, 'logs')); await mkdir(path.join(root, 'logs'), { mode: 0o755 });
  const unsafe = new UnifiedDiagnosticLog(root, { proc: 'main', development: true }); unsafe.diagnose(event); await unsafe.flush(); assert.equal((await readdir(path.join(root, 'logs'))).length, 0);
});
test('已存在的日志符号链接不被读取、写入、导出或清除', async t => {
  const root = await fixture(t), directory = path.join(root, 'logs'); await mkdir(directory, { mode: 0o700 });
  const target = path.join(root, 'target'); await writeFile(target, '保留目标', { mode: 0o600 });
  await symlink(target, path.join(directory, `main-${new Date().toISOString().slice(0, 10)}-1.jsonl`));
  const log = new UnifiedDiagnosticLog(root, { proc: 'main', development: true }); log.diagnose(event); await log.flush(); assert.deepEqual(await readDiagnosticRecords(root), []); await log.clear(); assert.equal(await readFile(target, 'utf8'), '保留目标');
});
test('并发diagnose与flush不丢失或重复，清除竞态后仍继续记录', async t => {
  const root = await fixture(t), log = new UnifiedDiagnosticLog(root, { proc: 'backend', development: true });
  await Promise.all(Array.from({ length: 128 }, async (_, i) => { log.diagnose({ ...event, count: i }); if (i % 13 === 0) await log.flush(); }));
  await log.flush(); const rows = await readDiagnosticRecords(root); assert.equal(rows.length, 128); assert.equal(new Set(rows.map(row => row.count)).size, 128);
  const main = new UnifiedDiagnosticLog(root, { proc: 'main', development: true });
  await Promise.all([main.clear(), (async () => { log.diagnose(event); await log.flush(); })()]);
  log.diagnose({ ...event, count: 999 }); await log.flush(); assert.ok((await readDiagnosticRecords(root)).some(row => row.count === 999));
});
test('正式默认过滤debug，临时排查到期自动恢复，越界记录不能进入导出', async t => {
  const root = await fixture(t); let now = Date.now(); const log = new UnifiedDiagnosticLog(root, { proc: 'main', now: () => now });
  log.diagnose(event); log.diagnose({ event: 'request.slow', module: 'memory.management', durationMs: 1001 }); await log.flush(); assert.equal((await readDiagnosticRecords(root)).length, 1);
  log.setDebugFor(1000); log.diagnose(event); await log.flush(); assert.equal((await readDiagnosticRecords(root)).length, 2);
  now += 1001; log.diagnose(event); await log.flush(); assert.equal((await readDiagnosticRecords(root)).length, 2);
});
test('同一次操作的高频debug汇总次数和耗时，决策与错误逐条保留', async t => {
  const root = await fixture(t), log = new UnifiedDiagnosticLog(root, { proc: 'main', development: true }), traceId = '11111111-1111-4111-8111-111111111111';
  for (let i = 0; i < 200; i++) log.diagnose({ event: 'sql.summary', module: 'memory.management', traceId, sqlFingerprint: 'a'.repeat(16), count: 1, durationMs: 2 });
  for (let i = 0; i < 2; i++) log.diagnose({ event: 'management.invalidated', traceId, reasonCode: 'scope_changed' });
  for (let i = 0; i < 2; i++) log.diagnose({ event: 'diagnostics.error', module: 'startup', traceId, reasonCode: 'failed' });
  await log.flush(); const rows = await readDiagnosticRecords(root), summary = rows.filter(row => row.event === 'sql.summary');
  assert.equal(summary.length, 1); assert.equal(summary[0].count, 200); assert.equal(summary[0].durationMs, 400);
  assert.equal(rows.filter(row => row.event === 'management.invalidated').length, 2); assert.equal(rows.filter(row => row.level === 'error').length, 2);
});
test('联系人前缀清除只去除匹配行，返回真实结果，失败不宣称完成', async t => {
  const root = await fixture(t), log = new UnifiedDiagnosticLog(root, { proc: 'main', development: true });
  log.diagnose({ ...event, contactPrefix: 'aaaaaaaa' }); log.diagnose({ ...event, contactPrefix: 'bbbbbbbb' }); log.diagnose(event); await log.flush();
  assert.equal(await log.eraseContact('aaaaaaaa'), true); let rows = await readDiagnosticRecords(root); assert.equal(rows.length, 2); assert.ok(rows.every(row => row.contactPrefix !== 'aaaaaaaa'));
  assert.equal(await log.eraseContact('敏感合成输入'), false); assert.equal(await log.clear(), true); assert.deepEqual(await readDiagnosticRecords(root), []);
  const target = path.join(root, 'target'); await writeFile(target, '不能删除', { mode: 0o600 }); await symlink(target, path.join(root, 'logs', `backend-${new Date().toISOString().slice(0, 10)}-1.jsonl`));
  assert.equal(await log.clear(), false); assert.equal(await readFile(target, 'utf8'), '不能删除');
});
