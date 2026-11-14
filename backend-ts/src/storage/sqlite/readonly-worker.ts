import {parentPort,workerData} from 'node:worker_threads';
import {SqlDiagnosticSummary,storageDiagnosticModule} from '../../diagnostics/sql-summary.ts';
import {DatabaseSync,type SQLInputValue} from 'node:sqlite';
import {loadRetrievalExtension} from '../../retrieval/sqlite/extension.ts';
import {statSync} from 'node:fs';
import {sha256} from '../../platform/sha256.ts';
import {controlledFiles} from './files.ts';
import {statementCache} from './statement-cache.ts';
import {registry as defaultRegistry} from './registry.ts';
import {StorageFailure,type StorageRegistry,type StorageTransaction} from './contracts.ts';
import type {ReadonlyWorkerOptions} from './readonly-client.ts';

const port=parentPort!,options=workerData as ReadonlyWorkerOptions;
const failureCode=(error:unknown):string=>{
  if(error instanceof StorageFailure)return error.code;
  const value=error as {code?:string;errcode?:number};
  if(value.code==='ENOENT')return 'storage_missing';
  if(value.errcode!==undefined&&(value.errcode&0xff)===5)return 'storage_busy';
  return 'storage_failed';
};
let connection:DatabaseSync|undefined;
try{
  const registry:StorageRegistry=options.registryModule?(await import(options.registryModule)).registry:defaultRegistry;
  const actions=new Map(registry.actions.map(action=>[action.name,action]));
  if(!Array.isArray(options.actions)||!options.actions.length||options.actions.some(name=>actions.get(name)?.mode!=='read'))throw new StorageFailure('readonly_action_forbidden');
  const allowed=new Set(options.actions),status=options.status;
  const files=controlledFiles(options.userData,false),identity=statSync(files.database);
  if(identity.dev!==options.fileIdentity.dev||identity.ino!==options.fileIdentity.ino)throw new StorageFailure('storage_identity_changed');
  connection=new DatabaseSync(files.database,{readOnly:true,enableForeignKeyConstraints:true,allowExtension:true,timeout:100});
  loadRetrievalExtension(connection);
  const db=connection;
  db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;');
  const prepared=statementCache(db);
  let sqlSummary:SqlDiagnosticSummary|undefined;
  const all=(sql:string,values:SQLInputValue[]=[]):Record<string,any>[]=>{
    if(values.some(value=>typeof value==='number'&&(!Number.isFinite(value)||Number.isInteger(value)&&!Number.isSafeInteger(value))))throw new StorageFailure('storage_value_invalid');
    return sqlSummary?sqlSummary.measure(sql,()=>prepared(sql).all(...values)):prepared(sql).all(...values);
  };
  const get=(sql:string,values:SQLInputValue[]=[])=>all(sql,values)[0];
  const schemaVersion=get('PRAGMA schema_version').schema_version;
  const assertLease=()=>{
    files.verify();
    const current=get('SELECT database_id,runtime_id,epoch,role,format_family,schema_digest FROM database_instance WHERE slot=1');
    if(!current||current.database_id!==status.databaseId||current.runtime_id!==status.runtimeId||current.epoch!==status.epoch||current.role!==status.role||current.format_family!=='notalone-sqlite-v1')throw new StorageFailure('stale_lease');
    if(get('PRAGMA user_version').user_version!==BigInt(status.schemaVersion)||get('PRAGMA schema_version').schema_version!==schemaVersion)throw new StorageFailure('schema_drift');
    return current;
  };
  const initial=assertLease();
  const actualDigest=sha256(JSON.stringify(all("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY type,name")));
  if(initial.schema_digest!==actualDigest)throw new StorageFailure('schema_drift');
  const ledger=all('SELECT version,checksum FROM schema_migration ORDER BY version');
  if(ledger.length!==status.schemaVersion||ledger.length!==registry.migrations.length||ledger.some((row,index)=>row.version!==BigInt(index+1)||row.checksum!==sha256(registry.migrations[index].sql)))throw new StorageFailure('migration_drift');
  assertLease();port.postMessage({ready:true});
  port.on('message',({id,name,input,traceId})=>{
    const safeTrace=typeof traceId==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(traceId)?traceId:undefined;
    sqlSummary=new SqlDiagnosticSummary(storageDiagnosticModule(name),'sqlite_readonly_worker',safeTrace);
    const respond=(value:Record<string,unknown>)=>{const diagnosticObservedAt=Date.now(),diagnosticObservedMonotonicNs=process.hrtime.bigint(),diagnostics=sqlSummary!.events();sqlSummary=undefined;port.postMessage({id,...value,diagnostics,diagnosticObservedAt,diagnosticObservedMonotonicNs});};
    try{
      const action=actions.get(name);
      if(!allowed.has(name)||action?.mode!=='read')throw new StorageFailure('readonly_action_forbidden');
      let active=true;
      const permitted=()=>{if(!active)throw new StorageFailure('transaction_expired');};
      const tx:StorageTransaction={runtimeGet(){permitted();return undefined;},runtimeSet(){permitted();throw new StorageFailure('readonly_write_forbidden');},runtimeDelete(){permitted();throw new StorageFailure('readonly_write_forbidden');},all(sql,values){permitted();return all(sql,values);},get(sql,values){permitted();return get(sql,values);},run(){permitted();throw new StorageFailure('readonly_write_forbidden');}};
      db.exec('BEGIN');let value:unknown;
      try{
        assertLease();value=action.execute(tx,input,{databaseId:status.databaseId,runtimeId:status.runtimeId,epoch:status.epoch});
        if(value&&typeof(value as Promise<unknown>).then==='function'){void Promise.resolve(value).catch(()=>{});throw new StorageFailure('async_transaction_forbidden');}
        value=structuredClone(value);db.exec('COMMIT');
      }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}finally{active=false;}
      // COMMIT 后重新读取，避免 WAL 事务旧快照掩盖主运行租约变化。
      assertLease();respond({value});
    }catch(error){respond({code:failureCode(error)});}
  });
}catch(error){try{connection?.close();}catch{}port.postMessage({code:failureCode(error)});port.close();}
