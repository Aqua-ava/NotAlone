/** 沿原连接执行受信任 SQL；不创建数据库、备份或替代库。 */
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type pg from 'pg';
import {HostStorage,HostStorageError,connectionFields,connectionOptions,connectConfigured} from './host-storage.ts';
import {upgradeSkillBusinessState} from './schema-skill-upgrade.ts';

export interface SchemaPrepareOptions {databaseUrl:string;migrationsDirectory:string;environment?:NodeJS.ProcessEnv}
export interface SchemaPrepareResult {code:string;applied:string[]}
interface Migration {name:string;checksum:string;body:string}
async function migrationsAt(directory:string):Promise<Migration[]> {
 const names=(await readdir(directory)).filter(name=>name.endsWith('.sql')).sort();
 if(!names.length||names.some((name,i)=>!new RegExp(`^${String(i+1).padStart(3,'0')}_[a-z0-9_]+\\.sql$`).test(name)))throw new HostStorageError('migration_files_invalid');
 return Promise.all(names.map(async name=>{
  const bytes=await readFile(join(directory,name));const lines=new TextDecoder('utf-8',{fatal:true}).decode(bytes).trim().split(/\r?\n/);
  while(lines.length&&(!lines[0].trim()||lines[0].trimStart().startsWith('--')))lines.shift();
  while(lines.length&&(!lines.at(-1)!.trim()||lines.at(-1)!.trimStart().startsWith('--')))lines.pop();
  let body=lines.join('\n').trim();if(body.startsWith('BEGIN;')&&body.endsWith('COMMIT;'))body=body.slice(6,-7).trim();
  return {name,checksum:createHash('sha256').update(bytes).digest('hex'),body};
 }));
}
async function readiness(options:SchemaPrepareOptions,environment:NodeJS.ProcessEnv):Promise<string>{
 const storage=await HostStorage.open({envFilePath:'',migrationsDirectory:options.migrationsDirectory,environment:{...environment,NOTALONE_DISABLE_DOTENV:'1',NOTALONE_DATABASE_URL:options.databaseUrl}});
 try{return (await storage.compatibility()).code;}finally{await storage.close();}
}
function localTarget(databaseUrl:string,environment:NodeJS.ProcessEnv):void{
 const fields=connectionFields(databaseUrl),host=fields.host||environment.PGHOST||'',address=fields.hostaddr||environment.PGHOSTADDR||'',name=fields.dbname||environment.PGDATABASE||'';
 if(!['','localhost','127.0.0.1','::1'].includes(host)&&!host.startsWith('/')||!['','127.0.0.1','::1'].includes(address)
   ||'service'in fields||'options'in fields||environment.PGSERVICE||environment.PGOPTIONS||['','postgres','template0','template1'].includes(name))throw new HostStorageError('database_update_requires_local');
}
async function applyMigrations(client:pg.Client,migrations:Migration[],environment:NodeJS.ProcessEnv):Promise<string[]> {
 const baseline=(await client.query("SELECT to_regclass('public.notalone_schema_baseline') AS name")).rows[0].name;
 let offset=0;
 if(baseline){
  const rows=(await client.query('SELECT format_version,through_version,manifest,backup_sha256,restore_verified_at FROM public.notalone_schema_baseline')).rows;
  const row=rows[0];
  if(rows.length!==1||row.format_version!==1||row.through_version!==35||row.backup_sha256==null||row.restore_verified_at==null
   ||JSON.stringify(row.manifest?.map((item:Record<string,unknown>)=>({name:item.name,checksum:item.checksum})))!==JSON.stringify(migrations.slice(0,35).map(({name,checksum})=>({name,checksum}))))throw new HostStorageError('baseline_invalid');
  offset=35;
 }
 const ledger=(await client.query("SELECT to_regclass('public.notalone_schema_migration') AS name")).rows[0].name;
 if(!ledger){
  if((await client.query("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')) AS present")).rows[0].present)throw new HostStorageError('baseline_missing');
  await client.query('CREATE TABLE public.notalone_schema_migration(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
 }
 const completed=(await client.query('SELECT name,checksum FROM public.notalone_schema_migration ORDER BY name')).rows;
 if(completed.some((row,i)=>row.name!==migrations[i+offset]?.name||row.checksum!==migrations[i+offset]?.checksum))throw new HostStorageError('migration_history_mismatch');
 const applied:string[]=[];
 for(const migration of migrations.slice(offset+completed.length)){
  await client.query('BEGIN');
  try{
   if(migration.name==='103_skill_business_state_only.sql')await upgradeSkillBusinessState(client,environment);
   // 动态执行禁止 SQL 文件自行提交，保证本版本和账本原子提交。
   const nonce=randomUUID().replaceAll('-',''),tag=`$migration_${nonce}$`,bodyTag=`$sql_${nonce}$`;
   await client.query(`DO ${tag} BEGIN EXECUTE ${bodyTag}${migration.body}${bodyTag}; END ${tag};`);
   await client.query('INSERT INTO public.notalone_schema_migration(name,checksum) VALUES($1,$2)',[migration.name,migration.checksum]);
   await client.query('COMMIT');applied.push(migration.name);
  }catch{await client.query('ROLLBACK').catch(()=>{});throw new HostStorageError('migration_failed');}
 }
 return applied;
}
export async function prepareDatabaseSchema(options:SchemaPrepareOptions):Promise<SchemaPrepareResult>{
 const environment={...(options.environment??process.env)};let client:pg.Client|undefined;
 try{
  const code=await readiness(options,environment);if(code!=='migration_pending')return {code,applied:[]};
  localTarget(options.databaseUrl,environment);
  const migrations=await migrationsAt(options.migrationsDirectory);
  client=await connectConfigured(await connectionOptions(options.databaseUrl,{...environment,PGAPPNAME:'notalone_schema_startup'}));
  await client.query('SET search_path = pg_catalog, public');await client.query("SET lock_timeout = '10s'");
  if(!(await client.query('SELECT pg_try_advisory_lock(1852798049,1) AS acquired')).rows[0].acquired)return {code:'migration_busy',applied:[]};
  const checked=await readiness(options,environment);if(checked!=='migration_pending')return {code:checked,applied:[]};
  if((await client.query("SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend') AS present")).rows[0].present)return {code:'database_writers_present',applied:[]};
  const applied=await applyMigrations(client,migrations,environment);await client.end();client=undefined;
  return {code:await readiness(options,environment),applied};
 }catch(error){return {code:error instanceof HostStorageError?error.code:'database_unavailable',applied:[]};}
 finally{await client?.end().catch(()=>{});}
}
