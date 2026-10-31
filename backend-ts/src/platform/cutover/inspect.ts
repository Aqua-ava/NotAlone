/** 切换目标的结构与存储面只读快照；只暴露计数与固定表名，不返回正文或文件内容。 */
import type { StorageAction } from '../../storage/sqlite/contracts.ts';
import { EXPECTED_TABLES } from './structure.ts';

function count(tx: { get(sql: string): unknown }, table: string, where = ''): number {
  const row = tx.get(`SELECT COUNT(*) AS n FROM ${table}${where}`) as { n?: unknown } | undefined;
  return Number(row?.n ?? 0);
}
function ownerIdOf(tx: { get(sql: string, values?: unknown[]): unknown }, input: unknown): string {
  const ownerId = (input as { ownerId?: unknown })?.ownerId;
  if (typeof ownerId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(ownerId)) throw new Error('cutover_owner_invalid');
  if (!tx.get('SELECT 1 FROM owner WHERE owner_id=?', [ownerId])) throw new Error('cutover_owner_missing');
  return ownerId;
}

export const cutoverActions: StorageAction[] = [{
  name: 'cutover.snapshot', mode: 'read', retryBusy: false,
  execute(tx, input) {
    const ownerId = ownerIdOf(tx, input);
    const tables = (tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*'") as Array<{ name: unknown }>)
      .map(row => String(row.name)).sort();
    const missing = EXPECTED_TABLES.filter(table => !tables.includes(table));
    const unauthorized = tables.filter(table => !EXPECTED_TABLES.includes(table));
    return {
      ownerId,
      tables,
      missingTables: missing,
      unexpectedTables: unauthorized,
      media: {
        message_media: count(tx, 'message_media', " WHERE state IN ('active','clearing')"),
        current_files: count(tx, 'media_file', " WHERE publish_state='current' AND content_state='present'"),
        staged_files: count(tx, 'media_file', " WHERE publish_state='staged'"),
        cleanup_pending: count(tx, 'media_file', " WHERE publish_state='cleanup_pending'"),
        attempts_running: count(tx, 'media_extraction_attempt', " WHERE state IN ('pending','running')"),
      },
      skills: {
        packages: count(tx, 'skill_package'),
        revisions: count(tx, 'skill_package_revision'),
        enabled: count(tx, 'skill_package', " WHERE enabled_state='enabled' OR default_enabled=1"),
        unknown: count(tx, 'skill_package', " WHERE enabled_state='unknown' AND default_enabled=0"),
      },
      deletions: {
        running_operations: count(tx, 'deletion_operation', " WHERE state NOT IN ('completed')"),
        pending_targets: count(tx, 'deletion_target', " WHERE state IN ('pending','cleaning','failed')"),
      },
      runtime: {
        copies: count(tx, 'runtime_copy'),
        files: count(tx, 'runtime_file'),
      },
      counts: { owners: count(tx, 'owner'), contacts: count(tx, 'contact'), messages: count(tx, 'message') },
    };
  },
}];
