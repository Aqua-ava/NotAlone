#!/usr/bin/env node
/**
 * 批量删除联系人（离线维护工具，不进入产品启动，不是 App 的后台能力）。
 *
 * 复用 App 同一套统一删除服务（`DeletionService` 与 `installedDeletionRegistration`）：每位联系人
 * 照常计划、封禁、排空、逐目标清除、封存，但同一批只做一次全库压缩（VACUUM 加全库校验），
 * 压缩后再逐个核验结案。每个操作仍只在其最后一次清除之后开始的压缩通过后结案。
 *
 * 为什么需要它：压缩耗时随库体积增长，与联系人大小无关（3 GB 库约 45 秒）。App 逐个删除时每位联系人
 * 各付一次，删除数百位联系人以小时计；批量后每批只付一次。
 *
 * 安全边界：
 *  - 只能在 App 与后台完全退出后运行；脚本用 lsof 确认没有进程持有数据库文件，否则拒绝。
 *    打开存储会推进实例代次并撤销旧运行租约，不能与运行中的 App 并存。
 *  - 必须显式传 --confirm-delete=<联系人数>，且与名单数量一致；名单文件每行一个联系人 ID。
 *  - 只输出联系人 ID 前 8 位与耗时，不输出名称或正文。
 *  - 重复运行安全：请求键与 App 的联系人删除相同，已结案的操作原样返回。
 *
 * 用法（在 backend-ts/）：
 *   node scripts/maintenance/delete-contacts-batch.mjs --user-data=<绝对路径> --ids-file=<名单> \
 *     --confirm-delete=<数量> [--batch=20] [--timing] [--no-warmup]
 *
 * --timing 额外按存储动作汇总每批的次数、总耗时与最大单次耗时，用于定位慢批。
 */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, realpathSync} from 'node:fs';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {SqliteStorage} from '../../src/storage/sqlite/client.ts';
import {ActiveHolders} from '../../src/storage/sqlite/deletion/holders.ts';
import {DeletionService} from '../../src/storage/sqlite/deletion/service.ts';
import {ManagedFiles} from '../../src/storage/sqlite/deletion/managed-files.ts';

const args = new Map(process.argv.slice(2).map(arg => {
  const [key, value = 'true'] = arg.replace(/^--/, '').split('=');
  return [key, value];
}));
const fail = message => { console.error(`拒绝：${message}`); process.exit(2); };
const userDataArg = args.get('user-data');
if (!userDataArg || !userDataArg.startsWith('/')) fail('--user-data 必须是绝对路径');
const userData = realpathSync(userDataArg);
const dbPath = join(userData, 'managed/sqlite/notalone.sqlite');
if (!existsSync(dbPath)) fail('找不到 managed/sqlite/notalone.sqlite');
const idsFile = args.get('ids-file');
if (!idsFile) fail('缺少 --ids-file');
const ids = [...new Set(readFileSync(idsFile, 'utf8').split('\n').map(line => line.trim()).filter(Boolean))];
if (!ids.length || ids.some(id => !/^[a-zA-Z0-9_-]{1,128}$/.test(id))) fail('名单为空或含非法联系人 ID');
if (Number(args.get('confirm-delete')) !== ids.length) fail(`--confirm-delete 必须等于名单数量 ${ids.length}`);
const batchSize = Number(args.get('batch') ?? 20);
if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) fail('--batch 必须是 1 到 100 的整数');

// 没有任何进程持有数据库及其 WAL/SHM：lsof 无匹配时退出码为 1。
const holders = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync).flatMap(file => {
  try { return execFileSync('lsof', ['-t', '--', file], {encoding: 'utf8'}).split('\n').filter(Boolean); }
  catch (error) { if (error.status === 1) return []; throw error; }
});
if (holders.length) fail(`数据库仍被进程持有（${[...new Set(holders)].join(',')}），请先完全退出 App 与后台`);

// 静态库只读取实例身份与本人 ID：immutable 只读，不创建 WAL/SHM。
const sql = query => execFileSync('sqlite3', [`file:${dbPath}?mode=ro&immutable=1`, query], {encoding: 'utf8'}).trim();
const databaseId = sql('SELECT database_id FROM database_instance');
const role = sql('SELECT role FROM database_instance');
const ownerId = sql('SELECT owner_id FROM owner');
if (!databaseId || !ownerId || !['test', 'business'].includes(role)) fail('无法读取实例身份');

// 打开时存储会整库核验并可能执行待应用迁移，预算 60 秒；冷页缓存下读 3 GB 本身就可能用掉大半，先顺序读一遍预热。
if (!args.has('no-warmup')) execFileSync('dd', [`if=${dbPath}`, 'of=/dev/null', 'bs=8m'], {stdio: 'ignore'});
const openStarted = performance.now();
// 数十万目标的大联系人，单个计划／核验动作超过产品的 15 秒预算；离线工具无并发读者，放宽到 15 分钟。
const storage = await SqliteStorage.open({userData, intent: 'open', expectedDatabaseId: databaseId, role, actionTimeoutMs: 15 * 60_000});
console.log(`已打开存储（schema ${storage.status.schemaVersion}），用时 ${((performance.now() - openStarted) / 1000).toFixed(1)} 秒`);
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
const seconds = ms => (ms / 1000).toFixed(1);
const started = performance.now();
const tally = {completed: 0, other: 0};
try {
  for (let from = 0; from < ids.length; from += batchSize) {
    const slice = ids.slice(from, from + batchSize), t0 = performance.now();
    const planned = [];
    for (const contactId of slice) {
      const scope = {kind: 'contact', contactId};
      // 与 App 的联系人删除使用同一请求键，重复运行得到同一操作。
      const requestKey = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
      // 计划快照含全部目标（大联系人可达数十万个），只保留任务编号，避免一批 20 位联系人的快照撑爆堆内存。
      planned.push({ownerId, operationId: (await service.plan({ownerId, requestKey, scope})).operationId});
    }
    const t1 = performance.now();
    const results = await service.advanceBatch(planned);
    const done = results.filter(op => op.state === 'completed').length;
    tally.completed += done; tally.other += results.length - done;
    console.log(`批 ${from / batchSize + 1}/${Math.ceil(ids.length / batchSize)}：联系人 ${slice.length}，结案 ${done}，计划 ${seconds(t1 - t0)} 秒，清理与压缩核验 ${seconds(performance.now() - t1)} 秒`);
    if (actionStats.size) {
      console.log(`  动作耗时：${[...actionStats].map(([name, e]) => `${name.replace('deletion.', '')}×${e.n}=${seconds(e.ms)}s(最大 ${seconds(e.max)}s)`).join(' ')}`);
      actionStats.clear();
    }
    for (const [index, op] of results.entries()) if (op.state !== 'completed') {
      console.log(`  未结案 ${slice[index].slice(0, 8)} 状态=${op.state} 阻塞=${JSON.stringify(op.checks.filter(c => c.result.result === 'blocked').map(c => c.result.proof))}`);
    }
    if (results.length !== done) break;
  }
} finally {
  if (storage.failureDiagnostic) console.log(`存储失败诊断：${JSON.stringify(storage.failureDiagnostic)}`);
  const check = await storage.check().catch(error => ({error: error.code ?? String(error)}));
  console.log(`合计：结案 ${tally.completed}，未结案 ${tally.other}，用时 ${seconds(performance.now() - started)} 秒；库校验 ${JSON.stringify(check)}`);
  await storage.close().catch(() => {});
}
process.exit(tally.other ? 1 : 0);
