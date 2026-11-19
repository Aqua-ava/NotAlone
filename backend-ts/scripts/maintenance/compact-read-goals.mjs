#!/usr/bin/env node
/**
 * 读取目标排空（离线维护工具，不进入产品启动，不是 App 的后台能力，也没有 IPC／HTTP／界面入口）。
 *
 * 作用：删除已被取代、无任何 capture_record、不被恢复操作引用的 read_goal 及其空 sync_capture 页，
 * 规则与应用创建新目标时顺带清理（goal-retention.ts）完全一致：保留每联系人／类型／范围最新一行、续读基线、
 * 最新增量的直接前驱、宽限期内与带记录的目标。不改 schema，不做 VACUUM（文件不会因此变小，
 * 空闲页留在库内供后续复用；回收文件体积需另行维护）。
 *
 * 安全边界：
 *  - 默认只试算（dry-run）；必须显式 --execute 才删除。
 *  - 只能在 App 与后台完全退出后运行；用 lsof 确认没有进程持有数据库及其 WAL/SHM，否则拒绝。
 *  - 打开存储本身会写库（推进实例代次，必要时执行待应用迁移），所以无论试算还是执行，
 *    都先检查磁盘空间并强制复制库文件与 WAL 备份（逐个核对大小与 SHA-256）；备份失败即中止，不打开存储。
 *  - 每联系人每批最多 200 个目标，每批独立提交；Ctrl-C 在当前批结束后停止，重跑自然续做、幂等。
 *  - 跳过正在删除的联系人／账号；带记录的目标永不删除。
 *  - 只输出联系人 ID 前 8 位与计数，不输出名称、正文或目标内容。
 *
 * 用法（在 backend-ts/，App 已退出）：
 *   node scripts/maintenance/compact-read-goals.mjs --user-data="$HOME/Library/Application Support/NotAloneDesktop"
 *   node scripts/maintenance/compact-read-goals.mjs --user-data=<同上> --execute
 * 可选：--backup-dir=<绝对路径，不得在 managed/ 内>  --batch=<1..200>  --no-warmup
 * 退出码：0 完成；1 出错或有联系人未处理；2 拒绝（占用／磁盘／备份／参数）；130 被中断（已处理的批已提交）。
 */
import {existsSync, realpathSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {SqliteStorage} from '../../src/storage/sqlite/client.ts';
import {MaintenanceRefusal, assertBackupDirSafe, assertDatabaseIdle, assertDiskSpace, backupDatabase, compactAll, readIdentity} from './compact-read-goals-lib.mjs';

const args = new Map(process.argv.slice(2).map(arg => { const [key, value = 'true'] = arg.replace(/^--/, '').split('='); return [key, value]; }));
const refuseExit = message => { console.error(`拒绝：${message}`); process.exit(2); };
const seconds = ms => (ms / 1000).toFixed(1);
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');

const userDataArg = args.get('user-data');
if (!userDataArg || !userDataArg.startsWith('/')) refuseExit('--user-data 必须是绝对路径');
const userData = realpathSync(userDataArg);
const dbPath = join(userData, 'managed/sqlite/notalone.sqlite');
if (!existsSync(dbPath)) refuseExit('找不到 managed/sqlite/notalone.sqlite');
const batch = Number(args.get('batch') ?? 200);
if (!Number.isSafeInteger(batch) || batch < 1 || batch > 200) refuseExit('--batch 必须是 1 到 200 的整数');
const execute = args.has('execute');
const backupDir = args.get('backup-dir') ?? join(userData, 'maintenance-backups', `read-goal-compaction-${stamp()}`);

let identity, backup;
try {
  assertDatabaseIdle(dbPath);
  assertBackupDirSafe(userData, backupDir);
  const disk = assertDiskSpace(dbPath, backupDir);
  console.log(`模式：${execute ? '执行（--execute）' : '试算（dry-run，不删除任何行）'}；库＋WAL ${(disk.bytes / 1048576).toFixed(0)}MB，备份目录可用 ${(disk.free / 1048576).toFixed(0)}MB`);
  identity = readIdentity(dbPath);
  if (!identity.databaseId || !identity.ownerId || !['test', 'business'].includes(identity.role)) refuseExit('无法读取实例身份');
  const t = performance.now();
  backup = await backupDatabase(dbPath, backupDir);
  console.log(`已备份到 ${backup.dir}（${backup.manifest.map(m => `${m.file} ${(m.bytes / 1048576).toFixed(0)}MB sha256:${m.sha256.slice(0, 12)}`).join('；')}），用时 ${seconds(performance.now() - t)} 秒`);
} catch (error) {
  if (error instanceof MaintenanceRefusal) refuseExit(error.message);
  throw error;
}

if (!args.has('no-warmup')) execFileSync('dd', [`if=${dbPath}`, 'of=/dev/null', 'bs=8m'], {stdio: 'ignore'});
const openStarted = performance.now();
// 单批动作与试算可能超过产品的 15 秒预算；离线工具无并发读者，放宽到 15 分钟。
const storage = await SqliteStorage.open({userData, intent: 'open', expectedDatabaseId: identity.databaseId, role: identity.role, actionTimeoutMs: 15 * 60_000});
console.log(`已打开存储（schema ${identity.schemaVersion} → ${storage.status.schemaVersion}），用时 ${seconds(performance.now() - openStarted)} 秒`);

let stopRequested = false;
process.on('SIGINT', () => { stopRequested = true; console.log('收到中断：当前批结束后停止（已提交的批保留，可重跑续做）'); });
const started = performance.now();
let summary;
try {
  summary = await compactAll({
    storage, ownerId: identity.ownerId, execute, batch, shouldStop: () => stopRequested,
    onEvent: event => {
      if (event.kind === 'dry-run') console.log(`联系人 ${event.contact}：可清理 ${event.projected}（约 ${event.projectedBatches} 批${event.truncated ? '，试算已截断' : ''}）`);
      else if (event.kind === 'skip') console.log(`联系人 ${event.contact}：跳过（${event.reason}）`);
      else if (event.kind === 'batch' && event.total % 1000 < event.deleted) console.log(`  联系人 ${event.contact}：已删除 ${event.total}`);
    },
  });
} finally {
  if (storage.failureDiagnostic) console.log(`存储失败诊断：${JSON.stringify(storage.failureDiagnostic)}`);
}
const check = await storage.check().catch(error => ({error: error.code ?? String(error)}));
await storage.close().catch(() => {});
console.log(`合计：联系人 ${summary.contacts}，试算可清理 ${summary.projected}，${execute ? `已删除 ${summary.deleted}（${summary.batches} 批）` : '未删除（dry-run）'}，跳过 ${summary.skipped.length}，用时 ${seconds(performance.now() - started)} 秒；库校验 ${JSON.stringify(check)}`);
if (execute) console.log('提示：本工具不做 VACUUM，文件体积不会立即变小；回收需另行维护。备份保留在上面的目录，确认无误后可自行删除。');
process.exit(summary.interrupted ? 130 : summary.skipped.length ? 1 : 0);
