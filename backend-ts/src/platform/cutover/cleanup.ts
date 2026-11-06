/** 已确认归属对象的精确清理；未知归属、符号链接或结构变化一律失败并保留现场。 */
import { closeSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, unlinkSync, mkdirSync, rmdirSync, constants } from 'node:fs';
import { sha256 } from '../../platform/sha256.ts';
import path from 'node:path';
import type { LegacyTarget } from './contracts.ts';

export class CutoverCleanupError extends Error {
  readonly code = 'cutover_cleanup_failed';
  readonly detail: string;
  constructor(detail: string) { super(detail); this.name = 'CutoverCleanupError'; this.detail = detail; }
}
function entry(location: string) {
  try { return lstatSync(location, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function assertPrivateFile(location: string): void {
  const value = entry(location);
  if (!value) throw new CutoverCleanupError('target_missing');
  if (value.isSymbolicLink() || !value.isFile() || value.uid !== BigInt(process.getuid!()) || value.nlink !== 1n || (value.mode & 0o077n) !== 0n) throw new CutoverCleanupError('unsafe_target_state');
}
function assertPrivateDirectory(location: string): void {
  const value = entry(location);
  if (!value) throw new CutoverCleanupError('target_missing');
  if (value.isSymbolicLink() || !value.isDirectory() || value.uid !== BigInt(process.getuid!()) || (value.mode & 0o077n) !== 0n) throw new CutoverCleanupError('unsafe_target_state');
}
/** 只接受私有普通文件/目录组成、无符号链接的完整树。 */
function verifyTree(location: string, depth = 0): void {
  if (depth > 16) throw new CutoverCleanupError('target_tree_too_deep');
  const value = entry(location);
  if (!value) return;
  if (value.isSymbolicLink() || value.uid !== BigInt(process.getuid!()) || (value.mode & 0o077n) !== 0n) throw new CutoverCleanupError('unsafe_target_tree');
  if (value.isDirectory()) {
    for (const name of readdirSync(location)) verifyTree(path.join(location, name), depth + 1);
  } else if (!value.isFile() || value.nlink !== 1n) throw new CutoverCleanupError('unsafe_target_tree');
}
function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function removeTree(location: string): void {
  verifyTree(location);
  const parent = path.dirname(location);
  const remove = (current: string): void => {
    const value = entry(current);
    if (!value) return;
    if (value.isDirectory()) { for (const name of readdirSync(current)) remove(path.join(current, name)); rmdirSync(current); }
    else unlinkSync(current);
  };
  remove(location);
  if (entry(location) !== undefined) throw new CutoverCleanupError('target_still_present');
  fsyncDirectory(parent);
}
function unlinkFile(location: string): void {
  assertPrivateFile(location);
  unlinkSync(location);
  if (entry(location) !== undefined) throw new CutoverCleanupError('target_still_present');
  fsyncDirectory(path.dirname(location));
}
function verifyHash(location: string): string {
  assertPrivateFile(location);
  const value = lstatSync(location, { bigint: true });
  if (value.size > 64n * 1024n * 1024n) throw new CutoverCleanupError('archive_too_large');
  return sha256(readFileSync(location));
}

/** 执行一个已授权且归属确认的目标清理；返回非敏感明细。 */
export function cleanLegacyTarget(userData: string, target: LegacyTarget): string {
  const location = path.join(userData, ...target.locator.split('/'));
  const relative = path.relative(userData, location);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new CutoverCleanupError('target_outside_user_data');
  switch (target.kind) {
    case 'legacy_import_pending':
      unlinkFile(location); return 'removed_legacy_control_file';
    case 'legacy_writer_handshake': case 'legacy_launch_lock': case 'runtime_handshake': case 'runtime_launch_lock':
      unlinkFile(location); return 'removed_stale_runtime_handshake';
    case 'legacy_update_backup': {
      const hash = verifyHash(location); unlinkFile(location); return `removed_archive_payload:${hash.slice(0, 12)}`;
    }
    case 'legacy_assistant_runtime': removeTree(location); return 'removed_managed_session_copies';
    default: throw new CutoverCleanupError('target_kind_unavailable');
  }
}

/** 在受管 userData 内新建 Skill 根目录（空库默认加载根）；不复制、不读取旧 Skill。 */
export function ensureSkillRoot(userData: string, root: string): void {
  const relative = path.relative(userData, root);
  if (!path.isAbsolute(root) || !relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new CutoverCleanupError('skill_root_outside_user_data');
  try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  assertPrivateDirectory(root);
}
export const cleanupInternals = { verifyTree, fsyncDirectory };
