/** 控制面持久化：只在 userData 的 database-cutover 目录内读写，不放在待删除目标里。 */
import { constants } from 'node:fs';
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SqliteCapabilitiesConfiguration } from '../../sqlite-capabilities.ts';
import { CUTOVER_AUTHORIZATION, CUTOVER_DIRECTORY, CUTOVER_FORMAT_VERSION, CUTOVER_MANIFEST, CUTOVER_STARTUP_CONFIG,
  type CutoverAuthorization, type CutoverManifest } from './contracts.ts';

const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_AUTHORIZATION_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 8 * 1024;

export class CutoverControlError extends Error {
  readonly code: 'cutover_manifest_invalid' | 'cutover_authorization_invalid' | 'cutover_configuration_conflict' | 'cutover_storage_failed';
  constructor(code: CutoverControlError['code']) { super(code); this.code = code; this.name = 'CutoverControlError'; }
}

function privateDirectory(location: string, create: boolean): void {
  if (create) mkdirSync(location, { mode: 0o700 });
  const entry = lstatSync(location);
  if (entry.isSymbolicLink() || !entry.isDirectory() || entry.uid !== process.getuid?.() || (entry.mode & 0o777) !== 0o700
    || path.resolve(location) !== path.join(path.resolve(path.dirname(location)), path.basename(location))) throw new CutoverControlError('cutover_manifest_invalid');
}

function privateFile(location: string): Buffer {
  const entry = lstatSync(location);
  if (entry.isSymbolicLink() || !entry.isFile() || entry.uid !== process.getuid?.() || entry.nlink !== 1 || (entry.mode & 0o777) !== 0o600) throw new CutoverControlError('cutover_manifest_invalid');
  return readFileSync(location);
}

function parseJson(buffer: Buffer, limit: number, code: CutoverControlError['code']): unknown {
  if (buffer.length > limit) throw new CutoverControlError(code);
  try { return JSON.parse(buffer.toString('utf8')); } catch { throw new CutoverControlError(code); }
}

function assertKeys(value: Record<string, unknown>, keys: readonly string[], code: CutoverControlError['code']): void {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new CutoverControlError(code);
}

