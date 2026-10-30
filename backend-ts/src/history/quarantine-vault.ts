import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open as openFile, readdir, rm } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';

const databaseName = 'vault.sqlite';
const applicationId = 0x4e415156;
const schemaVersion = 2;
const maxPageRecords = 1000;
const maxTextBytes = 1_000_000;
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const digestPattern = /^[a-f0-9]{64}$/i;
const interruptedCodes = new Set(['source_continuity_lost', 'snapshot_interrupted', 'snapshot_failed']);

export class QuarantineVaultError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'QuarantineVaultError'; this.code = code; }
}

export interface QuarantineTextInput {
  kind: string;
  text: string | null;
  status: string | null;
  originalType: string;
  sender: 'owner' | 'contact' | 'unknown';
  sentAt: string | null;
  partition: string;
  table: string;
  localId: string | null;
  serverId: string | null;
}

export interface QuarantineRecord {
  id: string;
  page: number;
  kind: 'text';
  text: string;
  status: string | null;
  originalType: string;
  sender: 'owner' | 'contact' | 'unknown';
  sentAt: string | null;
  partition: string;
  table: string;
  localId: string | null;
  serverId: string | null;
  state: 'unverified';
}

export type SnapshotState = 'ready' | 'running' | 'complete' | 'incomplete';
export type SourceContinuity = 'unverified' | 'held' | 'lost';
export interface QuarantineVaultStatus {
  displayName: string;
  snapshotState: SnapshotState;
  snapshotComplete: boolean;
  normalHistory: false;
  sourceContinuity: SourceContinuity;
  failureCode: string | null;
  expectedPartitions: string[];
  completedPartitions: string[];
  pageCount: number;
  recordCount: number;
  unavailableTextCount: number;
  createdAt: number;
  updatedAt: number;
}
export interface QuarantinePageResult { saved: number; skippedNonText: number; skippedUnavailableText: number; page: number; status: QuarantineVaultStatus }
export interface QuarantineListResult { status: QuarantineVaultStatus; records: QuarantineRecord[]; nextCursor: string | null }

type DatabaseRow = Record<string, unknown>;
interface VaultMeta {
  scopeDigest: string; displayName: string; snapshotState: SnapshotState; sourceContinuity: SourceContinuity; failureCode: string | null;
  expectedPartitions: string[]; completedPartitions: string[]; pageCount: number; unavailableTextCount: number; createdAt: number; updatedAt: number;
}

