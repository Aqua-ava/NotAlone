import { constants } from 'node:fs';
import { access, mkdir, open, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { BackendFailure } from './connection';
import type { StartupPaths } from '../../shared/startup-bridge';
import { resolveSyncProbePath, resolveWechatCliRuntime } from './bundled-helpers';

const startupPathKeys = ['pythonExecutable', 'projectDirectory', 'envFilePath', 'backendInfoPath', 'wechatCliPath', 'syncProbePath'] as const;
const startupPathKeySet = new Set<string>(startupPathKeys);

function validStartupPath(value: unknown, allowEmpty = false): value is string {
  return typeof value === 'string' && value.length <= 1024 && !/[\0\r\n]/.test(value)
    && (value === '' ? allowEmpty : path.isAbsolute(value));
}

export interface BackendConfiguration {
  infoPath: string;
  envFilePath?: string;
  pythonExecutable?: string;
  projectDirectory?: string;
  wechatCliPath?: string;
  bundledWechatRuntime?: { wcdbLibraryPath?: string };
  syncProbePath?: string;
}

// 本文件只有非秘密路径，由主进程读取；具名机器诊断桥接负责展示和保存。
export async function loadBackendConfiguration(userData: string, resourcesDirectory?: string): Promise<BackendConfiguration> {
  let value: Record<string, unknown> = {};
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BackendFailure('backend_connection_failed');
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
  const wechatRuntime = await resolveWechatCliRuntime(resourcesDirectory, value.wechatCliPath as string | undefined || process.env.NOTALONE_WECHAT_CLI);
  return {
    infoPath, envFilePath,
    pythonExecutable: value.pythonExecutable as string | undefined,
    projectDirectory: value.projectDirectory as string | undefined,
    wechatCliPath: wechatRuntime.path,
    bundledWechatRuntime: wechatRuntime.bundled ? { wcdbLibraryPath: wechatRuntime.wcdbLibraryPath } : undefined,
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
  const environment: NodeJS.ProcessEnv = { ...process.env, PYTHONPATH: path.join(config.projectDirectory!, 'backend/src'), PYTHONNOUSERSITE: '1',
    NOTALONE_BACKEND_INFO: config.infoPath,
    NOTALONE_ENV_FILE: config.envFilePath || path.join(config.projectDirectory!, '.env'),
    NOTALONE_WECHAT_CLI: config.wechatCliPath || path.join(userData, 'unconfigured-cli'),
    NOTALONE_SYNC_PROBE: config.syncProbePath || path.join(userData, 'unconfigured-probe') };
  if (config.bundledWechatRuntime) {
    // 包内组只加载已核验WCDB，继承的显式库覆盖不能转向包外文件。
    for (const key of ['WECHAT_CLI_WCDB_LIB', 'WECHAT_CLI_WCDB_DYLIB', 'WX_MCP_WCDB_LIB', 'WX_MCP_WCDB_DYLIB']) delete environment[key];
    if (config.bundledWechatRuntime.wcdbLibraryPath) environment.WECHAT_CLI_WCDB_LIB = config.bundledWechatRuntime.wcdbLibraryPath;
  }
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
