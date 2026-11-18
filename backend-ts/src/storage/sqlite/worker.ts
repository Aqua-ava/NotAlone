import {DiagnosticBuffer,diagnosticOverflow} from '../../diagnostics/buffer.mjs';
import {installManagementBatching} from '../../memory/sqlite/management/batching.ts';
import {loadRetrievalExtension} from '../../retrieval/sqlite/extension.ts';
import {installRetrievalIndexMaintenance} from '../../retrieval/sqlite/text-index.ts';
import {retrievalIndexMigration} from '../../retrieval/sqlite/schema.ts';
import {checkedDiagnosticEvent,type DiagnosticEvent} from '../../diagnostics/unified-contract.mjs';
import {SqlDiagnosticSummary,storageDiagnosticModule} from '../../diagnostics/sql-summary.ts';
import {memoryManagementBatchingMigration} from '../../memory/sqlite/management/batching-schema.ts';
import {historicalDeletionEquivalences,retiredDeletionOperations} from './migrations/history-retirement-v1.ts';
import { parentPort, workerData } from 'node:worker_threads';
import { statSync } from 'node:fs';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../../platform/sha256.ts';
import { controlledFiles } from './files.ts';
import { statementCache } from './statement-cache.ts';
import { ContinuityDiagnosticLog } from './continuity-diagnostic-log.ts';
import { registry as defaultRegistry } from './registry.ts';
import { memoryAdjudicationMigration, memoryAdjudicationRebuildPolicy, memoryAdjudicationRebuildChecksum, memoryAdjudicationUpgradeSteps } from '../../memory/sqlite/management/adjudication-schema.ts';
import { memoryDocumentsMigration, memoryDocumentsRebuildPolicy, memoryDocumentsRebuildChecksum, memoryDocumentsUpgradeSteps } from '../../memory/sqlite/documents/schema.ts';
import { StorageFailure, type OpenStorageOptions, type StorageRegistry, type StorageTransaction, type StorageLease, type StorageMaintenance, type StorageDiagnostic } from './contracts.ts';

