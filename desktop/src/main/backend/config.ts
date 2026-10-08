import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BackendFailure } from './connection';

export interface BackendConfiguration {
  infoPath: string;
  envFilePath?: string;
  pythonExecutable?: string;
  projectDirectory?: string;
}

// 本文件只有非秘密路径，由主进程读取；后续机器诊断负责选择和保存。
export async function loadBackendConfiguration(userData: string): Promise<BackendConfiguration> {
  let value: Record<string, unknown> = {};
  try {
    const configPath = path.join(userData, 'backend-launch.json');
    if ((await stat(configPath)).size > 8192) throw new Error();
    const parsed: unknown = JSON.parse(await readFile(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    value = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new BackendFailure('backend_connection_failed');
  }
  const keys = ['pythonExecutable', 'projectDirectory', 'envFilePath', 'backendInfoPath'];
  for (const [key, selected] of Object.entries(value)) {
    if (!keys.includes(key) || typeof selected !== 'string' || !path.isAbsolute(selected) || selected.includes('\0')) {
      throw new BackendFailure('backend_connection_failed');
    }
  }
  if (Boolean(value.pythonExecutable) !== Boolean(value.projectDirectory)) throw new BackendFailure('backend_connection_failed');
  const infoPath = process.env.NOTALONE_BACKEND_INFO || value.backendInfoPath as string | undefined || path.join(os.homedir(), '.notalone/backend.info');
  const envFilePath = process.env.NOTALONE_ENV_FILE || value.envFilePath as string | undefined;
  if (!path.isAbsolute(infoPath) || (envFilePath && !path.isAbsolute(envFilePath))) throw new BackendFailure('backend_connection_failed');
  return {
    infoPath, envFilePath,
    pythonExecutable: value.pythonExecutable as string | undefined,
    projectDirectory: value.projectDirectory as string | undefined,
  };
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
