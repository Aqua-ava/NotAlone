import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SqliteStorage } from '../../../src/storage/sqlite/client.ts';
import { loadManifest, saveManifest } from '../../../src/platform/cutover/control.ts';
import { checkRuntimeWriters } from '../../../src/platform/cutover/targets.ts';
import { runDatabaseStartup } from '../../../src/platform/cutover/startup.ts';

/**
 * 测试夹具：首次创建与阻断恢复走正式 runDatabaseStartup；完成态再按真实宿主的方式正式打开数据库，
 * 核验本人身份并返回 ready/sqlite_reopened。生产启动器只准备不打开，因此该重开校验只存在于测试。
 */
export async function runDefaultDatabaseStartup(options) {
  const prepared = await runDatabaseStartup(options);
  if (prepared.phase !== 'prepared') return prepared;
  const userData = path.resolve(options.userData);
  const maintenance = (code, detail) => ({ phase: 'maintenance', code, detail, manifestRevision: prepared.manifestRevision });
  const live = checkRuntimeWriters(userData).filter(record => record.state !== 'stopped');
  if (live.length) return maintenance('cutover_legacy_writer_running', live.map(record => `${record.name}:${record.state}`).join(','));
  const factory = options.storageFactory ?? { open: openOptions => SqliteStorage.open(openOptions) };
  let storage;
  try {
    storage = await factory.open({ userData, intent: 'open', expectedDatabaseId: prepared.databaseId, role: 'test' });
    const ownerId = await storage.execute('identity.resolveOwner', { proposedOwnerId: randomUUID(), expectedOwnerId: prepared.ownerId, at: Date.now() });
    if (ownerId !== prepared.ownerId) return maintenance('cutover_checks_failed', 'target_owner_mismatch');
    return { phase: 'ready', code: 'sqlite_reopened', databaseId: storage.status.databaseId, ownerId, schemaVersion: storage.status.schemaVersion,
      sqliteVersion: storage.status.sqliteVersion, created: false, configuration: prepared.configuration, manifestRevision: prepared.manifestRevision };
  } catch (error) {
    let manifestRevision = prepared.manifestRevision;
    try { manifestRevision = saveManifest(userData, { ...loadManifest(userData), phase: 'blocked', blockedCode: 'cutover_storage_failed' }).revision; } catch { /* 无法持久化时保留现场。 */ }
    return { phase: 'maintenance', code: 'cutover_storage_failed', detail: String(error?.code ?? 'startup_failed'), manifestRevision };
  } finally { await storage?.close().catch(() => {}); }
}
