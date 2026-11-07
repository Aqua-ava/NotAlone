#!/usr/bin/env node
/**
 * 清理被取代绑定下没有派生引用的副本（离线维护工具，不进入产品启动；ADR-175）。
 *
 * 与 App 修复同步通过后的自动清理走同一套代码：`SupersededHistoryCleanup` → 统一删除服务的
 * `superseded_history` 范围，分批、可续跑，仍被记忆、候选、整理条目等引用的消息保留。
 * 用于处理 ADR-175 之前累积的存量副本——只在用户看过清单（superseded-inventory.mjs）并确认后运行。
 *
 * 安全边界：
 *  - 只能在 App 与后台完全退出后运行；lsof 确认没有进程持有数据库文件，否则拒绝。
 *  - 必须显式传 --confirm-clean=<联系人数>，且与实际处理名单一致；默认只处理当前可清理（未围栏）的联系人，
 *    --contacts-file 可进一步限定为名单内的联系人（每行一个联系人 ID）。
 *  - 执行前备份：--backup-dir 把数据库与媒体目录用 APFS 克隆复制过去（不占额外空间，媒体字节擦除后仍可恢复）；
 *    演练副本可用 --no-backup 跳过。
 *  - 只输出联系人 ID 前 8 位与数量，不输出名称或正文。重复运行安全：已清完的联系人不再产生操作。
 *
 * 用法（在 backend-ts/）：
 *   node scripts/maintenance/clean-superseded-history.mjs --user-data=<绝对路径> --confirm-clean=<数量> \
 *     (--backup-dir=<绝对路径，须不存在> | --no-backup) [--contacts-file=<名单>] [--max-batches=200] [--timing]
 */
import {execFileSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {SqliteStorage} from '../../src/storage/sqlite/client.ts';
import {ActiveHolders} from '../../src/storage/sqlite/deletion/holders.ts';
import {DeletionService} from '../../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../../src/storage/sqlite/deletion/managed-files.ts';
import {SupersededHistoryCleanup} from '../../src/history/sqlite/superseded-cleanup.ts';
import {supersededBindings, supersededCounts, supersededGate} from '../../src/history/sqlite/superseded.ts';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=') || 'true'];
}));
const fail = message => { console.error(`拒绝：${message}`); process.exit(2); };
const userDataArg = args.get('user-data');
if (!userDataArg || !userDataArg.startsWith('/')) fail('--user-data 必须是绝对路径');
const userData = realpathSync(userDataArg);
const dbPath = join(userData, 'managed/sqlite/notalone.sqlite');
if (!existsSync(dbPath)) fail('找不到 managed/sqlite/notalone.sqlite');
const maxBatches = Number(args.get('max-batches') ?? 200);
if (!Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 10_000) fail('--max-batches 必须是 1 到 10000 的整数');

// 没有任何进程持有数据库及其 WAL/SHM：lsof 无匹配时退出码为 1。
const holders = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync).flatMap(file => {
  try { return execFileSync('lsof', ['-t', '--', file], {encoding: 'utf8'}).split('\n').filter(Boolean); }
  catch (error) { if (error.status === 1) return []; throw error; }
});
if (holders.length) fail(`数据库仍被进程持有（${[...new Set(holders)].join(',')}），请先完全退出 App 与后台`);

// 先只读列出处理名单：未围栏、有可清对象的联系人（再与名单文件求交）。
const listing = new DatabaseSync(dbPath, {readOnly: true});
const reader = {all: (sql, values = []) => listing.prepare(sql).all(...values), get: (sql, values = []) => listing.prepare(sql).get(...values)};
const ownerRows = reader.all('SELECT owner_id FROM owner');
if (ownerRows.length !== 1) fail('库内 owner 数量不是 1');
const ownerId = String(ownerRows[0].owner_id);
const databaseId = String(reader.get('SELECT database_id FROM database_instance').database_id);
const role = String(reader.get('SELECT role FROM database_instance').role);
// 迁移 45 之前的库没有 superseded 相关表：先不统计，打开存储完成迁移后再按名单处理。
const migrated = Boolean(reader.get("SELECT 1 FROM sqlite_schema WHERE name='history_superseded_cleanup'"));
const wanted = args.get('contacts-file') ? new Set(readFileSync(args.get('contacts-file'), 'utf8').split('\n').map(line => line.trim()).filter(Boolean)) : undefined;
const candidates = reader.all("SELECT id FROM contact WHERE owner_id=? AND state='active' ORDER BY id", [ownerId]).map(row => String(row.id)).filter(id => !wanted || wanted.has(id));
const plan = [];
if (migrated) {
  for (const contactId of candidates) {
    const bindings = supersededBindings(reader, ownerId, contactId);
    if (!bindings.length || supersededGate(reader, ownerId, contactId, bindings)) continue;
    const counts = supersededCounts(reader, ownerId, contactId, bindings);
    if (counts.clearableMessages > 0) plan.push({contactId, counts});
  }
}
listing.close();
if (migrated) {
  console.log(`待处理联系人 ${plan.length} 位：${plan.map(p => `${p.contactId.slice(0, 8)}(可清 ${p.counts.clearableMessages}，媒体 ${p.counts.mediaFiles} 个)`).join('，') || '无'}`);
  if (Number(args.get('confirm-clean')) !== plan.length) fail(`--confirm-clean 必须等于待处理联系人数 ${plan.length}`);
} else {
  // 库未迁移时无法用同一规则预估；要求用户给出名单数量，迁移后只处理名单内且条件满足的联系人。
  if (!wanted) fail('库尚未升级到包含被取代副本清理的版本；请先用 --contacts-file 限定名单，或在副本上演练');
  if (Number(args.get('confirm-clean')) !== wanted.size) fail(`--confirm-clean 必须等于名单数量 ${wanted.size}`);
}