function fail(code: string): never { throw new QuarantineVaultError(code); }
function validateOptions(options: { scopeDigest: string; displayName: string }): void {
  if (!options || typeof options !== 'object' || !digestPattern.test(options.scopeDigest)) fail('quarantine_scope_digest_invalid');
  if (typeof options.displayName !== 'string' || !options.displayName.trim() || options.displayName.length > 80
    || /[\u0000-\u001f\u007f/\\]/.test(options.displayName)) fail('quarantine_display_name_invalid');
}
function validatePartition(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512
    && !/[\u0000-\u001f\u007f/\\]/.test(value) && value !== '.' && value !== '..';
}
function validateIdentifier(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && value.length <= 128 && !/[\u0000-\u001f\u007f/\\]/.test(value);
}
function validateDecimal(value: unknown): value is string | null {
  return value === null || typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value);
}
function validateTextMetadata(value: QuarantineTextInput): void {
  if (typeof value.originalType !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value.originalType)
    || !['owner', 'contact', 'unknown'].includes(value.sender)
    || !(value.status === null || typeof value.status === 'string' && /^-?(0|[1-9][0-9]{0,18})$/.test(value.status))
    || !(value.sentAt === null || typeof value.sentAt === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value.sentAt))
    || !validatePartition(value.partition) || !validatePartition(value.table)
    || !validateDecimal(value.localId) || !validateDecimal(value.serverId)) fail('quarantine_record_invalid');
}
function validateTextRecord(value: QuarantineTextInput): void {
  validateTextMetadata(value);
  if (typeof value.text !== 'string' || Buffer.byteLength(value.text, 'utf8') > maxTextBytes) fail('quarantine_record_invalid');
}
function parsePartitions(value: unknown): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(String(value)); } catch { return fail('quarantine_vault_corrupt'); }
  if (!Array.isArray(parsed) || parsed.some(item => !validatePartition(item)) || new Set(parsed).size !== parsed.length) fail('quarantine_vault_corrupt');
  return parsed;
}
function jsonPartitions(values: readonly string[]): string {
  if (!Array.isArray(values) || values.length > 4096 || values.some(item => !validatePartition(item)) || new Set(values).size !== values.length) fail('quarantine_partitions_invalid');
  return JSON.stringify([...values].sort());
}
function normalizePartitions(values: readonly string[], allowed?: readonly string[]): string[] {
  const parsed = JSON.parse(jsonPartitions(values)) as string[];
  if (allowed && parsed.some(value => !allowed.includes(value))) fail('quarantine_partition_outside_target');
  return parsed;
}
function allowedVaultFiles(entries: string[]): boolean {
  return entries.every(name => [databaseName, `${databaseName}-journal`, `${databaseName}-wal`, `${databaseName}-shm`].includes(name));
}
function validateScopeDigest(scopeDigest?: string): void {
  if (scopeDigest !== undefined && (typeof scopeDigest !== 'string' || !digestPattern.test(scopeDigest))) fail('quarantine_scope_digest_invalid');
}
function readVaultMeta(database: DatabaseSync): VaultMeta {
  const row = database.prepare('SELECT * FROM vault_meta WHERE singleton=1').get() as DatabaseRow | undefined;
  if (!row || Number(row.schema_version) !== schemaVersion) fail('quarantine_vault_corrupt');
  return { scopeDigest: String(row.scope_digest), displayName: String(row.display_name), snapshotState: String(row.snapshot_state) as SnapshotState,
    sourceContinuity: String(row.source_continuity) as SourceContinuity,
    failureCode: row.failure_code === null ? null : String(row.failure_code),
    expectedPartitions: parsePartitions(row.expected_partitions), completedPartitions: parsePartitions(row.completed_partitions),
    pageCount: Number(row.page_count), unavailableTextCount: Number(row.unavailable_text_count),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function readVaultStatus(database: DatabaseSync): QuarantineVaultStatus {
  const row = readVaultMeta(database);
  const count = database.prepare('SELECT count(*) AS n FROM quarantine_record').get() as DatabaseRow;
  return { displayName: row.displayName, snapshotState: row.snapshotState,
    snapshotComplete: row.snapshotState === 'complete', normalHistory: false,
    sourceContinuity: row.sourceContinuity, failureCode: row.failureCode,
    expectedPartitions: row.expectedPartitions, completedPartitions: row.completedPartitions,
    pageCount: row.pageCount, recordCount: Number(count.n), unavailableTextCount: row.unavailableTextCount,
    createdAt: row.createdAt, updatedAt: row.updatedAt };
}
interface VerifiedVaultDatabase {
  root: string;
  databasePath: string;
  rootStat: Stats;
  databaseStat: Stats;
  database: DatabaseSync;
  status: QuarantineVaultStatus;
}
async function verifyVaultDatabase(root: string, scopeDigest?: string): Promise<VerifiedVaultDatabase> {
  validateScopeDigest(scopeDigest);
  const secured = await secureRoot(root, false);
  const databasePath = join(secured.path, databaseName);
  const rootStat = await lstat(secured.path).catch(() => fail('quarantine_root_invalid'));
  const databaseStat = await lstat(databasePath).catch(() => fail('quarantine_database_missing'));
  if (databaseStat.isSymbolicLink() || !databaseStat.isFile()) fail('quarantine_database_invalid');
  let database: DatabaseSync;
  try { database = new DatabaseSync(databasePath, { readOnly: true }); }
  catch { fail('quarantine_database_invalid'); }
  try {
    const appId = Number(database.prepare('PRAGMA application_id').get()?.application_id);
    const version = Number(database.prepare('PRAGMA user_version').get()?.user_version);
    if (appId !== applicationId || version !== schemaVersion) fail('quarantine_database_invalid');
    const journalMode = String(database.prepare('PRAGMA journal_mode').get()?.journal_mode ?? '').toLowerCase();
    const integrity = database.prepare('PRAGMA integrity_check').all() as DatabaseRow[];
    if (journalMode !== 'delete' || integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') fail('quarantine_database_invalid');
    const objects = database.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as DatabaseRow[];
    const objectNames = objects.map(row => `${row.type}:${row.name}`).sort().join(',');
    if (objectNames !== 'index:quarantine_record_page,table:quarantine_record,table:vault_meta') fail('quarantine_database_invalid');
    const metaColumns = (database.prepare('PRAGMA table_info(vault_meta)').all() as DatabaseRow[]).map(row => String(row.name)).join(',');
    if (metaColumns !== 'singleton,schema_version,scope_digest,display_name,created_at,updated_at,snapshot_state,source_continuity,failure_code,expected_partitions,completed_partitions,page_count,unavailable_text_count') fail('quarantine_database_invalid');
    const recordColumns = (database.prepare('PRAGMA table_info(quarantine_record)').all() as DatabaseRow[]).map(row => String(row.name)).join(',');
    if (recordColumns !== 'sequence,id,page_number,item_number,kind,text_body,status,original_type,sender,sent_at,partition_name,table_instance,local_id,server_id,assurance,created_at') fail('quarantine_database_invalid');
    const status = readVaultStatus(database);
    const scope = database.prepare('SELECT scope_digest FROM vault_meta WHERE singleton=1').get() as DatabaseRow | undefined;
    if (!scope) fail('quarantine_database_corrupt');
    if (scopeDigest !== undefined && scope.scope_digest !== scopeDigest.toLowerCase()) fail('quarantine_scope_mismatch');
    const rootVerified = await lstat(secured.path).catch(() => fail('quarantine_root_invalid'));
    const databaseVerified = await lstat(databasePath).catch(() => fail('quarantine_database_missing'));
    if (rootVerified.isSymbolicLink() || !rootVerified.isDirectory() || rootStat.dev !== rootVerified.dev || rootStat.ino !== rootVerified.ino
      || databaseVerified.isSymbolicLink() || !databaseVerified.isFile() || databaseStat.dev !== databaseVerified.dev || databaseStat.ino !== databaseVerified.ino) fail('quarantine_path_changed');
    return { root: secured.path, databasePath, rootStat, databaseStat, database, status };
  } catch (error) {
    try { database.close(); } catch { /* 只读预检失败后关闭数据库 */ }
    if (error instanceof QuarantineVaultError) throw error;
    fail('quarantine_database_corrupt');
  }
}
async function secureRoot(root: string, create: boolean): Promise<{ path: string }> {
  if (typeof root !== 'string' || !root.trim()) fail('quarantine_root_invalid');
  const path = resolve(root);
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('quarantine_root_invalid');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) fail('quarantine_root_invalid');
    try { await mkdir(path, { mode: 0o700 }); }
    catch { fail('quarantine_root_invalid'); }
  }
  const entries = await readdir(path);
  if (create && entries.length !== 0) fail('quarantine_root_not_empty');
  if (!create && (!entries.includes(databaseName) || !allowedVaultFiles(entries))) fail('quarantine_root_invalid');
  if (create) await chmod(path, 0o700);
  return { path };
}
async function createPrivateDatabaseFile(path: string): Promise<void> {
  let handle;
  let created = false;
  try {
    const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0);
    handle = await openFile(path, flags, 0o600);
    created = true;
    await handle.chmod(0o600);
  } catch {
    if (created) await rm(path, { force: true }).catch(() => {});
    fail('quarantine_database_create_failed');
  }
  finally { await handle?.close(); }
}

