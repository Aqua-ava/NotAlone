import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test as appTest, isolatedAppEnvironment } from './app-fixture';
import { FixtureTransport, requestFixtureHttp } from './fixture-transport';

const project = path.resolve('..');
type Prepared = { database_url: string; owner_id: string; contact_ids: string[]; other_contact_id: string };
export type ModelPlan = { count?: number; risk_notes?: string[]; prefix?: string; fault?: 'timeout' | 'failure'; probe_history?: boolean };

export class RewriteFixture {
  private readonly transport: FixtureTransport<Prepared>;
  readonly ready: Promise<Prepared>;
  data!: Prepared;
  constructor(readonly directory: string, readonly pythonExecutable: string, readonly child: ChildProcess) {
    this.transport = new FixtureTransport<Prepared>(child, '改写');
    this.ready = this.transport.ready.then((data) => { this.data = data; return data; });
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
    return this.transport.command(operation, extra);
  }
  plan(plan: ModelPlan = {}): Promise<unknown> { return this.command('plan', { plan }); }
  async request(endpoint: string, body?: object) {
    return requestFixtureHttp(this.infoPath, endpoint, body);
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
