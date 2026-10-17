import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { backendEnvironment, loadBackendConfiguration, type BackendConfiguration } from '../backend/config';
import type { StartupCode, StartupState } from '../../shared/startup-bridge';
import { verifyManagedComponents, type ManagedComponents } from './managed-manifest';

type ManagedState = { formatVersion: 1; password: string; bootstrapComplete: boolean };
export class ManagedRuntimeFailure extends Error { constructor(readonly code: StartupCode) { super(code); } }

export class ManagedRuntime {
  private database: ChildProcess | undefined;
  private databaseLifetimeLock: string | undefined;
  private operation: ChildProcess | undefined;
  private generation = 0;
  private components: ManagedComponents | undefined;
  private starting: Promise<void> | undefined;
  private stopping: Promise<boolean> | undefined;

  constructor(private readonly userData: string, private readonly resourcesDirectory: string | undefined,
    private readonly progress: (step: StartupState['step']) => void) {}

  async prepare(allowed: () => boolean): Promise<void> {
    const generation = this.generation;
    const canStart = () => generation === this.generation && allowed();
    const components = await this.verified(canStart);
    if (!canStart()) throw new ManagedRuntimeFailure('runtime_cancelled');
    // 外置配置不能被“新安装”入口覆盖，损坏配置同样保留给恢复流程。
    if (await exists(path.join(this.userData, 'backend-launch.json'))) throw new ManagedRuntimeFailure('configuration_invalid');
    await mkdir(this.userData, { recursive: true });
    const directory = path.join(this.userData, 'managed');
    await mkdir(directory, { mode: 0o700, recursive: true });
    await assertPrivateDirectory(directory);
    if (await exists(path.join(directory, 'state.json'))) { await this.readState(); return; }
    if ((await readdir(directory)).length) throw new ManagedRuntimeFailure('runtime_configuration_invalid');
    if (!canStart()) throw new ManagedRuntimeFailure('runtime_cancelled');
    await this.writeState({ formatVersion: 1, password: randomBytes(32).toString('hex'), bootstrapComplete: false });
    this.components = components;
  }

