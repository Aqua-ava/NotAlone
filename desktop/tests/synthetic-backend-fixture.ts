import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isolatedAppEnvironment } from './isolated-environment';

const execute = promisify(execFile);
const project = path.resolve('..');

interface SyntheticBackend {
  startBackend(): Promise<unknown>;
  cleanup(): Promise<void>;
}
interface SyntheticBackendOptions<Data, Backend> {
  directoryPrefix: string;
  databaseScript: string;
  createArguments: string[];
  prepareTimeoutMs: number;
  reuseBackend: boolean;
  createFixture(directory: string, pythonExecutable: string, data: Data): Backend;
}

// 只统一本轮合成库与后端的准备、收尾；数据脚本、HTTP 和受限 App 启动仍由各自夹具负责。
export async function withSyntheticBackendFixture<Data extends { database_name: string }, Backend extends SyntheticBackend>(
  options: SyntheticBackendOptions<Data, Backend>, use: (fixture: Backend) => Promise<void>,
): Promise<void> {
  if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) {
    throw new Error('合成后端验收须先激活 Conda NotAlone。');
  }
  const directory = await mkdtemp(path.join(tmpdir(), options.directoryPrefix));
  const pythonExecutable = path.join(process.env.CONDA_PREFIX, 'bin/python');
  const env = isolatedAppEnvironment(directory, {
    PYTHONPATH: path.join(project, 'backend/src'), NOTALONE_DEEPSEEK_API_KEY: '',
  });
  let data: Data | undefined;
  let fixture: Backend | undefined;
  try {
    const prepared = await execute(pythonExecutable, [options.databaseScript, 'create', ...options.createArguments], {
      env, timeout: options.prepareTimeoutMs,
    });
    data = JSON.parse(prepared.stdout) as Data;
    fixture = options.createFixture(directory, pythonExecutable, data);
    if (options.reuseBackend) await fixture.startBackend();
    await use(fixture);
  } finally {
    try { await fixture?.cleanup(); }
    finally {
      try { if (data) await execute(pythonExecutable, [options.databaseScript, 'drop', data.database_name], { env, timeout: 15_000 }); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  }
}
