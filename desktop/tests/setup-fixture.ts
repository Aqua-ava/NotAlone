import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { isolatedAppEnvironment, test as appTest } from './app-fixture';

const execute = promisify(execFile);
const python = path.join(process.env.CONDA_PREFIX ?? '/unconfigured', 'bin/python');
const projectDirectory = path.resolve('..');

export class SetupFixture {
  readonly databaseName = `notalone_setup_${randomUUID().replaceAll('-', '')}_test`;
  readonly databaseUrl = `host=/tmp dbname=${this.databaseName}`;
  constructor(readonly directory: string) {}
  private readonly children: ChildProcess[] = [];
  reusedBackend: ChildProcess | undefined;
  get infoPath(): string { return path.join(this.directory, 'backend.info'); }
  get envPath(): string { return path.join(this.directory, 'synthetic.env'); }
  get pythonPath(): string { return path.join(this.directory, 'controlled-python'); }

  environment(): NodeJS.ProcessEnv {
    return { NOTALONE_DATABASE_URL: this.databaseUrl, NOTALONE_BACKEND_INFO: this.infoPath,
      NOTALONE_ENV_FILE: this.envPath, NOTALONE_TEST_SETUP_DIRECTORY: this.directory,
      NOTALONE_DEEPSEEK_API_KEY: '', NOTALONE_DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
      NOTALONE_WECHAT_CLI: path.join(this.directory, 'unavailable-cli'),
      NOTALONE_SYNC_PROBE: path.join(this.directory, 'unavailable-probe') };
  }

  async startBackend(): Promise<ChildProcess> {
    const child = spawn(this.pythonPath, ['-m', 'notalone.server.command'], {
      cwd: projectDirectory, stdio: 'ignore', env: isolatedAppEnvironment(this.directory, {
        ...this.environment(), PYTHONPATH: path.join(projectDirectory, 'backend/src'), PYTHONNOUSERSITE: '1',
      }),
    });
    this.children.push(child);
    for (let count = 0; count < 150; count++) {
      if (child.exitCode !== null) throw new Error('合成真实后端未启动。');
      try { if ((await this.request('/api/runtime/status')).data.state === 'running') return child; }
      catch { /* 握手与真实认证完成前继续等待。 */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('合成真实后端启动超时。');
  }

  async waitForExit(child: ChildProcess): Promise<void> {
    for (let count = 0; count < 75; count++) {
      if (child.exitCode !== null) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('本轮真实后端未退出。');
  }

  async seed(kind: 'configured' | 'unbound' | 'reused' | 'wrong-owner'): Promise<void> {
    const child = await this.startBackend();
    const initialized = await this.request('/api/setup/initialize', { display_name: '既有合成用户' });
    if (initialized.status !== 200 || initialized.data.created !== true) throw new Error('合成本人准备失败。');
    if (kind === 'configured' || kind === 'reused') await this.request('/api/setup/credentials', { provider: 'deepseek', api_key: 'sk-synthetic-existing-key' });
    await this.request('/api/runtime/shutdown', {});
    await this.waitForExit(child);
    if (kind === 'unbound') await rm(this.envPath);
    if (kind === 'wrong-owner') await writeFile(this.envPath, `NOTALONE_OWNER_ID=${randomUUID()}\n`, { mode: 0o600 });
    if (kind === 'reused') this.reusedBackend = await this.startBackend();
  }

  async cleanup(): Promise<void> {
    // 仅回收夹具自身创建的进程；不把失败断言后的回收算作产品停读验证。
    for (const child of this.children) {
      if (child.exitCode === null) { child.kill('SIGTERM'); await this.waitForExit(child); }
    }
  }

  async database(operation: 'create' | 'drop'): Promise<void> {
    await execute(python, [path.resolve('tests/fixtures/setup-database.py'), operation, this.databaseName], {
      env: { ...process.env, NOTALONE_DISABLE_DOTENV: '1', NOTALONE_ENV_FILE: this.envPath,
        PYTHONPATH: path.join(projectDirectory, 'backend/src'), PYTHONNOUSERSITE: '1' },
      timeout: 75_000,
    });
  }

  async request(endpoint: string, body?: object): Promise<{ status: number; data: Record<string, unknown> }> {
    const fields = Object.fromEntries((await readFile(this.infoPath, 'utf8')).trim().split('\n').map((line) => {
      const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)];
    }));
    const response = await fetch(`http://${fields.address}${endpoint}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${fields.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  }
}

export const test = appTest.extend<{ setup: SetupFixture; setupSeed: 'empty' | 'configured' | 'unbound' | 'reused' | 'wrong-owner' }>({
  setupSeed: ['empty', { option: true }],
  setup: async ({ setupSeed }, use) => {
    if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone') throw new Error('首启验收须激活 Conda NotAlone。');
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-setup-'));
    const setup = new SetupFixture(directory);
    try {
      await setup.database('create');
      await writeFile(setup.pythonPath, `#!${python}\n${await readFile(path.resolve('tests/fixtures/setup-python.py'), 'utf8')}`, { mode: 0o700 });
      if (setupSeed !== 'empty') await setup.seed(setupSeed);
      await use(setup);
    } finally {
      await setup.cleanup();
      await setup.database('drop');
      await rm(directory, { recursive: true, force: true });
    }
  },
  appEnvironment: async ({ setup }, use) => {
    await use(setup.environment());
  },
  launchConfiguration: async ({ setup }, use) => {
    await use({ pythonExecutable: setup.pythonPath, projectDirectory,
      envFilePath: setup.envPath, backendInfoPath: setup.infoPath });
  },
});
