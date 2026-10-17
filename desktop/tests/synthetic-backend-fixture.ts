import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isolatedAppEnvironment } from './isolated-environment';
import { archiveFixtureEvidence, confirmDatabaseAbsent, readDatabaseOwnership, readPlannedDatabaseOwnership } from './database-ownership';

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
    NOTALONE_TEST_DATABASE_URL: '',
  });
  let data: Data | undefined;
  let fixture: Backend | undefined;
  let prepareStopped = false;
  let failure: unknown;
  let prepareOutput: { stdout?: string | Buffer; stderr?: string | Buffer } | undefined;
  const ownershipPath = path.join(directory, 'database-ownership.json');
  try {
    let prepared;
    try {
      prepared = await execute(pythonExecutable, [options.databaseScript, 'create', ...options.createArguments, ownershipPath], {
        env, timeout: options.prepareTimeoutMs,
      });
      prepareOutput = prepared;
      prepareStopped = true;
    } catch (error) {
      prepareOutput = error as typeof prepareOutput;
      // execFile 已观测退出时才可继续精确清理；超时或信号退出仍保留证据。
      prepareStopped = typeof (error as { code?: unknown }).code === 'number'
        && !(error as { killed?: boolean }).killed && !(error as { signal?: unknown }).signal;
      throw error;
    }
    data = JSON.parse(prepared.stdout) as Data;
    if (await readDatabaseOwnership(directory, 'contact') !== data.database_name) throw new Error('本轮准备回执与落盘库名不一致。');
    fixture = options.createFixture(directory, pythonExecutable, data);
    if (options.reuseBackend) await fixture.startBackend();
    await use(fixture);
  } catch (error) { failure = error; }
  try {
    if (!prepareStopped) throw new Error('本轮准备进程退出未确认。');
    await fixture?.cleanup();
    const databaseName = await readDatabaseOwnership(directory, 'contact');
    if (data && databaseName !== data.database_name) throw new Error('本轮清理库名与准备回执不一致。');
    await execute(pythonExecutable, [options.databaseScript, 'drop', databaseName], { env, timeout: 15_000 });
    await confirmDatabaseAbsent(pythonExecutable, env, databaseName);
    await rm(directory, { recursive: true });
  } catch (cleanupError) {
    const createdName = await readDatabaseOwnership(directory, 'contact').catch(() => undefined);
    const plannedName = createdName ? undefined : await readPlannedDatabaseOwnership(directory).catch(() => undefined);
    const databaseName = createdName ?? plannedName ?? data?.database_name ?? null;
    const ownershipPhase = createdName ? 'created' : plannedName ? 'planned' : null;
    const cleanupAuthorized = prepareStopped && createdName !== undefined && (!data || createdName === data.database_name);
    await writeFile(path.join(directory, 'cleanup-unconfirmed.json'), JSON.stringify({
      prepareStopped, databaseName, ownershipPath, ownershipPhase, cleanupAuthorized,
      cleanupError: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
    }), { mode: 0o600 });
    const evidence = await archiveFixtureEvidence(directory, '合成后端准备或收尾失败', {
      'original.stdout': Buffer.from(prepareOutput?.stdout ?? ''),
      'original.stderr': Buffer.from(prepareOutput?.stderr ?? ''),
    }, { prepareStopped, databaseName, ownershipPhase, cleanupAuthorized }).catch(() => undefined);
    throw new Error(`合成后端收尾未确认，保留本轮归属：${directory}${evidence ? `；原始证据：${evidence}` : '；原始输出封存未确认'}`,
      { cause: failure ?? cleanupError });
  }
  if (failure) throw failure;
}
