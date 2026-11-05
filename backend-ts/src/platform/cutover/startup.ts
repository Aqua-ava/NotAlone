/** 默认 SQLite 启动编排：识别旧目标、维护态停写核验、创建/复用同一实例、原子切换启动配置。 */
import { lstatSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { SqliteCapabilitiesConfiguration } from '../../sqlite-capabilities.ts';
import { installedDeletionScopes } from '../../storage/sqlite/deletion/registration.ts';
import { recoverSkillRootRelocation } from '../../skills/sqlite/root-relocation.ts';
import { SqliteStorage } from '../../storage/sqlite/client.ts';
import { controlledFiles } from '../../storage/sqlite/files.ts';
import type { CutoverCheckRecord, CutoverCode, CutoverManifest, CutoverReady, CutoverResult, CutoverStorage, CutoverStorageFactory,
  LegacyTarget, LegacyTargetKind, WriterCheckRecord } from './contracts.ts';
import { CUTOVER_FORMAT_VERSION, CUTOVER_STARTUP_CONFIG } from './contracts.ts';
import { authorizationDigest, cutoverDirectory, CutoverControlError, databaseFile, loadAuthorization, loadManifest, loadStartupConfiguration,
  saveManifest, saveStartupConfiguration, type StartupConfiguration } from './control.ts';
import { cleanLegacyTarget, CutoverCleanupError, ensureSkillRoot } from './cleanup.ts';
import { assertPrivateUserData, checkLegacyWriters, discoverLegacyTargets, unrecognizedManagedTargets } from './targets.ts';

const DEFAULT_CAPABILITIES: SqliteCapabilitiesConfiguration['capabilities'] = ['contacts', 'skills', 'history', 'discussions', 'memory'];
const BUSINESS_TARGETS: readonly LegacyTargetKind[] = ['legacy_update_backup',
  'legacy_assistant_runtime', 'legacy_import_pending'];
const RUNTIME_TARGETS: readonly LegacyTargetKind[] = ['legacy_writer_handshake', 'legacy_launch_lock', 'runtime_handshake', 'runtime_launch_lock'];
// 本 App 自己启动的 SQLite 宿主留下的握手与启动锁属于当前运行时，不是旧写入者。
// 单实例由启动器的互斥与握手核验负责；预检不打开数据库，因此宿主存活不构成冲突。
const CURRENT_RUNTIME_WRITERS: readonly WriterCheckRecord['name'][] = ['runtime_launch_lock', 'new_host_handshake'];
const currentRuntime = (record: WriterCheckRecord): boolean => CURRENT_RUNTIME_WRITERS.includes(record.name);
const REQUIRED_DELETION_SCOPES = ['source', 'contact', 'contact_history', 'account', 'media_result_clear', 'media_result_replace', 'discussion'] as const;
const REQUIRED_EMPTY_MEDIA = (snapshot: CutoverSnapshot) => snapshot.media.message_media === 0 && snapshot.media.current_files === 0
  && snapshot.media.staged_files === 0 && snapshot.media.cleanup_pending === 0 && snapshot.media.attempts_running === 0;
export interface CutoverSnapshot {
  ownerId: string; tables: string[]; missingTables: string[]; unexpectedTables: string[];
  media: { message_media: number; current_files: number; staged_files: number; cleanup_pending: number; attempts_running: number };
  skills: { packages: number; revisions: number; enabled: number; unknown: number };
  deletions: { running_operations: number; pending_targets: number };
  runtime: { copies: number; files: number };
  counts: { owners: number; contacts: number; messages: number };
}
export interface DefaultDatabaseOptions {
  userData: string;
  /** 测试注入；缺省使用受控 SqliteStorage。 */
  storageFactory?: CutoverStorageFactory;
  now?: () => number;
  /** 新建实例的默认能力；已有启动配置时一律沿用原配置。 */
  capabilities?: SqliteCapabilitiesConfiguration['capabilities'];
  skillPackageRoot?: string;
  /** 仅隔离合成根允许 synthetic 授权清理；真实 userData 必须使用 confirmed_local。 */
  allowSyntheticAuthorization?: boolean;
}
export interface DefaultDatabaseInternals {
  manifest?: CutoverManifest;
  legacyTargets: LegacyTarget[];
  authorizationDigest?: string;
}

class Blocked extends Error {
  readonly code: CutoverCode;
  readonly detail: string;
  readonly manifest: CutoverManifest;
  constructor(code: CutoverCode, detail: string, manifest: CutoverManifest) { super(detail); this.code = code; this.detail = detail; this.manifest = manifest; }
}
const defaultFactory: CutoverStorageFactory = {
  open: options => SqliteStorage.open(options) as Promise<CutoverStorage>,
};

function initialManifest(now: number): CutoverManifest {
  return { formatVersion: CUTOVER_FORMAT_VERSION, revision: 0, phase: 'identified', createdAt: now, updatedAt: now,
    legacyTargets: [], writerChecks: [], checks: [], configPath: CUTOVER_STARTUP_CONFIG };
}
function business(target: LegacyTarget): boolean { return BUSINESS_TARGETS.includes(target.kind); }
function runtimeArtifact(target: LegacyTarget): boolean { return RUNTIME_TARGETS.includes(target.kind); }
function check(name: CutoverCheckRecord['name'], state: CutoverCheckRecord['state'], detail?: string): CutoverCheckRecord {
  return detail === undefined ? { name, state } : { name, state, detail };
}

/** 主要入口：返回 ready 或 maintenance；仅使用 SQLite，不清理未授权对象，不创建第二个空库。 */
export async function runDefaultDatabaseStartup(options: DefaultDatabaseOptions): Promise<CutoverResult> {
  return runDatabaseStartup(options, 'reopen', reopenCompleted);
}

export interface PreparedDatabaseStartup {
  phase: 'prepared'; code: 'sqlite_prepared'; databaseId: string; ownerId: string;
  configuration: SqliteCapabilitiesConfiguration; manifestRevision: number;
}

/** 桌面只准备已有目标；正式宿主仍须打开同一实例、核验完整性与本人身份后才能连接。 */
export async function prepareDefaultDatabaseStartup(options: DefaultDatabaseOptions): Promise<PreparedDatabaseStartup | CutoverResult> {
  return runDatabaseStartup(options, 'prepare', async (userData, manifest) => {
    const configuration = completedConfiguration(userData, manifest, 'prepare');
    controlledFiles(userData, false).verify();
    return {phase: 'prepared', code: 'sqlite_prepared', databaseId: configuration.expectedDatabaseId,
      ownerId: manifest.target!.ownerId, configuration: configuredCapabilities(configuration), manifestRevision: manifest.revision};
  });
}

async function runDatabaseStartup<T extends CutoverReady | PreparedDatabaseStartup>(options: DefaultDatabaseOptions, mode: StartupMode,
  completed: (userData: string, manifest: CutoverManifest, options: DefaultDatabaseOptions) => Promise<T>): Promise<T | CutoverResult> {
  const userData = path.resolve(options.userData);
  const now = () => options.now?.() ?? Date.now();
  let manifest: CutoverManifest | undefined;
  try {
    assertPrivateUserData(userData);
    manifest = loadManifest(userData);
    if (manifest && manifest.configPath !== CUTOVER_STARTUP_CONFIG) throw new CutoverControlError('cutover_manifest_invalid');
    // 新建与完成态重开都先阻断未知存储；不把观察结果写成删除任务，移除外来项后可继续原实例。
    if (unrecognizedManagedTargets(userData).length) {
      throw new Blocked('cutover_legacy_target_unclassified', 'unsupported_managed_entry', manifest ?? initialManifest(now()));
    }
    if (manifest?.phase === 'completed') {
      try { await recoverSkillRootRelocation(userData); }
      catch { return {phase:'maintenance',code:'cutover_configuration_conflict',detail:'skill_root_relocation_pending',manifestRevision:manifest.revision}; }
      return await completed(userData, manifest, options);
    }
    // 旧缺陷曾把存活宿主自己的运行锁写成阻断；宿主仍存活时只准备原目标，宿主退出后再走切换自愈。
    if (mode === 'prepare' && manifest && blockedByOwnRuntime(userData, manifest)) return await completed(userData, manifest, options);
    return await switchDatabase(userData, manifest ?? initialManifest(now()), options);
  } catch (error) {
    if (error instanceof Blocked) return { phase: 'maintenance', code: error.code, detail: error.detail, manifestRevision: error.manifest.revision };
    const code = error instanceof CutoverControlError ? error.code : error instanceof CutoverCleanupError ? 'cutover_cleanup_failed'
      : (error as { code?: unknown })?.code === 'storage_missing' ? 'cutover_storage_failed' : 'cutover_storage_failed';
    const safeManifest = manifest ?? loadManifest(userData) ?? initialManifest(now());
    const detail = error instanceof CutoverCleanupError ? error.detail : String((error as { code?: unknown })?.code ?? 'startup_failed');
    try { manifest = saveManifest(userData, { ...safeManifest, phase: 'blocked', blockedCode: code }); }
    catch { manifest = safeManifest; }
    return { phase: 'maintenance', code, detail, manifestRevision: manifest.revision };
  }
}

type StartupMode = 'prepare' | 'reopen';
function completedConfiguration(userData: string, manifest: CutoverManifest, mode: StartupMode): StartupConfiguration {
  const configuration = loadStartupConfiguration(userData);
  if (!configuration) throw new Blocked('cutover_configuration_conflict', 'startup_configuration_missing', manifest);
  if (!manifest.target || configuration.expectedDatabaseId !== manifest.target.databaseId) throw new Blocked('cutover_configuration_conflict', 'startup_configuration_identity_mismatch', manifest);
  const running = checkLegacyWriters(userData).filter(record => record.state !== 'stopped');
  const describe = (records: WriterCheckRecord[]) => records.map(record => `${record.name}:${record.state}`).join(',');
  const legacy = running.filter(record => !currentRuntime(record));
  if (legacy.length) {
    const saved = saveManifest(userData, { ...manifest, phase: 'blocked', blockedCode: 'cutover_legacy_writer_running' });
    throw new Blocked('cutover_legacy_writer_running', describe(legacy), saved);
  }
  // 重开会打开数据库并推进实例租约，不能与存活宿主并行；这是暂时占用，不改写已完成的切换清单。
  const live = running.filter(currentRuntime);
  if (live.length && mode === 'reopen') throw new Blocked('cutover_legacy_writer_running', describe(live), manifest);
  return configuration;
}
/** 清单曾因自有运行锁被写成阻断，且身份与启动配置仍一致：宿主存活时不应再走会打开数据库的切换。 */
function blockedByOwnRuntime(userData: string, manifest: CutoverManifest): boolean {
  if (manifest.phase !== 'blocked' || manifest.blockedCode !== 'cutover_legacy_writer_running' || !manifest.target?.ownerId) return false;
  try {
    const configuration = loadStartupConfiguration(userData);
    if (!configuration || configuration.expectedDatabaseId !== manifest.target.databaseId) return false;
    const running = checkLegacyWriters(userData).filter(record => record.state !== 'stopped');
    return running.some(currentRuntime) && !running.some(record => !currentRuntime(record));
  } catch { return false; }
}
function configuredCapabilities(configuration: StartupConfiguration): SqliteCapabilitiesConfiguration {
  return {capabilities: configuration.capabilities, ...(configuration.skillPackageRoot ? {skillPackageRoot: configuration.skillPackageRoot} : {})};
}
async function reopenCompleted(userData: string, manifest: CutoverManifest, options: DefaultDatabaseOptions): Promise<CutoverReady> {
  const configuration = completedConfiguration(userData, manifest, 'reopen');
  const factory = options.storageFactory ?? defaultFactory;
  let storage: CutoverStorage | undefined;
  try {
    storage = await factory.open({ userData, intent: 'open', expectedDatabaseId: configuration.expectedDatabaseId, role: 'test' });
    const ownerId = await storage.execute<string>('identity.resolveOwner', { proposedOwnerId: randomUUID(), expectedOwnerId: manifest.target!.ownerId, at: Date.now() });
    if (ownerId !== manifest.target!.ownerId) throw new Blocked('cutover_checks_failed', 'target_owner_mismatch', manifest);
    return { phase: 'ready', code: 'sqlite_reopened', databaseId: storage.status.databaseId, ownerId, schemaVersion: storage.status.schemaVersion,
      sqliteVersion: storage.status.sqliteVersion, created: false, configuration: configuredCapabilities(configuration), manifestRevision: manifest.revision };
  } catch (error) {
    if (error instanceof Blocked) throw error;
    throw error;
  } finally { await storage?.close().catch(() => {}); }
}

async function switchDatabase(userData: string, manifest: CutoverManifest, options: DefaultDatabaseOptions): Promise<CutoverResult> {
  const factory = options.storageFactory ?? defaultFactory;
  const recorded = new Map(manifest.legacyTargets.map(target => [target.id, target]));
  // 已按同一操作清理的目标不再重新识别；保留其清理记录用于审计和重试幂等。
  const legacyTargets = discoverLegacyTargets(userData).filter(target => {
    const prior = recorded.get(target.id);
    return !prior || (prior.state !== 'cleaned' && prior.state !== 'retained');
  });
  const writerChecks = checkLegacyWriters(userData);
  const authorization = loadAuthorization(userData);
  const digest = authorization ? authorizationDigest(authorization) : undefined;
  const runtime = legacyTargets.filter(runtimeArtifact);
  const businessTargets = legacyTargets.filter(business);
  const conflicting = legacyTargets.filter(target => !runtimeArtifact(target) && !business(target));
  manifest = saveManifest(userData, { ...manifest, legacyTargets: mergeTargets(manifest.legacyTargets.filter(target => target.kind !== 'legacy_unrecognized_managed'),
    legacyTargets.filter(target => target.kind !== 'legacy_unrecognized_managed')), writerChecks,
    ...(digest ? { authorizationDigest: digest } : {}) });

  // 运行产物（旧/新关闭握手与锁）不承载业务资料，停写核验后可直接回收。
  const runningWriters = writerChecks.filter(record => record.state !== 'stopped');
  if (runningWriters.length) {
    manifest = saveManifest(userData, { ...manifest, phase: 'blocked', blockedCode: 'cutover_legacy_writer_running',
      checks: [check('writer_fence', 'failed', 'legacy_writer_running')] });
    throw new Blocked('cutover_legacy_writer_running', runningWriters.map(record => `${record.name}:${record.state}`).join(','), manifest);
  }

  if (conflicting.length) {
    manifest = saveManifest(userData, { ...manifest, phase: 'blocked', blockedCode: 'cutover_legacy_target_unclassified' });
    throw new Blocked('cutover_legacy_target_unclassified', conflicting.map(target => target.kind).join(','), manifest);
  }
  if (businessTargets.some(target => target.ownership !== 'confirmed')) {
    manifest = saveManifest(userData, { ...manifest, phase: 'blocked', blockedCode: 'cutover_legacy_target_unclassified' });
    throw new Blocked('cutover_legacy_target_unclassified', 'legacy_ownership_unconfirmed', manifest);
  }
  if (businessTargets.length) {
    if (!authorization) {
      manifest = saveManifest(userData, { ...manifest, phase: 'blocked', blockedCode: 'cutover_authorization_required' });
      throw new Blocked('cutover_authorization_required', 'legacy_cleanup_authorization_required', manifest);
    }
    const covered = new Map(authorization.targets.map(entry => [entry.id, entry]));
    const missing = businessTargets.filter(target => !covered.has(target.id) || covered.get(target.id)!.disposition !== 'clean');
    if (missing.length) {
      manifest = saveManifest(userData, { ...manifest, phase: 'blocked', blockedCode: 'cutover_authorization_invalid' });
      throw new Blocked('cutover_authorization_invalid', 'authorization_scope_incomplete', manifest);
    }
    // synthetic 授权只用于隔离合成根；真实 userData 必须由本地确认授权覆盖，避免一份合成文件删真实对象。
    if (authorization.scope === 'synthetic' && options.allowSyntheticAuthorization !== true) {
      manifest = saveManifest(userData, { ...manifest, phase: 'blocked', blockedCode: 'cutover_authorization_invalid' });
      throw new Blocked('cutover_authorization_invalid', 'synthetic_authorization_requires_isolated_root', manifest);
    }
  }

  // 逐目标清理：已清理的跳过，失败保留现场并由同操作重试；授权对象变化后重新识别。
  manifest = saveManifest(userData, { ...manifest, phase: 'fenced' });
  const cleanOrder = [...runtime, ...businessTargets];
  for (const discovered of cleanOrder) {
    let current = manifest.legacyTargets.find(target => target.id === discovered.id);
    if (!current) throw new Blocked('cutover_checks_failed', 'target_record_missing', manifest);
    if (current.state === 'cleaned' || current.state === 'retained') continue;
    const next: LegacyTarget = { ...current, attempts: current.attempts + 1, state: 'pending' };
    manifest = saveManifest(userData, { ...manifest, legacyTargets: replaceTarget(manifest.legacyTargets, next) });
    try {
      const detail = cleanLegacyTarget(userData, discovered);
      manifest = saveManifest(userData, { ...manifest, legacyTargets: replaceTarget(manifest.legacyTargets, { ...next, state: 'cleaned', detail, lastErrorCode: undefined }) });
    } catch (error) {
      const code = error instanceof CutoverCleanupError ? error.detail : 'cleanup_failed';
      manifest = saveManifest(userData, { ...manifest, phase: 'blocked', blockedCode: 'cutover_cleanup_failed',
        legacyTargets: replaceTarget(manifest.legacyTargets, { ...next, state: 'failed', lastErrorCode: code }) });
      throw new Blocked('cutover_cleanup_failed', `${discovered.kind}:${code}`, manifest);
    }
  }
  const pendingBusiness = manifest.legacyTargets.filter(target => business(target) && target.state !== 'cleaned');
  if (pendingBusiness.length) throw new Blocked('cutover_cleanup_failed', 'business_cleanup_incomplete', manifest);
  manifest = saveManifest(userData, { ...manifest, phase: 'cleaned' });

  // 目标实例：已有控制面身份只允许按 database_id 打开，绝不重建；无身份时排他创建并立即记账。
  const created = !manifest.target;
  const ensured = await ensureTargetInstance(userData, manifest, factory, () => manifest!, options);
  manifest = ensured.manifest;
  const storage = ensured.storage;
  try {
    const expectedOwnerId = manifest.target!.ownerId;
    // 失败重试和接管已有配置仍沿用原本人；仅尚未完成首次初始化的新目标允许创建。
    const createIfMissing = manifest.targetOrigin === 'created' && !expectedOwnerId && !loadStartupConfiguration(userData);
    const ownerId = await storage.execute<string>('identity.resolveOwner', { proposedOwnerId: randomUUID(), createIfMissing,
      ...(expectedOwnerId ? {expectedOwnerId} : {}), at: Date.now() });
    manifest = saveManifest(userData, { ...manifest, phase: 'target_ready', target: { ...manifest.target!, ownerId } });
    manifest = await verifyTarget(userData, manifest, storage, ownerId);
    // 清理完成到配置切换之间再次核验旧写入者，防止清理后重新出现的旧进程被新配置掩盖。
    const lateWriters = checkLegacyWriters(userData).filter(record => record.state !== 'stopped');
    if (lateWriters.length) {
      manifest = saveManifest(userData, { ...manifest, phase: 'blocked', blockedCode: 'cutover_legacy_writer_running' });
      throw new Blocked('cutover_legacy_writer_running', lateWriters.map(record => `${record.name}:${record.state}`).join(','), manifest);
    }
    const configuration = ensured.configuration;
    if (created || !loadStartupConfiguration(userData)) saveStartupConfiguration(userData, configuration);
    const stored = loadStartupConfiguration(userData);
    if (!stored || stored.expectedDatabaseId !== manifest.target!.databaseId) throw new Blocked('cutover_configuration_conflict', 'startup_configuration_write_failed', manifest);
    manifest = saveManifest(userData, { ...manifest, phase: 'completed', blockedCode: undefined });
    return { phase: 'ready', code: created ? 'sqlite_ready' : 'sqlite_reopened', databaseId: storage.status.databaseId, ownerId,
      schemaVersion: storage.status.schemaVersion, sqliteVersion: storage.status.sqliteVersion, created,
      configuration, manifestRevision: manifest.revision };
  } finally { await storage.close().catch(() => {}); }
}

function mergeTargets(existing: LegacyTarget[], discovered: LegacyTarget[]): LegacyTarget[] {
  const byId = new Map(existing.map(target => [target.id, target]));
  for (const target of discovered) if (!byId.has(target.id)) byId.set(target.id, target);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
function replaceTarget(targets: LegacyTarget[], next: LegacyTarget): LegacyTarget[] {
  return targets.map(target => target.id === next.id ? next : target);
}

interface Ensured { manifest: CutoverManifest; storage: CutoverStorage; configuration: StartupConfiguration }
async function ensureTargetInstance(userData: string, manifest: CutoverManifest, factory: CutoverStorageFactory,
  current: () => CutoverManifest, options: DefaultDatabaseOptions): Promise<Ensured> {
  const existingConfiguration = loadStartupConfiguration(userData);
  const baseConfiguration = (databaseId: string): StartupConfiguration => {
    const capabilities = existingConfiguration?.capabilities ?? options.capabilities ?? DEFAULT_CAPABILITIES;
    const root = existingConfiguration?.skillPackageRoot ?? options.skillPackageRoot ?? path.join(userData, 'skill-packages');
    return { formatVersion: 1, intent: 'open', role: 'test', expectedDatabaseId: databaseId, capabilities,
      ...(capabilities.includes('skills') ? { skillPackageRoot: root } : {}) };
  };
  if (manifest.target) {
    try {
      const storage = await factory.open({ userData, intent: 'open', expectedDatabaseId: manifest.target.databaseId, role: 'test' });
      return { manifest, storage, configuration: existingConfiguration ?? baseConfiguration(storage.status.databaseId) };
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'storage_missing') throw new Blocked('cutover_storage_failed', 'target_database_missing', current());
      throw error;
    }
  }
  if (existingConfiguration) {
    const storage = await factory.open({ userData, intent: 'open', expectedDatabaseId: existingConfiguration.expectedDatabaseId, role: 'test' });
    manifest = saveManifest(userData, { ...current(), targetOrigin: 'adopted', target: { databaseFile: 'managed/sqlite/notalone.sqlite', databaseId: storage.status.databaseId,
      ownerId: '', role: 'test' } });
    return { manifest, storage, configuration: existingConfiguration };
  }
  if (exists(databaseFile(userData))) {
    manifest = saveManifest(userData, { ...current(), targetCreatePending: true, phase: 'blocked', blockedCode: 'cutover_target_unrecorded' });
    throw new Blocked('cutover_target_unrecorded', 'target_file_without_identity', manifest);
  }
  const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
  const skillPackageRoot = options.skillPackageRoot ?? path.join(userData, 'skill-packages');
  if (capabilities.includes('skills') && !options.skillPackageRoot) ensureSkillRoot(userData, skillPackageRoot);
  manifest = saveManifest(userData, { ...current(), targetCreatePending: true });
  let storage: CutoverStorage;
  try {
    storage = await factory.open({ userData, intent: 'create', role: 'test' });
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === 'storage_already_exists') {
      manifest = saveManifest(userData, { ...current(), targetCreatePending: true, phase: 'blocked', blockedCode: 'cutover_target_unrecorded' });
      throw new Blocked('cutover_target_unrecorded', 'target_created_without_identity', manifest);
    }
    manifest = saveManifest(userData, { ...current(), targetCreatePending: false, phase: 'blocked', blockedCode: 'cutover_storage_failed' });
    throw error;
  }
  const root = skillPackageRoot;
  const configuration: StartupConfiguration = { formatVersion: 1, intent: 'open', role: 'test', expectedDatabaseId: storage.status.databaseId,
    capabilities, ...(capabilities.includes('skills') ? { skillPackageRoot: root } : {}) };
  manifest = saveManifest(userData, { ...current(), targetOrigin: 'created', target: { databaseFile: 'managed/sqlite/notalone.sqlite', databaseId: storage.status.databaseId,
    ownerId: '', role: 'test' }, targetCreatePending: false });
  return { manifest, storage, configuration };
}

