import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

export type SqliteRole = 'business' | 'test';
export interface StorageLease { databaseId: string; runtimeId: string; epoch: bigint }
export interface StorageStatus extends StorageLease { schemaVersion: number; sqliteVersion: string; role: SqliteRole }
export interface StorageReader {
  execute<T = unknown>(name: string, input: unknown): Promise<T>;
  close(): Promise<void>;
}
export interface OpenStorageOptions {
  userData: string;
  intent: 'create' | 'open' | 'reset';
  expectedDatabaseId?: string;
  role: SqliteRole;
  // 仅受信任的构建装配代码使用；不接受HTTP/Tool或界面传入模块。
  registryModule?: string;
  // 仅供测试与诊断缩短维护动作预算；缺省按库体积计算，见 timeouts.ts。
  maintenanceTimeoutMs?: number;
  // 仅供离线维护工具放宽普通动作的 15 秒预算（例如十几万目标的联系人删除计划）；产品装配不传，缺省仍为 15 秒。
  actionTimeoutMs?: number;
}
export type StorageRow = Record<string, SQLOutputValue>;
export interface StorageTransaction {
  run(sql: string, values?: SQLInputValue[]): void;
  get(sql: string, values?: SQLInputValue[]): StorageRow | undefined;
  all(sql: string, values?: SQLInputValue[]): StorageRow[];
}
export interface StorageMigration { version: number; sql: string; rebuild?: 'memory-adjudication-v1' | 'memory-documents-v1' }
export interface StorageMaintenance {
  checkpoint(): { busy: bigint; log: bigint; checkpointed: bigint };
  vacuum(): void;
  check(): { integrity: 'ok'; foreignKeys: 'ok' };
  inspect(): { freePages: bigint; tempStore: bigint; secureDelete: bigint; walBytes: bigint; shmBytes: bigint; journalBytes: bigint; unexpectedFiles: number };
}
type ActionBase = { name: string; retryBusy: boolean };
export type StorageAction = ActionBase & (
  | { mode: 'read' | 'write'; execute(transaction: StorageTransaction, input: unknown, lease: StorageLease): unknown }
  | { mode: 'maintenance'; retryBusy: false; execute(maintenance: StorageMaintenance, input: unknown, lease: StorageLease): unknown }
);
export interface StorageRegistry { migrations: StorageMigration[]; actions: StorageAction[];
  // 仅可信registry观察升级阶段，不授予连接、SQL或RPC能力；异常使整个升级回滚。
  migrationObserver?:(event:{version:number;phase:'prepare'|'create'|'copy'|'drop'|'rename'|'recreate'|'check'})=>void;
}
export class StorageFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'StorageFailure'; this.code = code; }
}