function schema(): string {
  return `
CREATE TABLE vault_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton=1),
  schema_version INTEGER NOT NULL,
  scope_digest TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  snapshot_state TEXT NOT NULL CHECK (snapshot_state IN ('ready','running','complete','incomplete')),
  source_continuity TEXT NOT NULL CHECK (source_continuity IN ('unverified','held','lost')),
  failure_code TEXT,
  expected_partitions TEXT NOT NULL,
  completed_partitions TEXT NOT NULL,
  page_count INTEGER NOT NULL CHECK (page_count>=0),
  unavailable_text_count INTEGER NOT NULL DEFAULT 0 CHECK (unavailable_text_count>=0)
) STRICT;
CREATE TABLE quarantine_record (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  page_number INTEGER NOT NULL CHECK (page_number>0),
  item_number INTEGER NOT NULL CHECK (item_number>=0 AND item_number<${maxPageRecords}),
  kind TEXT NOT NULL CHECK (kind='text'),
  text_body TEXT NOT NULL,
  status TEXT,
  original_type TEXT NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('owner','contact','unknown')),
  sent_at TEXT,
  partition_name TEXT NOT NULL,
  table_instance TEXT NOT NULL,
  local_id TEXT,
  server_id TEXT,
  assurance TEXT NOT NULL CHECK (assurance='unverified'),
  created_at INTEGER NOT NULL,
  UNIQUE(page_number,item_number)
) STRICT;
CREATE INDEX quarantine_record_page ON quarantine_record(sequence DESC);
`;
}