  start(config: BackendConfiguration, canStart: () => boolean): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this.startRuntime(config, canStart).finally(() => { this.starting = undefined; });
    return this.starting;
  }

  cancel(): void {
    ++this.generation;
    if (this.operation?.pid && running(this.operation)) {
      try { process.kill(-this.operation.pid, 'SIGTERM'); } catch { /* 本次进程组已经退场。 */ }
    }
  }

  async stop(): Promise<boolean> {
    if (this.stopping) return this.stopping;
    this.cancel();
    this.stopping = this.stopRuntime().finally(() => { this.stopping = undefined; });
    return this.stopping;
  }

  private async startRuntime(config: BackendConfiguration, allowed: () => boolean): Promise<void> {
    const generation = this.generation;
    const canStart = () => generation === this.generation && allowed();
    const components = await this.verified(canStart);
    const state = await this.readState();
    const importMarker = path.join(this.userData, 'managed/import-pending.json');
    if (await exists(importMarker)
      && await privateText(importMarker, 128) !== '{"formatVersion":1,"verified":true}') throw new ManagedRuntimeFailure('runtime_configuration_invalid');
    const cluster = path.join(this.userData, 'managed/postgres');
    const environment = backendEnvironment(config, this.userData);
    if (!canStart()) throw new ManagedRuntimeFailure('runtime_cancelled');
    if (!await exists(path.join(cluster, 'PG_VERSION'))) {
      if (state.bootstrapComplete || await exists(cluster)) throw new ManagedRuntimeFailure('runtime_configuration_invalid');
      this.progress('preparing-data');
      const passwordFile = path.join(this.userData, 'managed', `.password-${randomUUID()}`);
      const preparingCluster = path.join(this.userData, 'managed', `.postgres-${randomUUID()}`);
      await writeFile(passwordFile, `${state.password}\n`, { mode: 0o600, flag: 'wx' });
      try {
        await this.run(path.join(components.postgres, 'initdb'), ['-D', preparingCluster, '--username=notalone', '--encoding=UTF8', '--locale=C',
          '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', `--pwfile=${passwordFile}`, '--no-instructions'], environment, canStart, 'database_prepare_failed', 60_000);
        if (!canStart()) throw new ManagedRuntimeFailure('runtime_cancelled');
        await rename(preparingCluster, cluster);
      } finally {
        await rm(passwordFile, { force: true });
        // 尚未向业务后台开放的、本次自建 initdb 暂存目录不包含用户资料。
        await rm(preparingCluster, { recursive: true, force: true });
      }
    }
    await assertPrivateDirectory(cluster);
    if ((await privateText(path.join(cluster, 'PG_VERSION'), 128)).trim() !== '16') throw new ManagedRuntimeFailure('runtime_configuration_invalid');
    if (!this.database || !running(this.database)) {
      // PostgreSQL 自己核验现有锁与崩溃遗留；App 不据未知 PID 接管或终止进程。
      const hadLock = await exists(path.join(cluster, 'postmaster.pid'));
      this.progress('starting-database');
      // 上次App的监督器可能正在认证停读后的收尾；等待锁自然释放，不操作其PID。
      const previousDeadline = Date.now() + 12_000;
      while (canStart() && await exists(path.join(cluster, 'postmaster.pid')) && Date.now() < previousDeadline) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!canStart()) throw new ManagedRuntimeFailure('runtime_cancelled');
      // 遗留锁是否仍有效由PostgreSQL核验；App不删除锁，也不据此终止进程。
      const port = await unusedPort();
      if (!canStart()) throw new ManagedRuntimeFailure('runtime_cancelled');
      this.databaseLifetimeLock = path.join(this.userData, 'managed', `.postgres-lifetime-${randomUUID()}`);
      const database = spawn(components.python, ['-I', '-B', '-m', 'notalone.managed_postgres',
        '--postgres', path.join(components.postgres, 'postgres'), '--data-directory', cluster, '--port', String(port),
        '--parent-pid', String(process.pid), '--lifetime-lock', this.databaseLifetimeLock],
      { cwd: path.join(this.userData, 'managed'), env: environment, stdio: ['pipe', 'pipe', 'ignore'] });
      this.database = database;
      const postgresPid = await new Promise<number>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new ManagedRuntimeFailure('database_start_failed')), 5000);
        const fail = () => { clearTimeout(timer); reject(new ManagedRuntimeFailure('database_start_failed')); };
        database.once('error', fail); database.once('exit', fail);
        database.stdout!.on('data', (chunk: Buffer) => {
          output += chunk.toString('utf8');
          if (output.length > 128) { fail(); return; }
          if (!output.includes('\n')) return;
          try {
            const value = JSON.parse(output);
            if (!Number.isSafeInteger(value.pid) || value.pid <= 1 || Object.keys(value).length !== 1) throw new Error();
            clearTimeout(timer); resolve(value.pid);
          } catch { fail(); }
        });
      });
      const deadline = Date.now() + 15_000;
      let ready = false;
      while (canStart() && running(database) && Date.now() < deadline) {
        try {
          await this.run(path.join(components.postgres, 'pg_isready'), ['-h', '127.0.0.1', '-p', String(port), '-t', '1'], environment, canStart, 'database_start_failed', 2000);
          const lock = (await privateText(path.join(cluster, 'postmaster.pid'), 4096)).split('\n');
          if (Number(lock[0]) !== postgresPid || Number(lock[3]) !== port) throw new Error();
          ready = true; break;
        } catch { if (!canStart()) break; }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!ready) throw new ManagedRuntimeFailure(!canStart() ? 'runtime_cancelled' : hadLock ? 'database_already_running' : 'database_start_failed');
      const databaseUrl = `postgresql://notalone:${state.password}@127.0.0.1:${port}/notalone`;
      await this.writeEnvironment(databaseUrl, canStart);
    }
    config.managedLifetimeLock = this.databaseLifetimeLock;
    if (!state.bootstrapComplete) {
      this.progress('preparing-database');
      // 只有尚未开放本人/联系人功能的本次新环境可以续接首次迁移。
      const current = await loadBackendConfiguration(this.userData, this.resourcesDirectory);
      const childEnvironment = backendEnvironment(current, this.userData);
      const values = await privateText(path.join(this.userData, 'managed/runtime.env'), 65_536);
      const databaseUrl = /^NOTALONE_DATABASE_URL=(.+)$/m.exec(values)?.[1];
      if (!databaseUrl) throw new ManagedRuntimeFailure('runtime_configuration_invalid');
      const connection = new URL(databaseUrl);
      const pgEnvironment = { ...childEnvironment, PGPASSWORD: state.password, PGHOST: '127.0.0.1', PGPORT: connection.port, PGUSER: 'notalone' };
      const found = await this.run(path.join(components.postgres, 'psql'), ['-X', '--no-password', '-d', 'postgres', '-At', '-c', "SELECT 1 FROM pg_database WHERE datname='notalone'"],
        pgEnvironment, canStart, 'database_prepare_failed', 10_000, true);
      if (found.trim() !== '1') await this.run(path.join(components.postgres, 'psql'), ['-X', '--no-password', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c', 'CREATE DATABASE notalone'],
        pgEnvironment, canStart, 'database_prepare_failed', 10_000);
      await this.run(components.python, ['-I', '-B', '-m', 'notalone.startup_database', '--migrations', path.join(components.project, 'backend/database/migrations')],
        { ...childEnvironment, NOTALONE_DATABASE_URL: databaseUrl }, canStart, 'database_prepare_failed', 60_000);
      if (!canStart()) throw new ManagedRuntimeFailure('runtime_cancelled');
      await this.writeState({ ...state, bootstrapComplete: true });
    }
  }

  private async verified(canStart: () => boolean): Promise<ManagedComponents> {
    if (this.components) return this.components;
    this.progress('checking-components');
    try { return this.components = await verifyManagedComponents(this.resourcesDirectory, canStart); }
    catch { throw new ManagedRuntimeFailure(canStart() ? 'runtime_components_unavailable' : 'runtime_cancelled'); }
  }

  private async readState(): Promise<ManagedState> {
    await assertPrivateDirectory(path.join(this.userData, 'managed'));
    try {
      const value = JSON.parse(await privateText(path.join(this.userData, 'managed/state.json'), 4096));
      if (!value || value.formatVersion !== 1 || typeof value.password !== 'string' || !/^[a-f0-9]{64}$/.test(value.password)
        || typeof value.bootstrapComplete !== 'boolean' || Object.keys(value).length !== 3) throw new Error();
      return value;
    } catch { throw new ManagedRuntimeFailure('runtime_configuration_invalid'); }
  }
  private async writeState(state: ManagedState): Promise<void> {
    await atomicPrivateWrite(path.join(this.userData, 'managed/state.json'), JSON.stringify(state));
  }
  private async writeEnvironment(databaseUrl: string, canStart: () => boolean): Promise<void> {
    const file = path.join(this.userData, 'managed/runtime.env');
    const existing = await exists(file) ? await privateText(file, 65_536) : '';
    const lines = existing.split('\n').filter(line => !/^\s*(?:export\s+)?NOTALONE_DATABASE_URL\s*=/.test(line));
    if (!canStart()) throw new ManagedRuntimeFailure('runtime_cancelled');
    await atomicPrivateWrite(file, `NOTALONE_DATABASE_URL=${databaseUrl}\n${lines.join('\n')}`);
  }

  private async run(executable: string, args: string[], environment: NodeJS.ProcessEnv, canStart: () => boolean,
    code: StartupCode, timeout: number, capture = false): Promise<string> {
    if (!canStart()) throw new ManagedRuntimeFailure('runtime_cancelled');
    const child = spawn(executable, args, { cwd: path.join(this.userData, 'managed'), env: environment, detached: true,
      stdio: ['ignore', capture ? 'pipe' : 'ignore', 'ignore'] });
    this.operation = child;
    return new Promise((resolve, reject) => {
      let output = ''; let interrupted = false; let settled = false;
      const signal = (value: NodeJS.Signals) => {
        try { if (child.pid) process.kill(-child.pid, value); } catch { /* 只回收本次 spawn 的进程组；已退场不再处理。 */ }
      };
      let killTimer: NodeJS.Timeout | undefined;
      const stop = () => {
        if (interrupted) return;
        interrupted = true; signal('SIGTERM'); killTimer = setTimeout(() => signal('SIGKILL'), 1000);
      };
      const timer = setTimeout(stop, timeout);
      const cancellation = setInterval(() => { if (!canStart()) stop(); }, 100);
      const finish = async (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer); clearTimeout(killTimer); clearInterval(cancellation);
        // initdb 会派生 bootstrap postgres；主命令退场不等于整个自有命令组已收尾。
        if (child.pid && !await stopCommandGroup(child.pid)) error = new ManagedRuntimeFailure('runtime_configuration_invalid');
        if (this.operation === child) this.operation = undefined;
        if (error) reject(error); else resolve(output);
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        if (Buffer.byteLength(output) + chunk.length > 4096) { stop(); return; }
        output += chunk.toString('utf8');
      });
      child.once('error', () => void finish(new ManagedRuntimeFailure(code)));
      child.once('close', (exitCode) => void finish(exitCode === 0 && !interrupted && canStart() ? undefined
        : new ManagedRuntimeFailure(canStart() ? code : 'runtime_cancelled')));
    });
  }

  private async stopRuntime(): Promise<boolean> {
    await this.starting?.catch(() => {});
    const database = this.database;
    if (!database || !running(database)) { this.database = undefined; return true; }
    // 业务后台必须先认证停读，PG 的 fast shutdown 再结束自己的会话与子进程。
    database.kill('SIGINT');
    const exited = await waitForExit(database, 10_000);
    if (exited) this.database = undefined;
    return exited;
  }
}

