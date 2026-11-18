/** 本应用自身运行产物（SQLite 宿主握手与启动锁）的精确清理；符号链接、非私有文件或结构变化一律失败并保留现场。 */
import { closeSync, fsyncSync, lstatSync, openSync, unlinkSync, mkdirSync, constants } from 'node:fs';
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
function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function unlinkFile(location: string): void {
  assertPrivateFile(location);
  unlinkSync(location);
  if (entry(location) !== undefined) throw new CutoverCleanupError('target_still_present');
  fsyncDirectory(path.dirname(location));
}

/** 清理一个已停写核验的运行产物；返回非敏感明细。其他目标类型一律拒绝。 */
export function cleanRuntimeTarget(userData: string, target: LegacyTarget): string {
  if (target.kind !== 'runtime_handshake' && target.kind !== 'runtime_launch_lock') throw new CutoverCleanupError('target_kind_unavailable');
  const location = path.join(userData, ...target.locator.split('/'));
  const relative = path.relative(userData, location);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new CutoverCleanupError('target_outside_user_data');
  unlinkFile(location);
  return 'removed_stale_runtime_handshake';
}

/** 在受管 userData 内新建 Skill 根目录（空库默认加载根）；不复制、不读取旧 Skill。 */
export function ensureSkillRoot(userData: string, root: string): void {
  const relative = path.relative(userData, root);
  if (!path.isAbsolute(root) || !relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new CutoverCleanupError('skill_root_outside_user_data');
  try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  assertPrivateDirectory(root);
}
