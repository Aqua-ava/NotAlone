import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { controlledFiles } from './files.ts';
import { registry as defaultRegistry } from './registry.ts';
import { memoryAdjudicationMigration, memoryAdjudicationRebuildPolicy, memoryAdjudicationRebuildChecksum, memoryAdjudicationUpgradeSteps } from '../../memory/sqlite/management/adjudication-schema.ts';
import { memoryDocumentsMigration, memoryDocumentsRebuildPolicy, memoryDocumentsRebuildChecksum, memoryDocumentsUpgradeSteps } from '../../memory/sqlite/documents/schema.ts';
import { StorageFailure, type OpenStorageOptions, type StorageRegistry, type StorageTransaction, type StorageLease, type StorageMaintenance } from './contracts.ts';

const port = parentPort!;
const options = workerData as OpenStorageOptions;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const code = (error: unknown): string => {
  if (error instanceof StorageFailure) return error.code;
  const e = error as {code?: string; errcode?: number};
  if (e.errcode !== undefined && (e.errcode & 0xff) === 5) return 'storage_busy';
  if (e.code === 'ENOENT') return 'storage_missing';
  if (e.code === 'EEXIST') return 'storage_already_exists';
  if (e.code === 'ERR_SQLITE_ERROR') return 'storage_invalid';
  return 'storage_failed';
};
let db: DatabaseSync | undefined;
try {
  if (options.intent === 'reset') throw new StorageFailure('reset_requires_cutover');
  if (!['create', 'open'].includes(options.intent) || !['test', 'business'].includes(options.role)) throw new StorageFailure('storage_configuration_invalid');
  if (options.intent === 'open' && !options.expectedDatabaseId) throw new StorageFailure('instance_required');
  const registry: StorageRegistry = options.registryModule ? (await import(options.registryModule)).registry : defaultRegistry;
  if (!registry.migrations.length || registry.migrations.some((m, i) => m.version !== i + 1 || typeof m.sql !== 'string')
    || new Set(registry.actions.map(a => a.name)).size !== registry.actions.length
    || registry.actions.some(a => !['read','write','maintenance'].includes(a.mode) || typeof a.execute !== 'function' || (a.mode === 'maintenance' && a.retryBusy) || a.name.startsWith('storage.') || !/^[a-z][a-zA-Z0-9]*\.[a-zA-Z][a-zA-Z0-9]*$/.test(a.name))) throw new StorageFailure('registry_invalid');
  // 只有编译进应用的固定版本和完整SQL可以进入事务外关FK路径。
  for (const migration of registry.migrations) {
    if (migration.sql === memoryAdjudicationMigration(12).sql && migration.rebuild !== memoryAdjudicationRebuildPolicy) throw new StorageFailure('migration_rebuild_forbidden');
    if (migration.sql === memoryDocumentsMigration(13).sql && migration.rebuild !== memoryDocumentsRebuildPolicy) throw new StorageFailure('migration_rebuild_forbidden');
    if (migration.rebuild !== undefined) {
      const allowed = migration.rebuild === memoryAdjudicationRebuildPolicy && migration.version === 12
        && migration.sql === memoryAdjudicationMigration(12).sql && digest(migration.sql) === memoryAdjudicationRebuildChecksum
        || migration.rebuild === memoryDocumentsRebuildPolicy && migration.version === 13
        && migration.sql === memoryDocumentsMigration(13).sql && digest(migration.sql) === memoryDocumentsRebuildChecksum;
      if (!allowed) throw new StorageFailure('migration_rebuild_forbidden');
    }
  }
  const files = controlledFiles(options.userData, options.intent === 'create');
  db = new DatabaseSync(files.database, { enableForeignKeyConstraints: true, allowExtension: false, timeout: 100 });
  const connection = db;
  connection.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;');
  const bindings = (values: SQLInputValue[]) => {
    if (values.some(v => typeof v === 'number' && (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))))) throw new StorageFailure('storage_value_invalid');
    return values;
  };
  const all = (sql: string, values: SQLInputValue[] = []) => { const s = connection.prepare(sql); s.setReadBigInts(true); return s.all(...bindings(values)); };
  const get = (sql: string, values: SQLInputValue[] = []) => all(sql, values)[0];
  const schemaDigest = () => digest(JSON.stringify(all("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name")));
  const checks = () => {
    if (all('PRAGMA integrity_check').some(r => r.integrity_check !== 'ok')) throw new StorageFailure('integrity_failed');
    if (all('PRAGMA foreign_key_check').length) throw new StorageFailure('foreign_keys_failed');
    return {integrity: 'ok', foreignKeys: 'ok'} as const;
  };
  const transaction = <T>(write: boolean, fn: () => T): T => {
    connection.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = fn(); connection.exec('COMMIT'); return result; }
    catch (error) { if (connection.isTransaction) connection.exec('ROLLBACK'); throw error; }
  };
  const verifyExisting = () => {
    // 先核验固定身份与结构；完整性在同一写锁快照内核验后才允许改动。
    const instance = get('SELECT * FROM database_instance WHERE slot=1');
    if (!instance || instance.database_id !== options.expectedDatabaseId || instance.role !== options.role
      || instance.format_family !== 'notalone-sqlite-v1') throw new StorageFailure('instance_mismatch');
    if (instance.schema_digest !== schemaDigest()) throw new StorageFailure('schema_drift');
    const ledger = all('SELECT version,checksum FROM schema_migration ORDER BY version');
    if (ledger.length > registry.migrations.length) throw new StorageFailure('schema_too_new');
    if (get('PRAGMA user_version')?.user_version !== BigInt(ledger.length)
      || ledger.some((m, i) => m.version !== BigInt(i + 1) || m.checksum !== digest(registry.migrations[i].sql))) throw new StorageFailure('migration_drift');
  };
  if (options.intent === 'open') verifyExisting();
  const initiallyApplied = options.intent === 'create' ? 0 : Number(get('SELECT COUNT(*) AS n FROM schema_migration')!.n);
  let journal = get('PRAGMA journal_mode');
  if (journal?.journal_mode !== 'wal') {
    // 已有非WAL库转换前仍完整核验，不能让损坏库先产生配置写入。
    if (options.intent === 'open') checks();
    journal = get('PRAGMA journal_mode=WAL');
  }
  if (journal?.journal_mode !== 'wal') throw new StorageFailure('wal_unavailable');
  connection.exec('PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=0;');
  const databaseId = options.intent === 'create' ? randomUUID() : options.expectedDatabaseId!;
  const runtimeId = randomUUID();
  const rebuildPending = registry.migrations.slice(initiallyApplied).some(m => m.rebuild !== undefined);
  try {
    // SQLite只能在事务外改变FK开关；锁内仍复验完整现场，不沿用锁外账本。
    if (rebuildPending) {
      connection.exec('PRAGMA foreign_keys=OFF');
      if (get('PRAGMA foreign_keys')?.foreign_keys !== 0n) throw new StorageFailure('foreign_keys_disable_failed');
    }
    transaction(true, () => {
      if (options.intent === 'open') { verifyExisting(); checks(); }
      const applied = options.intent === 'create' ? 0 : Number(get('SELECT COUNT(*) AS n FROM schema_migration')!.n);
      for (const migration of registry.migrations.slice(applied)) {
        if (migration.rebuild) {
          const steps = migration.rebuild === memoryAdjudicationRebuildPolicy ? memoryAdjudicationUpgradeSteps : memoryDocumentsUpgradeSteps;
          for (const step of steps) {
            connection.exec(step.sql);
            if (step.phase === 'check') checks();
            const observed: unknown = registry.migrationObserver?.({version: migration.version, phase: step.phase});
            if (observed && typeof (observed as Promise<unknown>).then === 'function') {
              void Promise.resolve(observed).catch(() => {}); throw new StorageFailure('async_migration_observer_forbidden');
            }
          }
        } else connection.exec(migration.sql);
        if (migration.version === 1 && options.intent === 'create') connection.prepare(`INSERT INTO database_instance VALUES(1,?,'notalone-sqlite-v1',?,?,?,0,'')`).run(databaseId, options.role, Date.now(), runtimeId);
        connection.prepare('INSERT INTO schema_migration VALUES(?,?,?)').run(migration.version, digest(migration.sql), Date.now());
        connection.exec(`PRAGMA user_version=${migration.version}`);
      }
      const epoch = get('SELECT epoch FROM database_instance WHERE slot=1')!.epoch as bigint;
      if (epoch >= 9223372036854775807n) throw new StorageFailure('epoch_exhausted');
      connection.prepare('UPDATE database_instance SET runtime_id=?,epoch=epoch+1,schema_digest=? WHERE slot=1').run(runtimeId, schemaDigest());
      // 普通重开只更新已核验的运行租约；实际升级仍在提交前检查变更后的全库。
      if (options.intent === 'create' || applied < registry.migrations.length) checks();
    });
  } finally {
    if (rebuildPending) {
      try {
        connection.exec('PRAGMA foreign_keys=ON');
        if (get('PRAGMA foreign_keys')?.foreign_keys !== 1n) throw new StorageFailure('foreign_keys_restore_failed');
      } catch (error) { connection.close(); db = undefined; throw error; }
    }
  }
  files.verify();
  const status = {databaseId, runtimeId, epoch: get('SELECT epoch FROM database_instance WHERE slot=1')!.epoch,
    role: options.role, schemaVersion: registry.migrations.length, sqliteVersion: get('SELECT sqlite_version() AS v')!.v};
  const assertLease = (lease: StorageLease) => {
    const current = get('SELECT database_id,runtime_id,epoch FROM database_instance WHERE slot=1');
    if (!current || !lease || lease.databaseId !== databaseId || lease.runtimeId !== runtimeId || lease.epoch !== status.epoch
      || current.runtime_id !== runtimeId || current.epoch !== status.epoch) throw new StorageFailure('stale_lease');
  };
  const actions = new Map(registry.actions.map(a => [a.name, a]));
  port.postMessage({value: status});
  port.on('message', ({id, name, input, lease}) => {
    // 串行队列等待不消耗动作预算；主线程收到开始确认后监督本次同步执行。
    const startedAt=Number(process.hrtime.bigint())/1e6;
    const respond=(value:Record<string,unknown>)=>port.postMessage({id,...value,startedAt,finishedAt:Number(process.hrtime.bigint())/1e6});
    port.postMessage({id, started: true, startedAt});
    try {
      if (name === 'storage.close') { connection.close(); respond({value: null}); port.close(); return; }
      files.verify();
      if (name === 'storage.check') { const value = transaction(false, () => { assertLease(lease); return checks(); }); assertLease(lease); respond({value}); return; }
      const action = actions.get(name);
      if (!action) throw new StorageFailure('action_unavailable');
      let result: unknown;
      for (let attempt = 0; ; attempt++) {
        try {
          const invoke = () => {
            assertLease(lease);
            let active = true;
            const permitted = () => { if (!active) throw new StorageFailure('transaction_expired'); };
            const maintenanceAllowed = () => { permitted(); files.verify(); assertLease(lease); };
            const maintenance: StorageMaintenance = {
              checkpoint() { maintenanceAllowed(); return get('PRAGMA wal_checkpoint(TRUNCATE)') as unknown as ReturnType<StorageMaintenance['checkpoint']>; },
              vacuum() { maintenanceAllowed(); connection.exec('VACUUM'); },
              check() { maintenanceAllowed(); return checks(); },
              inspect() { maintenanceAllowed(); return {freePages: get('PRAGMA freelist_count')!.freelist_count as bigint,
                tempStore: get('PRAGMA temp_store')!.temp_store as bigint, secureDelete: get('PRAGMA secure_delete')!.secure_delete as bigint,
                ...files.inspectSidecars()}; },
            };
            const tx: StorageTransaction = {
              run(sql, values = []) { permitted(); connection.prepare(sql).run(...bindings(values)); },
              get(sql, values) { permitted(); return get(sql, values); },
              all(sql, values) { permitted(); return all(sql, values); },
            };
            // 读动作在SQLite层禁止写入；同步接口退出后不能继续使用事务能力。
            if (action.mode === 'read') connection.exec('PRAGMA query_only=ON');
            try {
              const value = action.mode === 'maintenance' ? action.execute(maintenance, input, lease) : action.execute(tx, input, lease);
              if (value && typeof (value as Promise<unknown>).then === 'function') {
                void Promise.resolve(value).catch(() => {}); throw new StorageFailure('async_transaction_forbidden');
              }
              // 提交前确认结果可安全穿过Worker协议，避免已提交后才因序列化报失败。
              assertLease(lease);
              return structuredClone(value);
            } finally { active = false; if (action.mode === 'read') connection.exec('PRAGMA query_only=OFF'); }
          };
          // 维护动作只允许可信注册代码使用；调用者先排空领域写者，结果仍需复核。
          result = action.mode === 'maintenance' ? invoke() : transaction(action.mode === 'write', invoke);
          // WAL读事务内复核仍是旧快照；提交后新读提供返回前的租约检查点。
          if (action.mode === 'read') assertLease(lease);
          break;
        } catch (error) { if (code(error) !== 'storage_busy' || !action.retryBusy || attempt >= 2) throw error; }
      }
      respond({value: result});
    } catch (error) { respond({code: code(error)}); }
  });
} catch (error) { try { db?.close(); } catch {} port.postMessage({code: code(error)}); port.close(); }
