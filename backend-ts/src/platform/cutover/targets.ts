/** 旧目标识别：只把结构可证明归属的 userData 内对象标为 confirmed；其余保持 unknown 并阻断切换。 */
import { constants } from 'node:fs';
import { lstatSync, openSync, closeSync, readSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { LegacyTarget, LegacyTargetKind, Ownership, WriterCheckRecord } from './contracts.ts';

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const identifiers = /^[a-zA-Z0-9_-]{1,128}$/;
export class LegacyTargetError extends Error {
  readonly code = 'cutover_legacy_target_unclassified';
  readonly detail: string;
  constructor(detail: string) { super(detail); this.name = 'LegacyTargetError'; this.detail = detail; }
}

function item(location: string) {
  try { return lstatSync(location, { bigint: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
}
function privateStat(location: string, kind: 'file' | 'directory') {
  const entry = item(location);
  if (!entry) return undefined;
  if (entry.isSymbolicLink() || (kind === 'file' ? !entry.isFile() : !entry.isDirectory())
    || entry.uid !== BigInt(process.getuid!()) || (entry.mode & 0o077n) !== 0n || (kind === 'file' && entry.nlink !== 1n)) return 'unsafe' as const;
  return entry;
}
/** 只读取证明归属所需的最小字节；调用方不得记录返回内容。 */
function privateText(location: string, limit: number): string | undefined {
  const entry = privateStat(location, 'file');
  if (!entry) return undefined;
  if (entry === 'unsafe' || entry.size > BigInt(limit)) throw new LegacyTargetError('private_file_state');
  const fd = openSync(location, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(limit + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = readSync(fd, buffer, count, buffer.length - count, null);
      if (!read) break;
      count += read;
    }
    if (count > limit) throw new LegacyTargetError('private_file_state');
    return buffer.subarray(0, count).toString('utf8');
  } finally { closeSync(fd); }
}
export function targetId(kind: LegacyTargetKind, locator: string): string {
  return createHash('sha256').update(`${kind}:${locator}`).digest('hex').slice(0, 32);
}
function target(kind: LegacyTargetKind, locator: string, ownership: Ownership, evidence: string): LegacyTarget {
  return { id: targetId(kind, locator), kind, locator, ownership, evidence, state: 'pending', attempts: 0 };
}
function relative(userData: string, location: string): string | undefined {
  const value = path.relative(userData, location);
  if (!value || value.startsWith('..') || path.isAbsolute(value)) return undefined;
  return value.split(path.sep).join('/');
}

function updateBackups(userData: string): LegacyTarget[] {
  const root = path.join(userData, 'managed/updates');
  const entry = privateStat(root, 'directory');
  if (!entry) return [];
  const result: LegacyTarget[] = [];
  if (entry === 'unsafe') return [target('legacy_update_backup', 'managed/updates', 'unknown', 'unsafe_directory_state')];
  const names = readdirSync(root).sort();
  if (names.length > 1024) return [target('legacy_update_backup', 'managed/updates', 'unknown', 'unexpected_entry_count')];
  for (const name of names) {
    if (name === '恢复说明.txt') continue;
    if (!UUID.test(name)) return [target('legacy_update_backup', 'managed/updates', 'unknown', 'unexpected_entry_name')];
    const directory = path.join(root, name);
    if (privateStat(directory, 'directory') !== undefined && privateStat(directory, 'directory') !== 'unsafe') {
      const files = readdirSync(directory).sort();
      if (files.some(file => !['checkpoint.json', 'database.dump', 'legacy-launch.json', 'retired-launch.json', 'verification.json'].includes(file))) {
        result.push(target('legacy_update_backup', `managed/updates/${name}`, 'unknown', 'unexpected_archive_files'));
        continue;
      }
      const ownership: Ownership = ['database.dump', 'legacy-launch.json', 'retired-launch.json'].some(file => files.includes(file)) ? 'confirmed' : 'unknown';
      for (const file of files) {
        if (!['database.dump', 'legacy-launch.json', 'retired-launch.json'].includes(file)) continue;
        const locator = relative(userData, path.join(directory, file));
        if (locator) result.push(target('legacy_update_backup', locator, ownership, 'managed_update_archive'));
      }
    } else {
      const locator = relative(userData, directory);
      if (locator) result.push(target('legacy_update_backup', locator, 'unknown', 'unsafe_archive_directory'));
    }
  }
  return result;
}
function assistantRuntime(userData: string): LegacyTarget[] {
  const root = path.join(userData, 'assistant-runtime');
  const entry = privateStat(root, 'directory');
  if (!entry) return [];
  if (entry === 'unsafe') return [target('legacy_assistant_runtime', 'assistant-runtime', 'unknown', 'unsafe_directory_state')];
  const names = readdirSync(root).sort();
  if (names.length > 4096) return [target('legacy_assistant_runtime', 'assistant-runtime', 'unknown', 'unexpected_entry_count')];
  for (const owner of names) {
    if (!UUID.test(owner)) return [target('legacy_assistant_runtime', 'assistant-runtime', 'unknown', 'unexpected_owner_entry')];
    const ownerDirectory = path.join(root, owner);
    if (privateStat(ownerDirectory, 'directory') !== undefined && privateStat(ownerDirectory, 'directory') !== 'unsafe') {
      for (const contact of readdirSync(ownerDirectory)) {
        if (!UUID.test(contact)) return [target('legacy_assistant_runtime', 'assistant-runtime', 'unknown', 'unexpected_contact_entry')];
        const contactDirectory = path.join(ownerDirectory, contact);
        if (privateStat(contactDirectory, 'directory') !== undefined && privateStat(contactDirectory, 'directory') !== 'unsafe') {
          for (const session of readdirSync(contactDirectory)) {
            if (!UUID.test(session)) return [target('legacy_assistant_runtime', 'assistant-runtime', 'unknown', 'unexpected_session_entry')];
          }
        }
      }
    }
  }
  return [target('legacy_assistant_runtime', 'assistant-runtime', 'confirmed', 'managed_session_tree')];
}
function importPending(userData: string): LegacyTarget[] {
  const location = path.join(userData, 'managed/import-pending.json');
  const entry = privateStat(location, 'file');
  if (!entry) return [];
  if (entry === 'unsafe') return [target('legacy_import_pending', 'managed/import-pending.json', 'unknown', 'unsafe_file_state')];
  let shape: unknown;
  try { shape = JSON.parse(privateText(location, 256) ?? ''); } catch { shape = undefined; }
  return [target('legacy_import_pending', 'managed/import-pending.json', shape && typeof shape === 'object' ? 'confirmed' : 'unknown', 'legacy_import_marker')];
}
/** 当前存储目录只接受已知 SQLite 与通用维护产物；未知对象保留现场，不解析或代为清除。 */
export function unrecognizedManagedTargets(userData: string): LegacyTarget[] {
  const directory = path.join(userData, 'managed');
  const entry = privateStat(directory, 'directory');
  if (!entry) return [];
  if (entry === 'unsafe') return [target('legacy_unrecognized_managed', 'managed', 'unknown', 'unsafe_directory_state')];
  const names = readdirSync(directory).sort();
  if (names.length > 1024) return [target('legacy_unrecognized_managed', 'managed', 'unknown', 'unexpected_entry_count')];
  const supported = new Set(['sqlite', 'media', 'runtime-copies', 'cache', 'updates', 'import-pending.json', 'backend.info', 'backend.info.dsh-lock',
    'sqlite-backend.info', 'sqlite-backend.info.dsh-lock']);
  return names.filter(name => !supported.has(name)).map(name =>
    target('legacy_unrecognized_managed', `managed/${name}`, 'unknown', 'unsupported_managed_entry'));
}
function handshakeTargets(userData: string): LegacyTarget[] {
  const result: LegacyTarget[] = [];
  for (const locator of ['managed/backend.info', 'backend.info', 'managed/sqlite-backend.info']) {
    const location = path.join(userData, locator);
    const entry = privateStat(location, 'file');
    if (!entry) continue;
    if (entry === 'unsafe') { result.push(target('legacy_writer_handshake', locator, 'unknown', 'unsafe_file_state')); continue; }
    const kind: LegacyTargetKind = locator.includes('sqlite') ? 'runtime_handshake' : 'legacy_writer_handshake';
    result.push(target(kind, locator, 'confirmed', 'writer_handshake'));
  }
  for (const locator of ['managed/backend.info.dsh-lock', 'backend.info.dsh-lock', 'managed/sqlite-backend.info.dsh-lock']) {
    const location = path.join(userData, locator);
    const entry = privateStat(location, 'file');
    if (!entry) continue;
    if (entry === 'unsafe') { result.push(target('legacy_launch_lock', locator, 'unknown', 'unsafe_file_state')); continue; }
    const kind: LegacyTargetKind = locator.includes('sqlite') ? 'runtime_launch_lock' : 'legacy_launch_lock';
    result.push(target(kind, locator, 'confirmed', 'launcher_lock'));
  }
  return result;
}

/** 发现全部 userData 内可证明归属的旧对象；不读取正文，不跟随符号链接，不删除任何对象。 */
export function discoverLegacyTargets(userData: string): LegacyTarget[] {
  const found: LegacyTarget[] = [];
  found.push(...unrecognizedManagedTargets(userData), ...updateBackups(userData), ...assistantRuntime(userData),
    ...importPending(userData), ...handshakeTargets(userData));
  return found.sort((a, b) => a.id.localeCompare(b.id));
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
function handshakePid(userData: string, locator: string): number | undefined {
  try {
    const text = privateText(path.join(userData, locator), 4096);
    if (text === undefined) return undefined;
    const match = /^pid=([1-9][0-9]{0,9})$/m.exec(text);
    if (!match) throw new LegacyTargetError('handshake_shape');
    return Number(match[1]);
  } catch { return undefined; }
}
function lockPids(userData: string, locator: string): { parentPid?: number; childPid?: number } | undefined {
  try {
    const text = privateText(path.join(userData, locator), 4096);
    if (text === undefined) return undefined;
    const value = JSON.parse(text) as Record<string, unknown>;
    const pid = (raw: unknown) => typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0 ? raw : undefined;
    const parentPid = pid(value.parentPid), childPid = pid(value.childPid);
    if (parentPid === undefined && childPid === undefined) throw new LegacyTargetError('lock_shape');
    return { parentPid, childPid };
  } catch { return undefined; }
}
/** 只读取并判断旧写入者是否仍存活；绝不终止未知进程。 */
export function checkLegacyWriters(userData: string): WriterCheckRecord[] {
  const records: WriterCheckRecord[] = [];
  for (const locator of ['managed/backend.info', 'backend.info']) {
    if (item(path.join(userData, locator)) === undefined) continue;
    const pid = handshakePid(userData, locator);
    records.push({ name: 'legacy_app_handshake', locator, state: pid === undefined ? 'unknown' : pidAlive(pid) ? 'running' : 'stopped' });
  }
  for (const locator of ['managed/backend.info.dsh-lock', 'backend.info.dsh-lock', 'managed/sqlite-backend.info.dsh-lock']) {
    if (item(path.join(userData, locator)) === undefined) continue;
    const pids = lockPids(userData, locator);
    const state = pids === undefined ? 'unknown' : (pids.parentPid !== undefined && pidAlive(pids.parentPid)) || (pids.childPid !== undefined && pidAlive(pids.childPid)) ? 'running' : 'stopped';
    records.push({ name: locator.includes('sqlite') ? 'runtime_launch_lock' : 'legacy_launch_lock', locator, state });
  }
  const hostHandshake = path.join(userData, 'managed/sqlite-backend.info');
  if (item(hostHandshake) !== undefined) {
    const pid = (() => { try { const text = privateText(hostHandshake, 4096); const match = text === undefined ? null : /^pid=([1-9][0-9]{0,9})$/m.exec(text); return match ? Number(match[1]) : undefined; } catch { return undefined; } })();
    records.push({ name: 'new_host_handshake', locator: 'managed/sqlite-backend.info', state: pid === undefined ? 'unknown' : pidAlive(pid) ? 'running' : 'stopped' });
  }
  return records;
}

/** 供启动编排复用的路径核验：userData 必须是私有真实目录。 */
export function assertPrivateUserData(userData: string): void {
  if (!path.isAbsolute(userData)) throw new LegacyTargetError('user_data_not_absolute');
  const entry = item(userData);
  if (!entry || entry.isSymbolicLink() || !entry.isDirectory() || entry.uid !== BigInt(process.getuid!()) || (entry.mode & 0o022n) !== 0n) throw new LegacyTargetError('user_data_not_private');
}
export const targetChecksums = { identifiers, uuid: UUID };