async function exists(selected: string): Promise<boolean> {
  try { await lstat(selected); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
async function assertPrivateDirectory(selected: string): Promise<void> {
  const metadata = await lstat(selected);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
    || process.getuid && metadata.uid !== process.getuid()) throw new ManagedRuntimeFailure('runtime_configuration_invalid');
  const parent = await realpath(path.dirname(selected));
  if (await realpath(selected) !== path.join(parent, path.basename(selected))) throw new ManagedRuntimeFailure('runtime_configuration_invalid');
}
async function privateText(selected: string, limit: number): Promise<string> {
  const file = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > limit || (metadata.mode & 0o077) !== 0
      || process.getuid && metadata.uid !== process.getuid()) throw new ManagedRuntimeFailure('runtime_configuration_invalid');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}
async function atomicPrivateWrite(selected: string, value: string): Promise<void> {
  const temporary = path.join(path.dirname(selected), `.runtime-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await rename(temporary, selected);
    await chmod(selected, 0o600);
  } finally { await rm(temporary, { force: true }); }
}
function running(child: ChildProcess): boolean { return child.exitCode === null && child.signalCode === null; }
async function waitForExit(child: ChildProcess, timeout: number): Promise<boolean> {
  if (!running(child)) return true;
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([new Promise<boolean>(resolve => child.once('exit', () => resolve(true))),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeout); })]); }
  finally { clearTimeout(timer); }
}
async function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => {
        if (error || !address || typeof address === 'string') reject(new ManagedRuntimeFailure('database_start_failed'));
        else resolve(address.port);
      });
    });
  });
}

async function stopCommandGroup(pid: number): Promise<boolean> {
  const exists = () => { try { process.kill(-pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
  if (!exists()) return true;
  try { process.kill(-pid, 'SIGTERM'); } catch { /* 同一自有命令组可能已自行退出。 */ }
  const deadline = Date.now() + 1000;
  while (exists() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (!exists()) return true;
  try { process.kill(-pid, 'SIGKILL'); } catch { /* 不触碰其他进程组。 */ }
  const killedDeadline = Date.now() + 1000;
  while (exists() && Date.now() < killedDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  return !exists();
}