if (args.has('no-backup')) console.log('跳过备份（--no-backup）');
else {
  const backup = args.get('backup-dir');
  if (!backup || !backup.startsWith('/')) fail('缺少 --backup-dir=<绝对路径> 或 --no-backup');
  if (existsSync(backup)) fail('--backup-dir 必须是尚不存在的目录');
  mkdirSync(backup, {recursive: true, mode: 0o700});
  // APFS 克隆：不占额外空间，之后擦除媒体文件仍可从备份恢复。
  execFileSync('cp', ['-c', '-R', join(userData, 'managed/sqlite'), join(backup, 'sqlite')]);
  if (existsSync(join(userData, 'managed/media'))) execFileSync('cp', ['-c', '-R', join(userData, 'managed/media'), join(backup, 'media')]);
  console.log('已备份数据库与媒体目录');
}

const openStarted = performance.now();
// 数万目标的联系人，单个计划／核验动作超过产品的 15 秒预算；离线工具无并发读者，放宽到 15 分钟。
const storage = await SqliteStorage.open({userData, intent: 'open', expectedDatabaseId: databaseId, role, actionTimeoutMs: 15 * 60_000});
console.log(`已打开存储（schema ${storage.status.schemaVersion}），用时 ${((performance.now() - openStarted) / 1000).toFixed(1)} 秒`);
// --timing：按存储动作汇总次数、总耗时与最大单次耗时，用于定位慢处。
const actionStats = new Map();
if (args.has('timing')) {
  const execute = storage.execute.bind(storage);
  storage.execute = async (name, ...rest) => {
    const t = performance.now();
    try { return await execute(name, ...rest); }
    finally {
      const ms = performance.now() - t, entry = actionStats.get(name) ?? {n: 0, ms: 0, max: 0};
      entry.n++; entry.ms += ms; entry.max = Math.max(entry.max, ms); actionStats.set(name, entry);
    }
  };
}
const service = new DeletionService(storage, new ActiveHolders(), new ManagedFiles(userData));
const cleanup = new SupersededHistoryCleanup(storage, ownerId, service, {maxBatches});
const started = performance.now();
let blocked = 0, batches = 0;
try {
  // 先续跑账本里未结案的清理操作，再按名单逐位清理。
  const pending = await storage.execute('history.supersededPending', {ownerId});
  const contacts = migrated ? plan.map(p => p.contactId) : [...wanted];
  for (const contactId of [...new Set([...pending.operations.map(op => op.contactId), ...contacts])]) {
    const t0 = performance.now();
    const result = await cleanup.run(contactId);
    batches += result.batches;
    if (result.blocked) blocked++;
    if (actionStats.size) {
      console.log(`动作耗时：${[...actionStats].map(([name, e]) => `${name}×${e.n}=${(e.ms / 1000).toFixed(1)}s(最大 ${(e.max / 1000).toFixed(1)}s)`).join(' ')}`);
    }
    console.log(`${contactId.slice(0, 8)}：批次 ${result.batches}，${result.blocked ? `未结案（${result.reason}）` : result.reason ? `停止（${result.reason}）` : '已清完'}，用时 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
  }
} finally {
  const check = await storage.check().catch(error => ({error: error.code ?? String(error)}));
  console.log(`合计：批次 ${batches}，未结案联系人 ${blocked}，用时 ${((performance.now() - started) / 1000).toFixed(1)} 秒；库校验 ${JSON.stringify(check)}`);
  await cleanup.close();
  await storage.close().catch(() => {});
}
process.exit(blocked ? 1 : 0);
