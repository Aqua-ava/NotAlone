import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test as appTest, isolatedAppEnvironment } from './app-fixture';

const project = path.resolve('..');
type Prepared = { database_name: string; database_url: string; owner_id: string; contact_ids: string[]; other_contact_id: string; file_path: string };
type Operation = 'hold-extraction' | 'release-extraction' | 'fail-extraction' | 'hold-reply' | 'release-reply' | 'observations' | 'restart' | 'stop';

export class ImportFixture {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  readonly ready: Promise<Prepared>;
  data!: Prepared;
  constructor(readonly directory: string, readonly pythonExecutable: string, readonly child: ChildProcess) {
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('本轮导入 HTTP/PG 夹具启动超时。')), 70_000);
      child.on('exit', () => {
        clearTimeout(timer); reject(new Error('本轮导入夹具已退出。'));
        for (const command of this.pending.values()) command.reject(new Error('本轮导入夹具已退出。'));
        this.pending.clear();
      });
      createInterface({ input: child.stdout! }).on('line', (line) => {
        const value = JSON.parse(line) as { ready?: Prepared; id?: number; result: Record<string, unknown> };
        if (value.ready) { clearTimeout(timer); this.data = value.ready; resolve(value.ready); }
        else if (typeof value.id === 'number') { this.pending.get(value.id)?.resolve(value.result); this.pending.delete(value.id); }
      });
    });
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
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('本轮模型边界控制未完成。')); }, 5000);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.child.stdin!.write(`${JSON.stringify({ id, operation })}\n`);
    });
  }
  async request(endpoint: string, body?: object) {
    const info = await readFile(this.infoPath, 'utf8');
    const address = /^address=(127\.0\.0\.1:\d+)$/m.exec(info)?.[1];
    const token = /^token=([^\n]+)$/m.exec(info)?.[1];
    if (!address || !token) throw new Error('本轮导入握手未就绪。');
    const response = await fetch(`http://${address}${endpoint}`, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  }
  async task(imported: { contact_id: string; task_id: string }) {
    return this.request(`/api/tasks/status?contact_id=${imported.contact_id}&task_id=${imported.task_id}`);
  }
  async cleanup(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await this.command('release-extraction'); await this.command('release-reply'); await this.command('stop');
    }
    for (let count = 0; this.child.exitCode === null && this.child.signalCode === null && count < 100; count++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.child.exitCode !== 0) throw new Error('本轮导入夹具或测试库清理未确认。');
  }
}

export const test = appTest.extend<{ importBackend: ImportFixture }>({
  importBackend: async ({}, use) => {
    if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) throw new Error('导入验收须先激活 Conda NotAlone。');
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-import-app-'));
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
    finally { try { await fixture.cleanup(); } finally { await rm(directory, { recursive: true, force: true }); } }
  },
  appEnvironment: async ({ importBackend }, use) => { await use(importBackend.environment()); },
  launchConfiguration: async ({ importBackend }, use) => { await use({ pythonExecutable: importBackend.pythonExecutable,
    projectDirectory: project, envFilePath: importBackend.envPath, backendInfoPath: importBackend.infoPath }); },
});