export class QuarantineVault {
  readonly #database: DatabaseSync;
  #closed = false;

  private constructor(database: DatabaseSync) { this.#database = database; }

  static async create(root: string, options: { scopeDigest: string; displayName: string }): Promise<QuarantineVault> {
    validateOptions(options);
    const secured = await secureRoot(root, true);
    const databasePath = join(secured.path, databaseName);
    let database: DatabaseSync | undefined;
    let databaseFileCreated = false;
    try {
      await createPrivateDatabaseFile(databasePath);
      databaseFileCreated = true;
      database = new DatabaseSync(databasePath);
      database.exec('PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF;');
      database.exec(schema());
      const now = Date.now();
      database.prepare(`INSERT INTO vault_meta(singleton,schema_version,scope_digest,display_name,created_at,updated_at,
        snapshot_state,source_continuity,failure_code,expected_partitions,completed_partitions,page_count)
        VALUES(1,?,?,?,?,?,'ready','unverified',NULL,'[]','[]',0)`)
        .run(schemaVersion, options.scopeDigest.toLowerCase(), options.displayName.trim(), now, now);
      database.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=${schemaVersion};`);
      await chmod(databasePath, 0o600);
      return new QuarantineVault(database);
    } catch (error) {
      try { database?.close(); } catch { /* create cleanup continues */ }
      if (databaseFileCreated) {
        await rm(databasePath, { force: true }).catch(() => {});
        await rm(`${databasePath}-journal`, { force: true }).catch(() => {});
      }
      if (error instanceof QuarantineVaultError) throw error;
      fail('quarantine_database_create_failed');
    }
  }

  static async inspect(root: string, options?: { scopeDigest?: string }): Promise<QuarantineVaultStatus> {
    const checked = await verifyVaultDatabase(root, options?.scopeDigest);
    try { return checked.status; }
    finally { checked.database.close(); }
  }

  static async open(root: string, options?: { scopeDigest?: string; rejectActive?: boolean }): Promise<QuarantineVault> {
    const checked = await verifyVaultDatabase(root, options?.scopeDigest);
    const { root: securedRoot, databasePath, rootStat, databaseStat } = checked;
    checked.database.close();
    const isActive = (status: QuarantineVaultStatus) => status.snapshotState === 'ready' || status.snapshotState === 'running';
    if (options?.rejectActive && isActive(checked.status)) fail('quarantine_snapshot_busy');
    await chmod(securedRoot, 0o700);
    await chmod(databasePath, 0o600);
    const dbAfterChmod = await lstat(databasePath).catch(() => fail('quarantine_database_missing'));
    if (dbAfterChmod.isSymbolicLink() || databaseStat.dev !== dbAfterChmod.dev || databaseStat.ino !== dbAfterChmod.ino) fail('quarantine_path_changed');
    let database: DatabaseSync;
    try { database = new DatabaseSync(databasePath); }
    catch { fail('quarantine_database_invalid'); }
    try {
      database.exec('PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF;');
      const vault = new QuarantineVault(database);
      const status = vault.summary();
      if (options?.rejectActive && isActive(status)) {
        database.close();
        fail('quarantine_snapshot_busy');
      }
      if (status.snapshotState === 'running') vault.abort('snapshot_interrupted');
      return vault;
    } catch (error) {
      try { database.close(); } catch { /* 打开隔离仓失败后关闭数据库 */ }
      if (error instanceof QuarantineVaultError) throw error;
      fail('quarantine_database_corrupt');
    }
  }

  begin(input: { expectedPartitions: readonly string[]; scopeDigest?: string }): QuarantineVaultStatus {
    this.#assertOpen();
    const meta = this.#meta();
    if (meta.snapshotState !== 'ready') fail('quarantine_already_started');
    this.#assertScope(input?.scopeDigest);
    const expected = normalizePartitions(input?.expectedPartitions ?? []);
    if (!expected.length) fail('quarantine_partitions_invalid');
    const now = Date.now();
    this.#database.prepare(`UPDATE vault_meta SET snapshot_state='running',source_continuity='held',failure_code=NULL,
      expected_partitions=?,completed_partitions='[]',updated_at=? WHERE singleton=1`)
      .run(JSON.stringify(expected), now);
    return this.summary();
  }

  appendPage(records: readonly QuarantineTextInput[], options: { completedPartitions?: readonly string[]; sourceContinuity?: 'held' | 'lost'; scopeDigest?: string } = {}): QuarantinePageResult {
    this.#assertOpen();
    const before = this.#meta();
    if (before.snapshotState !== 'running') fail('quarantine_not_running');
    this.#assertScope(options.scopeDigest);
    if (!Array.isArray(records) || records.length > maxPageRecords || !options || typeof options !== 'object') fail('quarantine_page_invalid');
    const continuity = options.sourceContinuity ?? 'held';
    if (continuity !== 'held' && continuity !== 'lost') fail('quarantine_source_state_invalid');
    const completed = normalizePartitions(options.completedPartitions ?? [], before.expectedPartitions);
    const mergedCompleted = [...new Set([...before.completedPartitions, ...completed])].sort();
    const page = before.pageCount + 1;
    let saved = 0;
    let skippedNonText = 0;
    let skippedUnavailableText = 0;
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const insert = this.#database.prepare(`INSERT INTO quarantine_record(id,page_number,item_number,kind,text_body,status,original_type,sender,sent_at,
        partition_name,table_instance,local_id,server_id,assurance,created_at) VALUES(?,?,?,'text',?,?,?,?,?,?,?, ?,?,'unverified',?)`);
      for (const [item, value] of records.entries()) {
        if (!value || typeof value !== 'object' || value.kind !== 'text') { skippedNonText++; continue; }
        if (value.text === null || typeof value.text === 'string' && Buffer.byteLength(value.text, 'utf8') > maxTextBytes) {
          validateTextMetadata(value);
          skippedUnavailableText++;
          continue;
        }
        validateTextRecord(value);
        insert.run(randomUUID(), page, item, value.text, value.status, value.originalType, value.sender, value.sentAt,
          value.partition, value.table, value.localId, value.serverId, Date.now());
        saved++;
      }
      const sourceState = continuity === 'lost' ? 'lost' : before.sourceContinuity;
      const snapshotState = continuity === 'lost' ? 'incomplete' : 'running';
      const failure = continuity === 'lost' ? 'source_continuity_lost' : before.failureCode;
      this.#database.prepare(`UPDATE vault_meta SET page_count=?,completed_partitions=?,source_continuity=?,snapshot_state=?,failure_code=?,updated_at=?,unavailable_text_count=unavailable_text_count+? WHERE singleton=1`)
        .run(page, JSON.stringify(mergedCompleted), sourceState, snapshotState, failure, Date.now(), skippedUnavailableText);
      this.#database.exec('COMMIT');
    } catch (error) {
      try { this.#database.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      if (error instanceof QuarantineVaultError) throw error;
      fail('quarantine_page_write_failed');
    }
    return { saved, skippedNonText, skippedUnavailableText, page, status: this.summary() };
  }

  complete(input: { completedPartitions: readonly string[]; scopeDigest: string; sourceContinuity: 'held' | 'lost'; snapshotComplete: boolean }): QuarantineVaultStatus {
    this.#assertOpen();
    if (!input || typeof input !== 'object' || typeof input.snapshotComplete !== 'boolean'
      || !['held', 'lost'].includes(input.sourceContinuity) || !Array.isArray(input.completedPartitions)) fail('quarantine_completion_invalid');
    const meta = this.#meta();
    if (meta.snapshotState !== 'running') fail('quarantine_not_running');
    this.#assertScope(input?.scopeDigest);
    if (input.sourceContinuity !== 'held' || meta.sourceContinuity !== 'held') {
      this.#setState('incomplete', 'lost', 'source_continuity_lost');
      return this.summary();
    }
    const completed = normalizePartitions(input.completedPartitions ?? [], meta.expectedPartitions);
    const allCompleted = [...new Set([...meta.completedPartitions, ...completed])].sort();
    const missing = meta.expectedPartitions.some(partition => !allCompleted.includes(partition));
    if (!input.snapshotComplete || missing) {
      this.#setState('incomplete', 'held', 'snapshot_coverage_incomplete', allCompleted);
      return this.summary();
    }
    this.#setState('complete', 'held', null, allCompleted);
    return this.summary();
  }

  abort(reason: 'source_continuity_lost' | 'snapshot_interrupted' | 'snapshot_failed' = 'snapshot_interrupted'): QuarantineVaultStatus {
    this.#assertOpen();
    if (!interruptedCodes.has(reason)) fail('quarantine_failure_code_invalid');
    const meta = this.#meta();
    if (meta.snapshotState === 'complete' || meta.snapshotState === 'incomplete') return this.summary();
    this.#setState('incomplete', reason === 'snapshot_failed' ? 'unverified' : 'lost', reason);
    return this.summary();
  }

  summary(): QuarantineVaultStatus {
    this.#assertOpen();
    return readVaultStatus(this.#database);
  }

  list(input: { limit?: number; after?: string | null } = {}): QuarantineListResult {
    this.#assertOpen();
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) fail('quarantine_list_limit_invalid');
    let cursorSequence: number | undefined;
    if (input.after !== undefined && input.after !== null) {
      if (typeof input.after !== 'string' || !uuidPattern.test(input.after)) fail('quarantine_cursor_invalid');
      const cursor = this.#database.prepare('SELECT sequence FROM quarantine_record WHERE id=?').get(input.after) as DatabaseRow | undefined;
      if (!cursor) fail('quarantine_cursor_invalid');
      cursorSequence = Number(cursor.sequence);
    }
    const rows = (cursorSequence === undefined
      ? this.#database.prepare(`SELECT * FROM quarantine_record ORDER BY sequence DESC LIMIT ?`).all(limit + 1)
      : this.#database.prepare(`SELECT * FROM quarantine_record WHERE sequence<? ORDER BY sequence DESC LIMIT ?`).all(cursorSequence, limit + 1)) as DatabaseRow[];
    const hasMore = rows.length > limit;
    const selected = rows.slice(0, limit).map(row => this.#record(row));
    return { status: this.summary(), records: selected, nextCursor: hasMore ? selected.at(-1)!.id : null };
  }

  delete(recordId: string): boolean {
    this.#assertOpen();
    if (typeof recordId !== 'string' || !uuidPattern.test(recordId)) fail('quarantine_record_id_invalid');
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#database.prepare('DELETE FROM quarantine_record WHERE id=?').run(recordId);
      this.#database.exec('COMMIT');
      if (Number(result.changes) > 0) this.#vacuum();
      return Number(result.changes) > 0;
    } catch (error) {
      try { this.#database.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      if (error instanceof QuarantineVaultError) throw error;
      fail('quarantine_delete_failed');
    }
  }

  deleteAll(): number {
    this.#assertOpen();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.#meta();
      if (current.snapshotState === 'running') this.#database.prepare(`UPDATE vault_meta SET snapshot_state='incomplete',source_continuity='lost',failure_code='snapshot_interrupted',updated_at=? WHERE singleton=1`).run(Date.now());
      const count = this.#database.prepare('SELECT count(*) AS n FROM quarantine_record').get() as DatabaseRow;
      this.#database.exec('DELETE FROM quarantine_record');
      this.#database.exec('COMMIT');
      this.#vacuum();
      return Number(count.n);
    } catch (error) {
      try { this.#database.exec('ROLLBACK'); } catch { /* transaction already ended */ }
      if (error instanceof QuarantineVaultError) throw error;
      fail('quarantine_delete_failed');
    }
  }

  close(): void {
    if (this.#closed) return;
    const meta = this.#meta();
    if (meta.snapshotState === 'running') this.#setState('incomplete', 'lost', 'snapshot_interrupted');
    this.#database.close();
    this.#closed = true;
  }

  #assertOpen(): void { if (this.#closed) fail('quarantine_vault_closed'); }

  #assertScope(scopeDigest?: string): void {
    if (scopeDigest !== undefined && (typeof scopeDigest !== 'string' || !digestPattern.test(scopeDigest))) fail('quarantine_scope_digest_invalid');
    if (scopeDigest !== undefined && scopeDigest.toLowerCase() !== this.#meta().scopeDigest) fail('quarantine_scope_mismatch');
  }

  #meta(): VaultMeta {
    return readVaultMeta(this.#database);
  }

  #record(row: DatabaseRow): QuarantineRecord {
    return { id: String(row.id), page: Number(row.page_number), kind: 'text', text: String(row.text_body),
      status: row.status === null ? null : String(row.status), originalType: String(row.original_type),
      sender: String(row.sender) as QuarantineRecord['sender'], sentAt: row.sent_at === null ? null : String(row.sent_at),
      partition: String(row.partition_name), table: String(row.table_instance), localId: row.local_id === null ? null : String(row.local_id),
      serverId: row.server_id === null ? null : String(row.server_id), state: 'unverified' };
  }

  #setState(state: SnapshotState, sourceContinuity: SourceContinuity, failureCode: string | null, completed?: string[]): void {
    this.#database.prepare(`UPDATE vault_meta SET snapshot_state=?,source_continuity=?,failure_code=?,completed_partitions=?,updated_at=? WHERE singleton=1`)
      .run(state, sourceContinuity, failureCode, JSON.stringify(completed ?? this.#meta().completedPartitions), Date.now());
  }

  #vacuum(): void {
    try { this.#database.exec('PRAGMA secure_delete=ON; VACUUM;'); }
    catch { fail('quarantine_compaction_failed'); }
  }
}