async function verifyTarget(userData: string, manifest: CutoverManifest, storage: CutoverStorage, ownerId: string): Promise<CutoverManifest> {
  // 已保存且身份一致的启动配置说明该目标通过过首次核验；重开恢复不能再要求业务库为空。
  const established = loadStartupConfiguration(userData)?.expectedDatabaseId === manifest.target?.databaseId;
  const created = manifest.targetOrigin === 'created' && !established;
  const checks: CutoverCheckRecord[] = [];
  const snapshot = await storage.execute<CutoverSnapshot>('cutover.snapshot', { ownerId });
  const target = manifest.target!;
  checks.push(check('target_identity', snapshot.ownerId === ownerId && storage.status.databaseId === target.databaseId ? 'passed' : 'failed'));
  const integrity = await storage.check();
  checks.push(check('storage_integrity', integrity.integrity === 'ok' && integrity.foreignKeys === 'ok' ? 'passed' : 'failed'));
  const structure = snapshot.missingTables.length === 0 && snapshot.unexpectedTables.length === 0;
  checks.push(check('structure', structure ? 'passed' : 'failed', structure ? undefined : `missing:${snapshot.missingTables.join(',')};unexpected:${snapshot.unexpectedTables.join(',')}`));
  if (created) {
    const media = REQUIRED_EMPTY_MEDIA(snapshot) && !legacyMediaAreaOccupied(userData);
    checks.push(check('media_closure', media ? 'passed' : 'failed', media ? 'empty_target_closure' : 'legacy_media_area_unverified'));
    checks.push(check('skill_empty_safe', snapshot.skills.packages === 0 && snapshot.skills.revisions === 0 ? 'passed' : 'failed',
      snapshot.skills.packages === 0 ? 'empty_skill_business_rows' : 'unexpected_skill_rows'));
  } else {
    checks.push(check('media_closure', 'not_applicable', 'reopened_existing_target'), check('skill_empty_safe', 'not_applicable', 'reopened_existing_target'));
  }
  const missingScopes = REQUIRED_DELETION_SCOPES.filter(scope => !(installedDeletionScopes as readonly string[]).includes(scope));
  checks.push(check('deletion_registration', missingScopes.length === 0 ? 'passed' : 'failed',
    missingScopes.length ? `missing_scopes:${missingScopes.join(',')}` : 'media_and_source_scopes_registered'));
  checks.push(check('writer_fence', manifest.writerChecks.every(record => record.state === 'stopped') ? 'passed' : 'failed'));
  checks.push(check('legacy_cleanup', manifest.legacyTargets.every(target => target.state === 'cleaned' || target.state === 'retained') ? 'passed' : 'failed'));
  const failed = checks.filter(record => record.state === 'failed');
  manifest = saveManifest(userData, { ...manifest, checks });
  if (failed.length) {
    manifest = saveManifest(userData, { ...manifest, phase: 'blocked', blockedCode: 'cutover_checks_failed' });
    throw new Blocked('cutover_checks_failed', failed.map(record => record.name).join(','), manifest);
  }
  return saveManifest(userData, { ...manifest, phase: 'verified' });
}
/** 新库为空时受管媒体区仍有文件说明属于旧应用副本；归属无法只凭目录证明，不自动删除。 */
function legacyMediaAreaOccupied(userData: string): boolean {
  try { return readdirSync(path.join(userData, 'managed/media')).length > 0; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function exists(location: string): boolean {
  try { lstatSync(location); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
/** 只读检查：不创建、不清理，供诊断和验收查看控制面状态。 */
export function inspectCutover(userData: string): { manifest?: CutoverManifest; directory: string; legacyTargets: LegacyTarget[] } {
  const manifest = loadManifest(userData);
  return { manifest, directory: cutoverDirectory(userData), legacyTargets: discoverLegacyTargets(userData) };
}
export { BUSINESS_TARGETS, RUNTIME_TARGETS, DEFAULT_CAPABILITIES };
