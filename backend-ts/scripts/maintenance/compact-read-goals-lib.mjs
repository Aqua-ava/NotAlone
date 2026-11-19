/**
 * 读取目标排空的可测试部分（占用检测、磁盘与备份、逐联系人逐批排空）。命令行入口见 compact-read-goals.mjs。
 * 所有外部效应（lsof、磁盘、复制）可注入，便于在合成环境验证“备份失败则中止”等行为。
 */
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {chmodSync, copyFileSync, createReadStream, existsSync, mkdirSync, rmSync, statSync, statfsSync} from 'node:fs';
import {basename, dirname, join, sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export class MaintenanceRefusal extends Error {}
const refuse = message => { throw new MaintenanceRefusal(message); };

export const databaseSidecars = dbPath => [dbPath, `${dbPath}-wal`];

/** 没有任何进程持有数据库及其 WAL/SHM：lsof 无匹配时退出码为 1。 */
export function assertDatabaseIdle(dbPath, {exec = execFileSync} = {}) {
  const holders = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].filter(existsSync).flatMap(file => {
    try { return exec('lsof', ['-t', '--', file], {encoding: 'utf8'}).split('\n').filter(Boolean); }
    catch (error) { if (error.status === 1) return []; throw error; }
  });
  if (holders.length) refuse(`数据库仍被进程持有（${[...new Set(holders)].join(',')}），请先完全退出 App 与后台`);
}

/** 备份目录所在卷需放得下库文件与 WAL，另留余量给排空期间 WAL 增长（secure_delete 会覆写被删页）。 */
export function requiredBackupBytes(dbPath) {
  const bytes = databaseSidecars(dbPath).filter(existsSync).reduce((sum, file) => sum + statSync(file).size, 0);
  return {bytes, required: bytes + Math.max(512 * 1024 * 1024, Math.ceil(bytes * 0.1))};
}
export function assertDiskSpace(dbPath, backupDir, {statfs = statfsSync} = {}) {
  const {bytes, required} = requiredBackupBytes(dbPath);
  // 备份目录尚不存在时，取最近的已存在祖先目录所在的卷。
  let probe = backupDir;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  let info;
  try { info = statfs(probe); } catch (error) { refuse(`无法读取备份目录所在磁盘空间：${error.code ?? error.message}`); }
  const free = Number(info.bavail) * Number(info.bsize);
  if (free < required) refuse(`备份目录所在磁盘可用 ${(free / 1048576).toFixed(0)}MB，不足所需 ${(required / 1048576).toFixed(0)}MB（库＋WAL ${(bytes / 1048576).toFixed(0)}MB 及余量）`);
  return {free, required, bytes};
}
export function assertBackupDirSafe(userData, backupDir) {
  if (!backupDir.startsWith('/')) refuse('--backup-dir 必须是绝对路径');
  if (`${backupDir}${sep}`.startsWith(`${join(userData, 'managed')}${sep}`)) refuse('备份目录不能位于 managed/ 内');
}

const sha256 = file => new Promise((resolve, reject) => {
  const hash = createHash('sha256');
  createReadStream(file).on('data', chunk => hash.update(chunk)).on('error', reject).on('end', () => resolve(hash.digest('hex')));
});

/** 复制库文件与 WAL 并逐个核对大小与 SHA-256；任何一步失败就删除本次已复制的文件并抛错，调用方必须中止。 */
export async function backupDatabase(dbPath, backupDir, {copy = copyFileSync} = {}) {
  if (existsSync(backupDir) && statSync(backupDir).isDirectory() && existsSync(join(backupDir, basename(dbPath)))) refuse('备份目录已存在同名备份，拒绝覆盖');
  mkdirSync(backupDir, {recursive: true, mode: 0o700});
  const made = [];
  try {
    const manifest = [];
    for (const source of databaseSidecars(dbPath).filter(existsSync)) {
      const target = join(backupDir, basename(source));
      copy(source, target, 1 /* COPYFILE_EXCL：不覆盖已有文件 */);
      made.push(target);
      try { chmodSync(target, 0o600); } catch { /* 权限收紧失败不影响备份可用性 */ }
      const [a, b] = [statSync(source).size, statSync(target).size];
      if (a !== b) throw new Error(`备份大小不一致：${basename(source)} ${a} != ${b}`);
      const [hashSource, hashTarget] = [await sha256(source), await sha256(target)];
      if (hashSource !== hashTarget) throw new Error(`备份校验失败：${basename(source)}`);
      manifest.push({file: basename(source), bytes: a, sha256: hashTarget});
    }
    return {dir: backupDir, manifest};
  } catch (error) {
    for (const file of made) rmSync(file, {force: true});
    throw new MaintenanceRefusal(`备份失败，已中止且未打开存储：${error.message}`);
  }
}

/** 静态库只读取实例身份与本人 ID：immutable 只读，不创建 WAL/SHM。 */
export function readIdentity(dbPath) {
  const db = new DatabaseSync(`file:${dbPath}?mode=ro&immutable=1`, {readOnly: true});
  try {
    return {
      databaseId: String(db.prepare('SELECT database_id FROM database_instance').get()?.database_id ?? ''),
      role: String(db.prepare('SELECT role FROM database_instance').get()?.role ?? ''),
      ownerId: String(db.prepare('SELECT owner_id FROM owner').get()?.owner_id ?? ''),
      schemaVersion: Number(db.prepare('SELECT max(version) v FROM schema_migration').get()?.v ?? 0),
    };
  } finally { db.close(); }
}

/**
 * 逐联系人：先试算（保存点内推演后回滚），再按需逐批实际排空。每批是一次独立事务，中断后重跑自然续做。
 * shouldStop 在每批之间检查；事件只含联系人 ID 前 8 位与计数。
 */
export async function compactAll({storage, ownerId, execute, batch = 200, shouldStop = () => false, onEvent = () => {}}) {
  const contacts = await storage.execute('history.checkpointContacts', {ownerId});
  const summary = {contacts: contacts.length, projected: 0, deleted: 0, batches: 0, skipped: [], interrupted: false, perContact: []};
  for (const {contactId} of contacts) {
    if (shouldStop()) { summary.interrupted = true; break; }
    const label = contactId.slice(0, 8);
    const dry = await storage.execute('history.compactGoals', {ownerId, contactId, dryRun: true, limit: batch});
    if (dry.skipped) { summary.skipped.push({contact: label, reason: dry.skipped}); onEvent({kind: 'skip', contact: label, reason: dry.skipped}); continue; }
    const entry = {contact: label, projected: dry.projectedTotal, projectedBatches: dry.projectedBatches, truncated: dry.projectedTruncated, deleted: 0, batches: 0};
    summary.projected += dry.projectedTotal;
    onEvent({kind: 'dry-run', ...entry});
    if (execute) {
      for (;;) {
        if (shouldStop()) { summary.interrupted = true; break; }
        const result = await storage.execute('history.compactGoals', {ownerId, contactId, dryRun: false, limit: batch});
        if (result.skipped) { summary.skipped.push({contact: label, reason: result.skipped}); onEvent({kind: 'skip', contact: label, reason: result.skipped}); break; }
        if (!result.deleted) break;
        entry.deleted += result.deleted; entry.batches++; summary.deleted += result.deleted; summary.batches++;
        onEvent({kind: 'batch', contact: label, deleted: result.deleted, total: entry.deleted});
      }
    }
    summary.perContact.push(entry);
    if (summary.interrupted) break;
  }
  return summary;
}