function atomicWrite(location: string, content: string): void {
  const directory = path.dirname(location);
  const temporary = path.join(directory, `.${path.basename(location)}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeSync(fd, content);
    fsyncSync(fd);
    closeSync(fd); fd = undefined;
    renameSync(temporary, location);
    const parent = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  } catch (error) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* 已关闭。 */ } }
    try { unlinkSync(temporary); } catch { /* 文件可能尚未创建。 */ }
    throw error;
  }
}

export function cutoverDirectory(userData: string): string { return path.join(userData, CUTOVER_DIRECTORY); }
export function manifestPath(userData: string): string { return path.join(cutoverDirectory(userData), CUTOVER_MANIFEST); }
export function authorizationPath(userData: string): string { return path.join(cutoverDirectory(userData), CUTOVER_AUTHORIZATION); }
export function startupConfigPath(userData: string): string { return path.join(userData, CUTOVER_STARTUP_CONFIG); }
export function databaseFile(userData: string): string { return path.join(userData, 'managed/sqlite/notalone.sqlite'); }

export function ensureControlDirectory(userData: string): string {
  const directory = cutoverDirectory(userData);
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  privateDirectory(directory, false);
  return directory;
}

/** 读 manifests；文件不存在返回 undefined，内容不符合固定 schema 即拒绝。 */
export function loadManifest(userData: string): CutoverManifest | undefined {
  const directory = cutoverDirectory(userData);
  let value: unknown;
  try { privateDirectory(directory, false); value = parseJson(privateFile(manifestPath(userData)), MAX_MANIFEST_BYTES, 'cutover_manifest_invalid'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error instanceof CutoverControlError ? error : new CutoverControlError('cutover_manifest_invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CutoverControlError('cutover_manifest_invalid');
  const manifest = value as Record<string, unknown>;
  const required = ['formatVersion', 'revision', 'phase', 'createdAt', 'updatedAt', 'legacyTargets', 'writerChecks', 'checks', 'configPath'];
  const optional = ['blockedCode', 'target', 'targetOrigin', 'authorizationDigest', 'targetCreatePending'];
  if (Object.keys(manifest).some(key => !required.includes(key) && !optional.includes(key)) || required.some(key => !(key in manifest))) throw new CutoverControlError('cutover_manifest_invalid');
  if (manifest.formatVersion !== CUTOVER_FORMAT_VERSION || !Number.isSafeInteger(manifest.revision) || (manifest.revision as number) < 0
    || !Number.isSafeInteger(manifest.createdAt) || !Number.isSafeInteger(manifest.updatedAt)
    || !['identified', 'fenced', 'target_ready', 'cleaned', 'verified', 'switched', 'completed', 'blocked'].includes(manifest.phase as string)
    || !Array.isArray(manifest.legacyTargets) || !Array.isArray(manifest.writerChecks) || !Array.isArray(manifest.checks)
    || typeof manifest.configPath !== 'string') throw new CutoverControlError('cutover_manifest_invalid');
  if (manifest.target !== undefined) {
    const target = manifest.target;
    if (!target || typeof target !== 'object' || Array.isArray(target)) throw new CutoverControlError('cutover_manifest_invalid');
    const record = target as Record<string, unknown>;
    if (Object.keys(record).some(key => !['databaseFile', 'databaseId', 'ownerId', 'role'].includes(key))
      || typeof record.databaseFile !== 'string' || typeof record.databaseId !== 'string' || typeof record.ownerId !== 'string' || record.role !== 'test') throw new CutoverControlError('cutover_manifest_invalid');
  }
  if (manifest.targetOrigin !== undefined && !['created', 'adopted'].includes(manifest.targetOrigin as string)) throw new CutoverControlError('cutover_manifest_invalid');
  return manifest as unknown as CutoverManifest;
}

export function saveManifest(userData: string, manifest: CutoverManifest): CutoverManifest {
  ensureControlDirectory(userData);
  const next: CutoverManifest = { ...manifest, revision: manifest.revision + 1, updatedAt: Date.now() };
  atomicWrite(manifestPath(userData), `${JSON.stringify(next)}\n`);
  return next;
}

/** 读取并核验授权清单；目标 id 只允许固定形状，批准范围必须自证是合成或本地已确认。 */
export function loadAuthorization(userData: string): CutoverAuthorization | undefined {
  let value: unknown;
  try { value = parseJson(privateFile(authorizationPath(userData)), MAX_AUTHORIZATION_BYTES, 'cutover_authorization_invalid'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error instanceof CutoverControlError ? error : new CutoverControlError('cutover_authorization_invalid');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CutoverControlError('cutover_authorization_invalid');
  const authorization = value as Record<string, unknown>;
  assertKeys(authorization, ['formatVersion', 'approvedAt', 'scope', 'targets'], 'cutover_authorization_invalid');
  if (authorization.formatVersion !== 1 || !Number.isSafeInteger(authorization.approvedAt)
    || !['synthetic', 'confirmed_local'].includes(authorization.scope as string) || !Array.isArray(authorization.targets)) throw new CutoverControlError('cutover_authorization_invalid');
  const seen = new Set<string>();
  for (const entry of authorization.targets as unknown[]) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new CutoverControlError('cutover_authorization_invalid');
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some(key => !['id', 'disposition', 'retainReason'].includes(key)) || typeof record.id !== 'string' || !/^[a-f0-9]{16,64}$/.test(record.id)
      || !['clean', 'retain'].includes(record.disposition as string) || seen.has(record.id)) throw new CutoverControlError('cutover_authorization_invalid');
    if (record.disposition === 'retain' && (typeof record.retainReason !== 'string' || !record.retainReason || record.retainReason.length > 200)) throw new CutoverControlError('cutover_authorization_invalid');
    seen.add(record.id);
  }
  return authorization as unknown as CutoverAuthorization;
}

/** 授权清单摘要用于识别批准对象变化；不包含正文、密码或可恢复凭据。 */
export function authorizationDigest(authorization: CutoverAuthorization): string {
  const canonical = { formatVersion: authorization.formatVersion, approvedAt: authorization.approvedAt, scope: authorization.scope,
    targets: [...authorization.targets].sort((a, b) => a.id.localeCompare(b.id)) };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface StartupConfiguration extends SqliteCapabilitiesConfiguration { formatVersion: 1; intent: 'open'; role: 'test'; expectedDatabaseId: string }
/** 读取现有启动配置；只接受本应用写出的固定 schema，未知字段或角色一律拒绝。 */
export function loadStartupConfiguration(userData: string): StartupConfiguration | undefined {
  let buffer: Buffer;
  try { buffer = privateFile(startupConfigPath(userData)); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error instanceof CutoverControlError ? new CutoverControlError('cutover_configuration_conflict') : error;
  }
  const value = parseJson(buffer, MAX_CONFIG_BYTES, 'cutover_configuration_conflict');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CutoverControlError('cutover_configuration_conflict');
  const config = value as Record<string, unknown>;
  const allowed = ['formatVersion', 'intent', 'role', 'expectedDatabaseId', 'capabilities', 'skillPackageRoot'];
  if (Object.keys(config).some(key => !allowed.includes(key)) || config.formatVersion !== 1 || config.intent !== 'open' || config.role !== 'test'
    || typeof config.expectedDatabaseId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(config.expectedDatabaseId)) throw new CutoverControlError('cutover_configuration_conflict');
  return config as unknown as StartupConfiguration;
}

/** 原子切换启动配置；目标身份、能力与 Skill 根固定，写入后目录 fsync。 */
export function saveStartupConfiguration(userData: string, configuration: StartupConfiguration): void {
  ensureControlDirectory(userData);
  atomicWrite(startupConfigPath(userData), `${JSON.stringify(configuration)}\n`);
}

/** 删除旧的启动配置（仅维护态下不完整切换的重试使用）不在此暴露；失败恢复保留现场。 */
export const cutoverInternals = { atomicWrite, privateFile, privateDirectory };
