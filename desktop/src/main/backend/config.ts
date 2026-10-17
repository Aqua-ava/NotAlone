import { constants } from 'node:fs';
import { access, lstat, mkdir, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { BackendFailure } from './connection';
import type { StartupPaths } from '../../shared/startup-bridge';
import { resolveSyncProbePath } from './bundled-helpers';
import { managedLayout } from '../startup/managed-manifest';

const startupPathKeys = ['pythonExecutable', 'projectDirectory', 'envFilePath', 'backendInfoPath', 'wechatCliPath', 'syncProbePath'] as const;
const startupPathKeySet = new Set<string>(startupPathKeys);

function validStartupPath(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= 1024 && !/[\0\r\n]/.test(value)
    && (value === '' ? allowEmpty : path.isAbsolute(value));
}

export interface BackendConfiguration {
  // 仅本次受管 PG 监督器生成；不从磁盘配置或页面接受。
  managedLifetimeLock?: string;
  source?: 'external' | 'managed' | 'first-run';
  infoPath: string;
  envFilePath?: string;
  pythonExecutable?: string;
  projectDirectory?: string;
  wechatCliPath?: string;
  syncProbePath?: string;
}

// 本文件只有非秘密路径，由主进程读取；具名机器诊断桥接负责展示和保存。
export async function loadBackendConfiguration(userData: string, resourcesDirectory?: string): Promise<BackendConfiguration> {
  let value: Record<string, unknown> = {};
  let external = false;
  try {
    const configPath = path.join(userData, 'backend-launch.json');
    const file = await open(configPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let parsed: unknown;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 8192) throw new Error();
      const buffer = Buffer.alloc(8193);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 8192) throw new Error();
      parsed = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally { await file.close(); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    value = parsed as Record<string, unknown>;
    external = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BackendFailure('backend_connection_failed');
  }
  if (!external && resourcesDirectory) {
    let managed = false;
    try { await lstat(path.join(userData, 'managed/state.json')); managed = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BackendFailure('backend_connection_failed'); }
    const root = path.join(resourcesDirectory, 'notalone-runtime');
    return { source: managed ? 'managed' : 'first-run', infoPath: path.join(userData, 'managed/backend.info'),
      envFilePath: path.join(userData, 'managed/runtime.env'),
      ...(managed ? { pythonExecutable: path.join(root, managedLayout.python), projectDirectory: path.join(root, managedLayout.project) } : {}),
      wechatCliPath: managed ? undefined : process.env.NOTALONE_WECHAT_CLI,
      syncProbePath: await resolveSyncProbePath(resourcesDirectory, managed ? undefined : process.env.NOTALONE_SYNC_PROBE) };
  }
  for (const [key, selected] of Object.entries(value)) {
    if (!startupPathKeySet.has(key) || !validStartupPath(selected)) {
      throw new BackendFailure('backend_connection_failed');
    }
  }
  if (Boolean(value.pythonExecutable) !== Boolean(value.projectDirectory)) throw new BackendFailure('backend_connection_failed');
  const infoPath = value.backendInfoPath as string | undefined || process.env.NOTALONE_BACKEND_INFO || path.join(os.homedir(), '.notalone/backend.info');
  const envFilePath = value.envFilePath as string | undefined || process.env.NOTALONE_ENV_FILE;
  if (!path.isAbsolute(infoPath) || (envFilePath && !path.isAbsolute(envFilePath))) throw new BackendFailure('backend_connection_failed');
  return {
    source: 'external',
    infoPath, envFilePath,
    pythonExecutable: value.pythonExecutable as string | undefined,
    projectDirectory: value.projectDirectory as string | undefined,
    wechatCliPath: value.wechatCliPath as string | undefined || process.env.NOTALONE_WECHAT_CLI,
    syncProbePath: await resolveSyncProbePath(resourcesDirectory, value.syncProbePath as string | undefined || process.env.NOTALONE_SYNC_PROBE),
  };
}

export function configurationPaths(config: BackendConfiguration): StartupPaths {
  return {
    pythonExecutable: config.pythonExecutable || '', projectDirectory: config.projectDirectory || '',
    envFilePath: config.envFilePath || (config.projectDirectory ? path.join(config.projectDirectory, '.env') : ''),
    backendInfoPath: config.infoPath, wechatCliPath: config.wechatCliPath || '', syncProbePath: config.syncProbePath || '',
  };
}

export async function saveBackendConfiguration(userData: string, paths: unknown, canSave: () => boolean): Promise<void> {
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)
    || Object.keys(paths).length !== startupPathKeys.length) throw new Error('启动路径无效');
  const value = paths as Record<string, unknown>;
  for (const key of startupPathKeys) {
    if (!validStartupPath(value[key], key === 'wechatCliPath' || key === 'syncProbePath')) throw new Error('启动路径无效');
  }
  const output = Object.fromEntries(Object.entries(value).filter(([, selected]) => selected !== ''));
  if (!canSave()) throw new Error('启动配置暂时不可修改');
  await mkdir(userData, { recursive: true });
  const temporary = path.join(userData, `.backend-launch-${randomUUID()}.tmp`);
  try {
    if (!canSave()) throw new Error('启动配置暂时不可修改');
    await writeFile(temporary, JSON.stringify(output), { mode: 0o600, flag: 'wx' });
    if (!canSave()) throw new Error('启动配置暂时不可修改');
    await rename(temporary, path.join(userData, 'backend-launch.json'));
  } finally { await rm(temporary, { force: true }); }
}

