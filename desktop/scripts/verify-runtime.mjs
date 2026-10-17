import { cp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { inspectManagedRuntime } from './managed-runtime.mjs';

const run = promisify(execFile), args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--runtime-directory' || args[2] !== '--report-directory' ||
  !path.isAbsolute(args[1]) || !path.isAbsolute(args[3])) throw new Error('runtime_verify_arguments');
const [runtime, report] = [args[1], args[3]];
await inspectManagedRuntime(runtime); await mkdir(report, {mode:0o700});
const relocated = path.join(report,'relocated runtime'); let database; let server;
const results = { scope:'isolated-runtime-tools', relocated:false, isolatedImport:false, migrations:false, migrationCount:0, backupRestore:false, stopped:false,
  cleanMachine:false, app:false, wechat:false };
try {
  await cp(runtime, relocated, {recursive:true,verbatimSymlinks:true}); await inspectManagedRuntime(relocated); results.relocated=true;
  const environment = {PATH:'/usr/bin:/bin',HOME:report,TMPDIR:report,LANG:'en_US.UTF-8',PYTHONDONTWRITEBYTECODE:'1'};
  const python=path.join(relocated,'python/bin/python3.12'), pg=path.join(relocated,'postgres/bin');
  const execute = async (file,values,extra={}) => run(file,values,{env:{...environment,...extra},cwd:report,timeout:60_000,maxBuffer:2*1024*1024});
  await execute(python,['-I','-B','-c','import notalone.server.command,deepagents,psycopg,yaml; print("portable_import")']); results.isolatedImport=true;
  const password=randomBytes(24).toString('hex'), pwfile=path.join(report,'pg-password');
  await writeFile(pwfile,password,{mode:0o600}); database=path.join(report,'database');
  await execute(path.join(pg,'initdb'),['-D',database,'-U','notalone','--pwfile',pwfile,'--auth-local=scram-sha-256','--auth-host=scram-sha-256','--locale=C','--encoding=UTF8']);
  await rm(pwfile);
  const port = await new Promise((resolve,reject)=>{const socket=createServer();socket.on('error',reject);socket.listen(0,'127.0.0.1',()=>{const selected=socket.address().port;socket.close(()=>resolve(selected));});});
  const passfile=path.join(report,'pgpass'); await writeFile(passfile,`127.0.0.1:${port}:*:notalone:${password}\n`,{mode:0o600});
  const pgEnvironment={...environment,PGPASSFILE:passfile,PGHOST:'127.0.0.1',PGPORT:String(port),PGUSER:'notalone'};
  server=spawn(path.join(pg,'postgres'),['-D',database,'-h','127.0.0.1','-p',String(port),'-k','','-c','max_connections=10','-c','shared_buffers=16MB'],{cwd:report,env:environment,stdio:'ignore'});
  let ready=false;
  for(let i=0;i<100;i++) {try {await execute(path.join(pg,'pg_isready'),['-h','127.0.0.1','-p',String(port),'-U','notalone']);ready=true;break;}catch{if(server.exitCode!==null)throw new Error('runtime_postgres_exited');await new Promise((resolve)=>setTimeout(resolve,100));}}
  if(!ready)throw new Error('runtime_postgres_timeout');
  const pgRun=async(name,values)=>run(path.join(pg,name),values,{cwd:report,env:pgEnvironment,timeout:60_000,maxBuffer:2*1024*1024});
  await pgRun('createdb',['runtime_source']);
  const migration=path.join(relocated,'project/backend/database/migrations');
  const dbUrl=(name)=>`postgresql://notalone:${password}@127.0.0.1:${port}/${name}`;
  const migrate=JSON.parse((await execute(python,['-I','-B','-m','notalone.database_migrations','--migrations',migration],{NOTALONE_DATABASE_URL:dbUrl('runtime_source')})).stdout);
  const expectedMigrations=(await readdir(migration,{withFileTypes:true})).filter(entry=>entry.isFile()&&entry.name.endsWith('.sql')).map(entry=>entry.name).sort();
  if(!expectedMigrations.length||migrate.status!=='succeeded'||!Array.isArray(migrate.applied)||JSON.stringify(migrate.applied)!==JSON.stringify(expectedMigrations))throw new Error('runtime_migrations_incomplete');
  results.migrationCount=expectedMigrations.length;
  const diagnose=async(name)=>JSON.parse((await execute(python,['-I','-B','-m','notalone.startup_diagnostics','--migrations',migration],{NOTALONE_DATABASE_URL:dbUrl(name)})).stdout).code;
  if(await diagnose('runtime_source')!=='ready')throw new Error('runtime_migrations_not_ready'); results.migrations=true;
  await pgRun('psql',['-d','runtime_source','-v','ON_ERROR_STOP=1','-c',"CREATE TABLE public.runtime_portability_probe(value text); INSERT INTO public.runtime_portability_probe VALUES ('synthetic_runtime_2026');"]);
  const backup=path.join(report,'synthetic-backup.dump'); await pgRun('pg_dump',['-Fc','-d','runtime_source','-f',backup]);
  await pgRun('createdb',['runtime_restored']); await pgRun('pg_restore',['--exit-on-error','--no-owner','-d','runtime_restored',backup]);
  const restored=await pgRun('psql',['-d','runtime_restored','-At','-c','SELECT value FROM public.runtime_portability_probe']);
  if(restored.stdout.trim()!=='synthetic_runtime_2026'||await diagnose('runtime_restored')!=='ready')throw new Error('runtime_restore_mismatch'); results.backupRestore=true;
  await pgRun('pg_ctl',['-D',database,'-m','fast','-w','stop']);
  await new Promise((resolve)=>{if(server.exitCode!==null||server.signalCode!==null)resolve();else server.once('exit',resolve);});results.stopped=true;
} finally {
  if(server&&server.exitCode===null&&server.signalCode===null) {server.kill('SIGINT');await new Promise((resolve)=>{const timeout=setTimeout(()=>{server.kill('SIGKILL');resolve();},5000);server.once('exit',()=>{clearTimeout(timeout);resolve();});});}
  // 留下固定结果，不保留合成数据库、凭据或搬动副本。
  for(const name of ['relocated runtime','database','pgpass','pg-password','synthetic-backup.dump'])await rm(path.join(report,name),{recursive:true,force:true});
  await writeFile(path.join(report,'result.json'),JSON.stringify(results,null,2)+'\n',{mode:0o600});
}
if(!results.stopped)throw new Error('runtime_verification_incomplete');
console.log(`独立工具验证通过：搬动、隔离导入、${results.migrationCount}次生产迁移、真实备份恢复、停止及清理。`);
console.log('此结果不证明真正无开发环境的机器或公开App、微信验收。');