const port = parentPort!;
const options = workerData as OpenStorageOptions;
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
        && migration.sql === memoryAdjudicationMigration(12).sql && sha256(migration.sql) === memoryAdjudicationRebuildChecksum
        || migration.rebuild === memoryDocumentsRebuildPolicy && migration.version === 13
        && migration.sql === memoryDocumentsMigration(13).sql && sha256(migration.sql) === memoryDocumentsRebuildChecksum;
      if (!allowed) throw new StorageFailure('migration_rebuild_forbidden');
    }
  }
  const files = controlledFiles(options.userData, options.intent === 'create');
  // 上一个会话的退出状态：最后一个连接干净 close 时 SQLite 会删除 -wal/-shm；只要残留其一，就说明上次存在被强杀或崩溃的连接。
  // 必须在打开自身连接之前采样，避免把本次会话产生的旁路文件误判为上次残留；只判存在性，不读内容也不改文件。
  const priorExitResidue = options.intent === 'open' && ['-wal', '-shm'].some(suffix => {
    try { statSync(files.database + suffix); return true; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; return false; }
  });
  db = new DatabaseSync(files.database, { enableForeignKeyConstraints: true, allowExtension: true, timeout: 100 });
  loadRetrievalExtension(db);
  const connection = db;
  // 结构迁移为既有删除目标重建固定摘要；不接受扩展模块或任意脚本。
  connection.function('notalone_sha256',{deterministic:true},value=>{
    if(typeof value!=='string'||value.length>1024*1024)throw new StorageFailure('storage_value_invalid');
    return sha256(value);
  });
  connection.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA temp_store=MEMORY;');
  const bindings = (values: SQLInputValue[]) => {
    if (values.some(v => typeof v === 'number' && (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))))) throw new StorageFailure('storage_value_invalid');
    return values;
  };
  // 同一条 SQL 反复执行（如核验链上的上千次小查询）时复用预编译语句。
  const prepared = statementCache(connection);
  let sqlSummary:SqlDiagnosticSummary|undefined;
  const measured=<T>(sql:string,work:()=>T):T=>sqlSummary?sqlSummary.measure(sql,work):work();
  const all = (sql: string, values: SQLInputValue[] = []) => measured(sql,()=>prepared(sql).all(...bindings(values)));
  const get = (sql: string, values: SQLInputValue[] = []) => all(sql, values)[0];
  const schemaDigest = () => sha256(JSON.stringify(all("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name")));
  // quick_check 不核对索引内容与 UNIQUE，大库约快一半；打开路径（升级、非WAL转换、残留补检）用 quick，
  // create、显式 check() 与维护校验仍做完整 integrity_check。普通重开不再触发任何全库扫描。
  const checks = (quick = false) => {
    const pragma = quick ? 'quick_check' : 'integrity_check';
    if (all(`PRAGMA ${pragma}`).some(r => r[pragma] !== 'ok')) throw new StorageFailure('integrity_failed');
    if (all('PRAGMA foreign_key_check').length) throw new StorageFailure('foreign_keys_failed');
    return {integrity: 'ok', foreignKeys: 'ok'} as const;
  };
  // 固定v1函数只供迁移47校验旧审计；不读取外部数据，也不写业务行。
  connection.function('notalone_history_deletion_equivalences_v1',()=>JSON.stringify(historicalDeletionEquivalences({get,all})));
  connection.function('notalone_history_retired_deletion_operations_v1',()=>JSON.stringify(retiredDeletionOperations({get,all})));
  const transaction = <T>(write: boolean, fn: () => T): T => {
    connection.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try { const result = fn(); connection.exec('COMMIT'); return result; }
    catch (error) { if (connection.isTransaction) connection.exec('ROLLBACK'); throw error; }
  };
  const verifyExisting = () => {
    // 先核验固定身份与结构；需要全库完整性检查的情形由打开分支按条件决定，不属这里。
    const instance = get('SELECT * FROM database_instance WHERE slot=1');
    if (!instance || instance.database_id !== options.expectedDatabaseId || instance.role !== options.role
      || instance.format_family !== 'notalone-sqlite-v1') throw new StorageFailure('instance_mismatch');
    if (instance.schema_digest !== schemaDigest()) throw new StorageFailure('schema_drift');
    const ledger = all('SELECT version,checksum FROM schema_migration ORDER BY version');
    if (ledger.length > registry.migrations.length) throw new StorageFailure('schema_too_new');
    if (get('PRAGMA user_version')?.user_version !== BigInt(ledger.length)
      || ledger.some((m, i) => m.version !== BigInt(i + 1) || m.checksum !== sha256(registry.migrations[i].sql))) throw new StorageFailure('migration_drift');
  };
  if (options.intent === 'open') verifyExisting();
  const initiallyApplied = options.intent === 'create' ? 0 : Number(get('SELECT COUNT(*) AS n FROM schema_migration')!.n);
  let journal = get('PRAGMA journal_mode');
  const openingWal = journal?.journal_mode === 'wal';
  if (!openingWal) {
    // 已有非WAL库转换前仍完整核验，不能让损坏库先产生配置写入。
    if (options.intent === 'open') checks(true);
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
      // 普通重开只核验身份与结构，不再同步扫描全库；升级、非WAL转换与上次
      // 非正常退出（打开前采样的 -wal/-shm 残留）才在提交前补一次快速检查。
      if (options.intent === 'open') {
        verifyExisting();
        if (initiallyApplied < registry.migrations.length || !openingWal || priorExitResidue) checks(true);
      }
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
        connection.prepare('INSERT INTO schema_migration VALUES(?,?,?)').run(migration.version, sha256(migration.sql), Date.now());
        connection.exec(`PRAGMA user_version=${migration.version}`);
      }
      const epoch = get('SELECT epoch FROM database_instance WHERE slot=1')!.epoch as bigint;
      if (epoch >= 9223372036854775807n) throw new StorageFailure('epoch_exhausted');
      connection.prepare('UPDATE database_instance SET runtime_id=?,epoch=epoch+1,schema_digest=? WHERE slot=1').run(runtimeId, schemaDigest());
      // 普通重开只更新已核验的运行租约（补检已在提交前完成，普通重开不再扫描全库）；
      // 实际升级仍在提交前检查变更后的全库。
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
  const managementBatching=registry.migrations.some(migration=>migration.sql===memoryManagementBatchingMigration(50).sql)?installManagementBatching(connection):undefined;
  const retrievalIndex=registry.migrations.some(migration=>migration.sql===retrievalIndexMigration(56).sql)?installRetrievalIndexMaintenance(connection):undefined;
  files.verify();
  const status = {databaseId, runtimeId, epoch: get('SELECT epoch FROM database_instance WHERE slot=1')!.epoch,
    role: options.role, schemaVersion: registry.migrations.length, sqliteVersion: get('SELECT sqlite_version() AS v')!.v};
  const assertLease = (lease: StorageLease) => {
    const current = get('SELECT database_id,runtime_id,epoch FROM database_instance WHERE slot=1');
    if (!current || !lease || lease.databaseId !== databaseId || lease.runtimeId !== runtimeId || lease.epoch !== status.epoch
      || current.runtime_id !== runtimeId || current.epoch !== status.epoch) throw new StorageFailure('stale_lease');
  };
  const diagnosticLog=new ContinuityDiagnosticLog(options.userData);
  let diagnosticWarning=false;
  const warnDiagnostic=()=>{if(!diagnosticWarning){diagnosticWarning=true;console.error('history_continuity_diagnostic_unavailable');}};
  try{diagnosticLog.prune();}catch{warnDiagnostic();}
  const actions = new Map(registry.actions.map(a => [a.name, a]));
  const runtimeValues=new Map<string,unknown>();
  const removedRuntimeValue=Symbol('removed-runtime-value');
  port.postMessage({value: status});
  port.on('message', ({id, name, input, lease,traceId}) => {
    // 串行队列等待不消耗动作预算；主线程收到开始确认后监督本次同步执行。
    const startedAt=Number(process.hrtime.bigint())/1e6;
    const safeTrace=typeof traceId==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(traceId)?traceId:undefined;
    sqlSummary=new SqlDiagnosticSummary(storageDiagnosticModule(name),'sqlite_worker',safeTrace);
    let diagnosticObservation:{diagnosticObservedAt:number;diagnosticObservedMonotonicNs:bigint}|undefined;
    const respond=(value:Record<string,unknown>)=>{const diagnostics=[...(Array.isArray(value.diagnostics)?value.diagnostics:[]),...sqlSummary!.events()];sqlSummary=undefined;port.postMessage({id,...value,diagnostics,...(diagnosticObservation??{diagnosticObservedAt:Date.now(),diagnosticObservedMonotonicNs:process.hrtime.bigint()}),startedAt,finishedAt:Number(process.hrtime.bigint())/1e6});};
    // 开始确认带上动作模式：主线程据此选择执行预算，维护动作与普通动作不共用15秒上限。
    port.postMessage({id, started: true, startedAt, maintenance: actions.get(name)?.mode === 'maintenance'});
    try {
      if (name === 'storage.close') { connection.close(); respond({value: null}); port.close(); return; }
      files.verify();
      if (name === 'storage.check') { const value = transaction(false, () => { assertLease(lease); return checks(); }); assertLease(lease); respond({value}); return; }
      // 仅删除协调器的有效 runner 可按持久范围清理日志；不接收任意路径或联系人前缀。
      if(name==='storage.eraseContinuityDiagnostics'){
        assertLease(lease);
        const op=get('SELECT scope_kind,contact_identity,runner_token,runner_runtime,plan_revision,state FROM deletion_operation WHERE owner_identity=? AND operation_id=?',[input.ownerId,input.operationId]);
        if(!op||op.runner_token!==input.token||op.runner_runtime!==runtimeId||op.plan_revision!==input.planRevision||op.state==='completed')throw new StorageFailure('deletion_stale_runner');
        let contactPrefixes:string[]=[];
        if(op.scope_kind==='account'){
          diagnosticLog.erase();
          // 身份墓碑仍保留稳定ID；只投影前缀，已清正文不重新读取。
          if(get("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='contact'"))contactPrefixes=all('SELECT DISTINCT substr(id,1,8) AS prefix FROM contact WHERE owner_id=?',[input.ownerId]).map(row=>String(row.prefix)).filter(prefix=>/^[a-f0-9]{8}$/.test(prefix));
        }
        else if(op.scope_kind==='contact'&&typeof op.contact_identity==='string'){
          const prefix=op.contact_identity.slice(0,8);
          // 通用删除注册表允许短合成身份；日志从未接纳非八位十六进制前缀，无对应记录可清理。
          if(/^[a-f0-9]{8}$/.test(prefix)){diagnosticLog.erase(prefix);contactPrefixes=[prefix];}
        }
        else throw new StorageFailure('deletion_scope_invalid');
        assertLease(lease);respond({value:{kind:op.scope_kind,contactPrefixes}});return;
      }
      const action = actions.get(name);
      if (!action) throw new StorageFailure('action_unavailable');
      let result: unknown;
      let committedDiagnostics:DiagnosticEvent[]=[];
      for (let attempt = 0; ; attempt++) {
        const diagnostics:StorageDiagnostic[]=[];
        const unifiedDiagnostics=new DiagnosticBuffer();
        const runtimeOverlay=new Map<string,unknown>();
        try {
          managementBatching?.begin();
          retrievalIndex?.begin();
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
            const runtimeKey=(namespace:string,key:string)=>{
              permitted();
              if(namespace!=='history-source-guard'||typeof key!=='string'||!key||key.length>1024||/[\u0000-\u001f\u007f]/.test(key))throw new StorageFailure('runtime_state_invalid');
              return JSON.stringify([namespace,key]);
            };
            const runtimeMutation=(namespace:string,key:string,value:unknown)=>{
              const scoped=runtimeKey(namespace,key);
              if(action.mode!=='write')throw new StorageFailure('runtime_transaction_invalid');
              runtimeOverlay.set(scoped,value===removedRuntimeValue?value:structuredClone(value));
            };
            const tx: StorageTransaction = {
              flushDerived(){permitted();managementBatching?.flush();retrievalIndex?.flush();},
              runtimeGet<T>(namespace:string,key:string):T|undefined {
                const scoped=runtimeKey(namespace,key),value=runtimeOverlay.has(scoped)?runtimeOverlay.get(scoped):runtimeValues.get(scoped);
                return value===removedRuntimeValue?undefined:structuredClone(value) as T|undefined;
              },
              runtimeSet(namespace,key,value){runtimeMutation(namespace,key,value);},
              runtimeDelete(namespace,key){runtimeMutation(namespace,key,removedRuntimeValue);},
              recordDiagnostic(event) {
                permitted();
                if(action.mode!=='write'||diagnostics.length>=1024)throw new StorageFailure('diagnostic_transaction_invalid');
                diagnostics.push(structuredClone(event));
              },
              recordUnifiedDiagnostic(event) {
                try{if(!active)return;const safe=checkedDiagnosticEvent(event);if(safe)unifiedDiagnostics.push(safe);}catch{}
              },
              run(sql, values = []) { permitted(); measured(sql,()=>prepared(sql).run(...bindings(values))); },
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
              managementBatching?.flush();
              retrievalIndex?.flush();
              // 提交前确认结果可安全穿过Worker协议，避免已提交后才因序列化报失败。
              assertLease(lease);
              return structuredClone(value);
            } finally { active = false; if (action.mode === 'read') connection.exec('PRAGMA query_only=OFF'); }
          };
          // 维护动作只允许可信注册代码使用；调用者先排空领域写者，结果仍需复核。
          result = action.mode === 'maintenance' ? invoke() : transaction(action.mode === 'write', invoke);
          // COMMIT/读取已返回才观察；传输与宿主排队延迟不能把旧事件改成清除后的新事件。
          diagnosticObservation={diagnosticObservedAt:Date.now(),diagnosticObservedMonotonicNs:process.hrtime.bigint()};
          // WAL读事务内复核仍是旧快照；提交后新读提供返回前的租约检查点。
          if (action.mode === 'read') assertLease(lease);
          // 本次尝试的SQL和结果复制均已成功；发布只含Map操作，失败或busy重试不留易失状态。
          for(const [key,value] of runtimeOverlay){if(value===removedRuntimeValue)runtimeValues.delete(key);else runtimeValues.set(key,value);}
          // 事务已提交才落盘；诊断不可用不能反转已写围栏或改为允许读取。
          for(const event of diagnostics)try{
            diagnosticLog.append({entry:name,contactPrefix:event.contactPrefix,branch:event.branch,...(event.errorCode?{errorCode:event.errorCode}:{})});
          }catch{warnDiagnostic();}
          for(const event of diagnostics){const safe=checkedDiagnosticEvent({event:'sync.continuity',caller:'sqlite_worker',reasonCode:event.branch,contactPrefix:event.contactPrefix});if(safe)unifiedDiagnostics.push(safe);}
          const batch=unifiedDiagnostics.take();committedDiagnostics=[...batch.items,...batch.notices,...(batch.dropped?[diagnosticOverflow('diagnostic_transaction',batch.dropped,safeTrace)]:[])];
          break;
        } catch (error) { if (code(error) !== 'storage_busy' || !action.retryBusy || attempt >= 2) throw error; }
      }
      respond({value: result,diagnostics:committedDiagnostics});
    } catch (error) { respond({code: code(error)}); }
  });
} catch (error) { try { db?.close(); } catch {} port.postMessage({code: code(error)}); port.close(); }
