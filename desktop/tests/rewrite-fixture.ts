import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { test as appTest, isolatedAppEnvironment } from './app-fixture';

const project = path.resolve('..');
type Prepared = { database_url: string; owner_id: string; contact_ids: string[]; other_contact_id: string };
export type ModelPlan = { count?: number; risk_notes?: string[]; prefix?: string; fault?: 'timeout' | 'failure'; probe_history?: boolean };

export class RewriteFixture {
  private nextId = 0;
  private readonly pending = new Map<number, (value: Record<string, unknown>) => void>();
  readonly ready: Promise<Prepared>;
  data!: Prepared;
  constructor(readonly directory: string, readonly pythonExecutable: string, readonly child: ChildProcess) {
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('本轮改写 HTTP/PG 夹具启动超时。')), 70_000);
      child.on('exit', () => { clearTimeout(timer); reject(new Error('本轮改写夹具提前退出。')); });
      const lines = createInterface({ input: child.stdout! });
      lines.on('line', (line) => {
        const value = JSON.parse(line) as { ready?: Prepared; id?: number; result: Record<string, unknown> };
        if (value.ready) { clearTimeout(timer); this.data = value.ready; resolve(value.ready); }
        else if (typeof value.id === 'number') { this.pending.get(value.id)?.(value.result); this.pending.delete(value.id); }
      });
    });
  }
  get infoPath(): string { return path.join(this.directory, 'backend.info'); }
  get envPath(): string { return path.join(this.directory, 'synthetic.env'); }
  environment(): NodeJS.ProcessEnv {
    return { NOTALONE_BACKEND_INFO: this.infoPath, NOTALONE_ENV_FILE: this.envPath,
      NOTALONE_DATABASE_URL: this.data.database_url, NOTALONE_OWNER_ID: this.data.owner_id,
      NOTALONE_DEEPSEEK_API_KEY: '', NOTALONE_DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
      NOTALONE_WECHAT_CLI: path.join(this.directory, 'unavailable-cli'),
      NOTALONE_SYNC_PROBE: path.join(this.directory, 'unavailable-probe'),
      PYTHONPATH: `${path.join(project, 'backend/src')}:${path.join(project, 'backend')}`, PYTHONNOUSERSITE: '1' };
  }
  command(operation: string, extra: object = {}): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('本轮模型边界控制未完成。')); }, 5000);
      this.pending.set(id, (value) => { clearTimeout(timer); resolve(value); });
      this.child.stdin!.write(`${JSON.stringify({ id, operation, ...extra })}\n`);
    });
  }
  plan(plan: ModelPlan = {}): Promise<unknown> { return this.command('plan', { plan }); }
  async request(endpoint: string, body?: object) {
    const info = await readFile(this.infoPath, 'utf8');
    const address = /^address=(127\.0\.0\.1:\d+)$/m.exec(info)?.[1];
    const token = /^token=([^\n]+)$/m.exec(info)?.[1];
    if (!address || !token) throw new Error('本轮改写握手未就绪。');
    const response = await fetch(`http://${address}${endpoint}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  }
  async cleanup(): Promise<void> {
    if (this.child.exitCode === null && this.child.signalCode === null) await this.command('stop');
    for (let count = 0; this.child.exitCode === null && this.child.signalCode === null && count < 100; count++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (this.child.exitCode !== 0) throw new Error('本轮改写夹具或测试库未正常清理。');
  }
}

export const test = appTest.extend<{ rewriteBackend: RewriteFixture }>({
  rewriteBackend: async ({}, use) => {
    if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) throw new Error('改写验收须先激活 Conda NotAlone。');
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-rewrite-'));
    const pythonExecutable = path.join(process.env.CONDA_PREFIX, 'bin/python');
    const child = spawn(pythonExecutable, [path.join(project, 'desktop/tests/fixtures/rewrite-backend.py')], {
      cwd: project, stdio: ['pipe', 'pipe', 'ignore'], env: isolatedAppEnvironment(directory, {
        PYTHONPATH: `${path.join(project, 'backend/src')}:${path.join(project, 'backend')}`, PYTHONNOUSERSITE: '1',
        NOTALONE_DEEPSEEK_API_KEY: '', NOTALONE_DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
      }),
    });
    const fixture = new RewriteFixture(directory, pythonExecutable, child);
    try { await fixture.ready; await use(fixture); }
    finally {
      try { await fixture.cleanup(); }
      finally { await rm(directory, { recursive: true, force: true }); }
    }
  },
  appEnvironment: async ({ rewriteBackend }, use) => { await use(rewriteBackend.environment()); },
  launchConfiguration: async ({ rewriteBackend }, use) => {
    await use({ pythonExecutable: rewriteBackend.pythonExecutable, projectDirectory: project,
      envFilePath: rewriteBackend.envPath, backendInfoPath: rewriteBackend.infoPath });
  },
});