export function backendEnvironment(config: BackendConfiguration, userData: string): NodeJS.ProcessEnv {
  if (config.source === 'managed') {
    // 只继承必要系统信息。开发机数据库、本人身份、模型密钥、代理和追踪不能抢过受管配置。
    const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8', LC_ALL: 'C',
      HOME: userData, TMPDIR: process.env.TMPDIR || '/tmp', PYTHONDONTWRITEBYTECODE: '1', PYTHONNOUSERSITE: '1',
      NOTALONE_BACKEND_INFO: config.infoPath, NOTALONE_ENV_FILE: config.envFilePath,
      NOTALONE_MANAGED_USER_DATA: userData,
      NOTALONE_WECHAT_CLI: path.join(userData, 'unconfigured-cli'),
      NOTALONE_SYNC_PROBE: config.syncProbePath || path.join(userData, 'unconfigured-probe'),
      NOTALONE_FOREGROUND_LAYOUT: path.join(userData, 'foreground-layout-profile.json') };
    if (process.env.TZ) environment.TZ = process.env.TZ;
    return environment;
  }
  const environment: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: path.join(config.projectDirectory!, 'backend/src'), PYTHONNOUSERSITE: '1',
    NOTALONE_MANAGED_USER_DATA: userData,
    NOTALONE_BACKEND_INFO: config.infoPath,
    NOTALONE_ENV_FILE: config.envFilePath || path.join(config.projectDirectory!, '.env'),
    NOTALONE_WECHAT_CLI: config.wechatCliPath || path.join(userData, 'unconfigured-cli'),
    NOTALONE_SYNC_PROBE: config.syncProbePath || path.join(userData, 'unconfigured-probe'),
    NOTALONE_FOREGROUND_LAYOUT: path.join(userData, 'foreground-layout-profile.json') };
  return environment;
}

export async function validateLaunchConfiguration(config: BackendConfiguration): Promise<{ pythonExecutable: string; projectDirectory: string }> {
  try {
    if (!config.pythonExecutable || !config.projectDirectory) throw new Error();
    const pythonExecutable = await realpath(config.pythonExecutable);
    const projectDirectory = await realpath(config.projectDirectory);
    await access(pythonExecutable, constants.X_OK);
    if (!(await stat(pythonExecutable)).isFile() || !(await stat(projectDirectory)).isDirectory()
      || !(await stat(path.join(projectDirectory, 'backend/src/notalone/server/command.py'))).isFile()) throw new Error();
    return { pythonExecutable, projectDirectory };
  } catch { throw new BackendFailure('backend_connection_failed'); }
}
