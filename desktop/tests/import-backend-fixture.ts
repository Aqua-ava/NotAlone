import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isolatedAppEnvironment } from './isolated-environment';
import { FixtureTransport, requestFixtureHttp } from './fixture-transport';

const project = path.resolve('..');
type Prepared = { database_name: string; database_url: string; owner_id: string; contact_ids: string[]; other_contact_id: string; file_path: string };
type Operation = 'hold-extraction' | 'prepare-priority-import' | 'release-active-extraction' | 'observe-next-extraction'
  | 'release-extraction' | 'fail-extraction' | 'hold-reply' | 'release-reply' | 'observations' | 'restart' | 'stop';

export class ImportFixture {
  private readonly transport: FixtureTransport<Prepared>;
  readonly ready: Promise<Prepared>;
  data!: Prepared;
  constructor(readonly directory: string, readonly pythonExecutable: string, readonly child: ChildProcess) {
    this.transport = new FixtureTransport<Prepared>(child, '导入');
    this.ready = this.transport.ready.then((data) => { this.data = data; return data; });
  }
  get infoPath(): string { return path.join(this.directory, 'backend.info'); }
  get envPath(): string { return path.join(this.directory, 'synthetic.env'); }
  environment(): NodeJS.ProcessEnv {
    return { NOTALONE_BACKEND_INFO: this.infoPath, NOTALONE_ENV_FILE: this.envPath,
      NOTALONE_DATABASE_URL: this.data.database_url, NOTALONE_OWNER_ID: this.data.owner_id,
      NOTALONE_DEEPSEEK_API_KEY: '', NOTALONE_DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
      LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false',
      NOTALONE_WECHAT_CLI: path.join(this.directory, 'unavailable-cli'), NOTALONE_SYNC_PROBE: path.join(this.directory, 'unavailable-probe'),
      PYTHONPATH: `${path.join(project, 'backend/src')}:${path.join(project, 'backend')}`, PYTHONNOUSERSITE: '1' };
  }
  command(operation: Operation): Promise<Record<string, unknown>> {
    return this.transport.command(operation);
  }
  async request(endpoint: string, body?: object) {
    return requestFixtureHttp(this.infoPath, endpoint, body);
  }
  async task(imported: { contact_id: string; task_id: string }) {
    return this.request(`/api/tasks/status?contact_id=${imported.contact_id}&task_id=${imported.task_id}`);
  }
  async cleanup(): Promise<void> {
    let failure: unknown;
    try {
      if (this.child.exitCode === null && this.child.signalCode === null) {
        await this.command('release-extraction'); await this.command('release-reply'); await this.command('stop');
      }
    } catch (error) { failure = error; }
    finally {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.stdin?.end();
    }
    for (let count = 0; this.child.exitCode === null && this.child.signalCode === null && count < 100; count++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (failure || this.child.exitCode !== 0) throw new Error('本轮导入夹具或测试库清理未确认。');
  }
}

// App 与普通页面复用真实导入夹具；资源登记由调用方负责。
export async function withImportFixture(directoryPrefix: string, use: (fixture: ImportFixture) => Promise<void>,
  cleanupConfirmed?: () => void): Promise<void> {
  if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) throw new Error('导入验收须先激活 Conda NotAlone。');
  const directory = await mkdtemp(path.join(tmpdir(), directoryPrefix));
  const pythonExecutable = path.join(process.env.CONDA_PREFIX, 'bin/python');
  const child = spawn(pythonExecutable, [path.join(project, 'desktop/tests/fixtures/import_backend.py')], {
    cwd: project, stdio: ['pipe', 'pipe', 'ignore'], env: isolatedAppEnvironment(directory, {
      PYTHONPATH: `${path.join(project, 'backend/src')}:${path.join(project, 'backend')}`, PYTHONNOUSERSITE: '1',
      NOTALONE_DEEPSEEK_API_KEY: '', NOTALONE_DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
      LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false',
    }),
  });
  const fixture = new ImportFixture(directory, pythonExecutable, child);
  try { await fixture.ready; await use(fixture); }
  finally {
    try {
      await fixture.cleanup();
      await rm(directory, { recursive: true, force: true });
      cleanupConfirmed?.();
    } catch {
      await writeFile(path.join(directory, 'cleanup-unconfirmed.json'), JSON.stringify({
        childPid: child.pid ?? null, exitCode: child.exitCode, signal: child.signalCode,
        databaseName: fixture.data?.database_name ?? null,
      }), { mode: 0o600 });
      throw new Error(`本轮导入夹具收尾未确认，保留归属记录：${directory}`);
    }
  }
}
