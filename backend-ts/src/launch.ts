import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile, rename, realpath, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { constants } from 'node:fs';
import { processIdentityState, type ProcessIdentity } from './platform/process/process-identity.ts';
import type { SqliteCapabilitiesConfiguration } from './sqlite-capabilities.ts';

export interface SqliteLaunchConfiguration extends SqliteCapabilitiesConfiguration {
  userData: string; expectedDatabaseId: string; role: 'test'; wechatCliPath?: string;
}
export interface LaunchConfiguration {
  nodeExecutable: string; projectDirectory: string; envFilePath: string; infoPath: string;
  businessHome: string; environment?: NodeJS.ProcessEnv; /** 唯一受支持的业务存储；旧 PG 启动路径已退役。 */
  sqlite: SqliteLaunchConfiguration;
}
export interface OwnedDshProcess {
  readonly pid: number;
  isRunning(): boolean;
  waitForExit(timeout: number): Promise<boolean>;
  terminate(): Promise<boolean>;
}
function alive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** 内核释放的短时互斥；端口碰撞只会失败关闭，不接管其他服务。 */
async function guarded<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
  const canonical = path.join(await realpath(path.dirname(lockPath)), path.basename(lockPath));
  const port = 16384 + createHash('sha256').update(canonical).digest().readUInt16BE(0) % 16384;
  for (let attempt = 0; attempt < 40; attempt++) {
    // 不提供网络协议；误连立即关闭，避免连接延迟互斥资源的释放。
    const server = createServer(socket => socket.destroy());
    server.unref();
    const acquired = await new Promise<boolean>((resolve,reject) => {
      server.once('error',error => (error as NodeJS.ErrnoException).code === 'EADDRINUSE' ? resolve(false) : reject(error));
      server.listen({host:'127.0.0.1',port,exclusive:true},()=>resolve(true));
    });
    if (!acquired) { await delay(25); continue; }
    try { return await operation(); }
    finally { await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve())); }
  }
  throw new Error('backend_already_running');
}
async function existingHandshake(infoPath: string): Promise<void> {
  let file;
  try {
    file = await open(infoPath, constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077) !== 0 || process.getuid && stat.uid !== process.getuid()) throw new Error('backend_connection_failed');
    const fields = Object.fromEntries((await file.readFile('utf8')).trim().split('\n').map(line=>{const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1)];}));
    if (!/^127\.0\.0\.1:[1-9]\d{0,4}$/.test(fields.address) || !/^[A-Za-z0-9_-]{1,256}$/.test(fields.token) || !/^[1-9]\d*$/.test(fields.pid) || !Number.isSafeInteger(Number(fields.pid))) throw new Error('backend_connection_failed');
    if (alive(Number(fields.pid))) throw new Error('backend_already_running');
    await rm(infoPath);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  finally { await file?.close(); }
}
async function atomicRecord(file: string, value: object): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
async function stopPid(identity: ProcessIdentity): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = await processIdentityState(identity);
    if (state === 'gone') return true;
    if (state === 'unknown') return false;
    await delay(100);
  }
  for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
    const state = await processIdentityState(identity);
    if (state === 'gone') return true;
    if (state !== 'same') return false;
    try { process.kill(identity.pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true; }
    for (let attempt = 0; attempt < 20; attempt++) {
      const observed = await processIdentityState(identity);
      if (observed === 'gone') return true;
      if (observed === 'unknown') return false;
      await delay(100);
    }
  }
  return await processIdentityState(identity) === 'gone';
}
/** 仅回收退役前遗留且可核验归属的进程，不提供旧执行器的启动或回退路径。 */
async function retiredProcessStopped(home: string, childPid: number | undefined, nonce: string): Promise<void> {
  let value;
  try { value = JSON.parse(await readFile(path.join(home, 'legacy.pid'), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw new Error('backend_cleanup_failed'); }
  if (!value || !Number.isSafeInteger(value.pid) || value.pid < 1 || value.parentPid !== childPid || value.nonce !== nonce) throw new Error('backend_cleanup_failed');
  if (value.identity?.pid !== value.pid || value.identity?.parentPid !== value.parentPid || !await stopPid(value.identity)) throw new Error('backend_cleanup_failed');
}

/** Electron 拥有临时 profile 和寿命管道；失败不自动启动另一种后台。 */
export async function launchDsh(config: LaunchConfiguration, canStart: () => boolean): Promise<OwnedDshProcess> {
  if (!canStart()) throw new Error('backend_connection_failed');
  for (const value of [config.nodeExecutable, config.projectDirectory, config.envFilePath, config.infoPath, config.businessHome]) {
    if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw new Error('backend_launch_unconfigured');
  }
  // 默认业务只有 SQLite 宿主；没有 sqlite 配置时不回退旧 PG 插件或 managed PostgreSQL。
  if (!config.sqlite || config.sqlite.role !== 'test' || config.sqlite.userData !== config.businessHome) throw new Error('backend_launch_requires_sqlite');
  const lockPath = `${config.infoPath}.dsh-lock`;
  await mkdir(path.dirname(config.infoPath), { recursive: true, mode: 0o700 });
  const nonce = randomUUID();
  await guarded(lockPath, async () => {
    if (!canStart()) throw new Error('backend_connection_failed');
    await existingHandshake(config.infoPath);
    try {
      const previous = JSON.parse(await readFile(lockPath, 'utf8'));
      if (!Number.isSafeInteger(previous.parentPid) || previous.parentPid < 1 || typeof previous.nonce !== 'string'
        || alive(previous.parentPid) || alive(previous.childPid)) throw new Error('backend_already_running');
      // 只清理含本轮所有权凭证的临时目录；其他路径不取得删除权限。
      if (typeof previous.home === 'string' && path.dirname(previous.home) === tmpdir() && path.basename(previous.home).startsWith('notalone-dsh-host-')) {
        try {
          const metadata = JSON.parse(await readFile(path.join(previous.home, 'host.json'), 'utf8'));
          if (metadata.lockNonce !== previous.nonce || metadata.parentPid !== previous.parentPid) throw new Error('backend_cleanup_failed');
          await retiredProcessStopped(previous.home, previous.childPid, previous.nonce);
          await rm(previous.home, { recursive: true, force: true });
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await atomicRecord(lockPath, {nonce, parentPid:process.pid});
  });
  let home: string | undefined;
  let child: ChildProcess | undefined;
  let releasePromise: Promise<void> | undefined;
  const release = (): Promise<void> => releasePromise ??= (async () => {
    if (home) await retiredProcessStopped(home, child?.pid, nonce);
    await guarded(lockPath, async () => {
      const record = JSON.parse(await readFile(lockPath, 'utf8'));
      if (record.nonce !== nonce) throw new Error('backend_cleanup_failed');
      // SIGKILL 无法运行插件的握手清理；只删除属于本次子进程的记录。
      if (child?.pid) {
        try {
          const handshake = await readFile(config.infoPath, 'utf8');
          const pid = /^pid=([0-9]+)$/m.exec(handshake);
          if (pid && Number(pid[1]) === child.pid) await rm(config.infoPath);
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      if (home) await rm(home, { recursive: true, force: true });
      await rm(lockPath);
    });
  })();
  let stopped: Promise<void> | undefined;
  try {
    home = await mkdtemp(path.join(tmpdir(), 'notalone-dsh-host-'));
    const profile = path.join(home, 'profiles/notalone');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(path.join(profile, 'package.json'), JSON.stringify({private:true,dsh:{profile:{bundles:[]}}}), {mode:0o600});
    const backend = path.join(config.projectDirectory, 'backend-ts');
    const patch = await readFile(path.join(backend, 'profile/sqlite.patch.yml'), 'utf8');
    const plugin = 'src/sqlite-host-plugin.ts';
    await writeFile(path.join(profile, 'cordis.patch.yml'), patch.replace('PLUGIN_PATH', JSON.stringify(path.join(backend, plugin))), {mode:0o600});
    const launch = { ...config, environment: undefined, home, parentPid: process.pid, lockNonce: nonce };
    await writeFile(path.join(home, 'host.json'), JSON.stringify(launch), {mode:0o600});
    await guarded(lockPath, () => atomicRecord(lockPath, { nonce, parentPid:process.pid, home }));
    if (!canStart()) throw new Error('backend_connection_failed');
    const environment: NodeJS.ProcessEnv = { PATH:process.env.PATH, USER:process.env.USER, LOGNAME:process.env.LOGNAME, HOME:home, DSH_HOME:home, DSH_TELEMETRY_DISABLED:'1', ELECTRON_RUN_AS_NODE:'1', NOTALONE_HOST_CONFIG:path.join(home,'host.json') };
    for (const [key,value] of Object.entries(config.environment ?? {})) {
      if (value !== undefined && (['LANG','LC_ALL','TZ','TMPDIR'].includes(key) || key.startsWith('NOTALONE_') && key !== 'NOTALONE_HOST_CONFIG')) environment[key] = value;
    }
    environment.NOTALONE_BACKEND_INFO = config.infoPath;
    environment.NOTALONE_ENV_FILE = config.envFilePath;
    child = spawn(config.nodeExecutable, [path.join(backend,'node_modules/@deepseek-ai/dsh/lib/bin.js'),'--profile','notalone'], {cwd:home, env:environment, stdio:['pipe','ignore','ignore']});
    const exited = new Promise<void>(resolve => { child!.once('error', resolve); child!.once('exit', resolve); });
    // 启动记录完成后才允许退出清理，避免快速退出与锁更新互相覆盖。
    let finishRecording!: () => void;
    const recording = new Promise<void>(resolve => { finishRecording = resolve; });
    stopped = exited.then(async () => { await recording; await release(); });
    void stopped.catch(() => {});
    try {
      await new Promise<void>((resolve,reject) => { child!.once('spawn',resolve); child!.once('error',reject); });
      await guarded(lockPath, () => atomicRecord(lockPath, {nonce,parentPid:process.pid,childPid:child!.pid,home}));
    } finally { finishRecording(); }
    return owned(child, stopped);
  } catch (error) {
    if (child && stopped) {
      const handle = owned(child, stopped);
      if (!await handle.terminate()) throw new Error('backend_cleanup_failed');
    } else await release();
    throw error;
  }
}
function owned(child: ChildProcess, stopped: Promise<void>): OwnedDshProcess {
  const running = () => child.pid !== undefined && child.exitCode === null && child.signalCode === null;
  const waitForExit = async (timeout: number): Promise<boolean> => {
    let timer: NodeJS.Timeout | undefined;
    try { return await Promise.race([stopped.then(() => true, () => false),new Promise<boolean>(resolve => { timer=setTimeout(()=>resolve(false),timeout); })]); }
    finally { clearTimeout(timer); }
  };
  return {pid:child.pid!, isRunning:running, waitForExit, async terminate() {
    if (running()) child.kill('SIGTERM');
    if (await waitForExit(11500)) return true;
    if (running()) child.kill('SIGKILL');
    return waitForExit(11500);
  }};
}
