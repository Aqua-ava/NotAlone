/** 默认 SQLite 切换的控制面合同：跨目标删除保留进度、身份、维护态与恢复凭据。 */
import type { SqliteCapabilitiesConfiguration } from '../../sqlite-capabilities.ts';

export const CUTOVER_FORMAT_VERSION = 1;
export const CUTOVER_DIRECTORY = 'database-cutover';
export const CUTOVER_MANIFEST = 'manifest.json';
export const CUTOVER_AUTHORIZATION = 'authorization.json';
/** 正常开发入口读取的启动配置；由本模块原子切换，不由界面或业务代码直接改写。 */
export const CUTOVER_STARTUP_CONFIG = 'sqlite-development.json';

export type CutoverPhase = 'identified' | 'fenced' | 'target_ready' | 'cleaned' | 'verified' | 'switched' | 'completed' | 'blocked';
export type LegacyTargetKind =
  | 'legacy_unrecognized_managed'
  | 'legacy_update_backup'
  | 'legacy_assistant_runtime'
  | 'legacy_writer_handshake'
  | 'legacy_launch_lock'
  | 'legacy_import_pending'
  | 'runtime_handshake'
  | 'runtime_launch_lock';
export type LegacyTargetState = 'pending' | 'cleaned' | 'retained' | 'failed';
export type Ownership = 'confirmed' | 'unknown';

export interface LegacyTarget {
  /** 由 kind+locator 派生的稳定标识；不包含正文或凭据。 */
  id: string;
  kind: LegacyTargetKind;
  /** 相对 userData 的规范化定位；不记录可恢复的私人定位。 */
  locator: string;
  ownership: Ownership;
  /** 简短证据类别，不复制文件内容。 */
  evidence: string;
  state: LegacyTargetState;
  attempts: number;
  lastErrorCode?: string;
  detail?: string;
}

export interface CutoverTargetIdentity {
  databaseFile: string;
  databaseId: string;
  ownerId: string;
  role: 'test';
}

export interface WriterCheckRecord {
  name: 'legacy_app_handshake' | 'legacy_launch_lock' | 'runtime_launch_lock' | 'new_host_handshake';
  locator: string;
  state: 'stopped' | 'running' | 'unknown';
  detail?: string;
}

export interface CutoverCheckRecord {
  name: 'storage_integrity' | 'structure' | 'media_closure' | 'deletion_registration' | 'skill_empty_safe' | 'target_identity' | 'writer_fence' | 'legacy_cleanup';
  state: 'passed' | 'failed' | 'not_applicable';
  detail?: string;
}

export interface CutoverManifest {
  formatVersion: 1;
  revision: number;
  phase: CutoverPhase;
  blockedCode?: string;
  createdAt: number;
  updatedAt: number;
  target?: CutoverTargetIdentity;
  /** 首次切换时目标是否由本控制面新建；采用既有开发库时记录 adopted。 */
  targetOrigin?: 'created' | 'adopted';
  legacyTargets: LegacyTarget[];
  writerChecks: WriterCheckRecord[];
  checks: CutoverCheckRecord[];
  authorizationDigest?: string;
  configPath: string;
  /** 目标数据库创建已开始但尚未记录身份；重试必须停止并保留现场。 */
  targetCreatePending?: boolean;
}

export interface CutoverAuthorizationEntry {
  id: string;
  disposition: 'clean' | 'retain';
  retainReason?: string;
}
export interface CutoverAuthorization {
  formatVersion: 1;
  approvedAt: number;
  scope: 'synthetic' | 'confirmed_local';
  targets: CutoverAuthorizationEntry[];
}

export interface CutoverFailure {
  phase: 'maintenance';
  code: CutoverCode;
  detail: string;
  manifestRevision: number;
}
export interface CutoverReady {
  phase: 'ready';
  code: 'sqlite_ready' | 'sqlite_reopened';
  databaseId: string;
  ownerId: string;
  schemaVersion: number;
  sqliteVersion: string;
  created: boolean;
  configuration: SqliteCapabilitiesConfiguration;
  manifestRevision: number;
}
export type CutoverCode =
  | 'database_cutover_required'
  | 'database_maintenance'
  | 'cutover_manifest_invalid'
  | 'cutover_authorization_required'
  | 'cutover_authorization_invalid'
  | 'cutover_legacy_target_unclassified'
  | 'cutover_legacy_writer_running'
  | 'cutover_cleanup_failed'
  | 'cutover_checks_failed'
  | 'cutover_target_unrecorded'
  | 'cutover_configuration_conflict'
  | 'cutover_storage_failed';
export type CutoverResult = CutoverReady | CutoverFailure;

/** 打开/创建目标实例的可注入端口；测试可用同一合同注入故障。 */
export interface CutoverStorageStatus {
  databaseId: string;
  schemaVersion: number;
  sqliteVersion: string;
  role: 'test';
}
export interface CutoverStorage {
  readonly status: CutoverStorageStatus;
  execute<T = unknown>(name: string, input: unknown): Promise<T>;
  check(): Promise<{ integrity: 'ok'; foreignKeys: 'ok' }>;
  close(): Promise<void>;
}
export interface CutoverStorageFactory {
  open(options: { userData: string; intent: 'create' | 'open'; expectedDatabaseId?: string; role: 'test' }): Promise<CutoverStorage>;
}
