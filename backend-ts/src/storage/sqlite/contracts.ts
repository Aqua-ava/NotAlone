import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

export type SqliteRole = 'business' | 'test';
export interface StorageLease { databaseId: string; runtimeId: string; epoch: bigint }
export interface StorageStatus extends StorageLease { schemaVersion: number; sqliteVersion: string; role: SqliteRole }
export interface OpenStorageOptions {
  userData: string;
  intent: 'create' | 'open' | 'reset';
  expectedDatabaseId?: string;
  role: SqliteRole;
  // 仅受信任的构建装配代码使用；不接受HTTP/Tool或界面传入模块。
  registryModule?: string;
}
export type StorageRow = Record<string, SQLOutputValue>;
export interface StorageTransaction {
  run(sql: string, values?: SQLInputValue[]): void;
  get(sql: string, values?: SQLInputValue[]): StorageRow | undefined;
  all(sql: string, values?: SQLInputValue[]): StorageRow[];
}
export interface StorageMigration { version: number; sql: string }
export interface StorageMaintenance {
  checkpoint(): { busy: bigint; log: bigint; checkpointed: bigint };
  vacuum(): void;
  check(): { integrity: 'ok'; foreignKeys: 'ok' };
}
type ActionBase = { name: string; retryBusy: boolean };
export type StorageAction = ActionBase & (
  | { mode: 'read' | 'write'; execute(transaction: StorageTransaction, input: unknown, lease: StorageLease): unknown }
  | { mode: 'maintenance'; retryBusy: false; execute(maintenance: StorageMaintenance, input: unknown, lease: StorageLease): unknown }
);
export interface StorageRegistry { migrations: StorageMigration[]; actions: StorageAction[] }
export class StorageFailure extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'StorageFailure'; this.code = code; }
}
