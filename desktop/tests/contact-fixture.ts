import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test as appTest, isolatedAppEnvironment } from './app-fixture';

const execute = promisify(execFile);
const project = path.resolve('..');

type ContactDatabase = {
  database_name: string; database_url: string; owner_id: string; other_owner_id: string;
  contact_ids: string[]; other_contact_id: string;
};
export class ContactFixture {
  private readonly children: ChildProcess[] = [];
  constructor(readonly directory: string, readonly pythonExecutable: string, readonly data: ContactDatabase) {}
  get infoPath(): string { return path.join(this.directory, 'backend.info'); }
  get envPath(): string { return path.join(this.directory, 'synthetic.env'); }

  environment(ownerId = this.data.owner_id): NodeJS.ProcessEnv {
    return {
      NOTALONE_BACKEND_INFO: this.infoPath, NOTALONE_ENV_FILE: this.envPath,
      NOTALONE_DATABASE_URL: this.data.database_url, NOTALONE_OWNER_ID: ownerId,
      NOTALONE_DEEPSEEK_API_KEY: '', NOTALONE_DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
      NOTALONE_WECHAT_CLI: path.join(this.directory, 'unavailable-cli'),
      NOTALONE_SYNC_PROBE: path.join(this.directory, 'unavailable-probe'),
      PYTHONPATH: path.join(project, 'backend/src'), PYTHONNOUSERSITE: '1',
    };
  }

  async request(endpoint: '/api/contacts' | '/api/setup/status' | '/api/runtime/status' | '/api/runtime/shutdown', body?: object) {
    const info = await readFile(this.infoPath, 'utf8');
    const address = /^address=(127\.0\.0\.1:\d+)$/m.exec(info)?.[1];
    const token = /^token=([^\n]+)$/m.exec(info)?.[1];
    if (!address || !token) throw new Error('本轮受控握手尚未就绪。');
    const response = await fetch(`http://${address}${endpoint}`, {
      method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  }

  async startBackend(ownerId = this.data.owner_id): Promise<ChildProcess> {
    const child = spawn(this.pythonExecutable, ['-m', 'notalone.server.command'], {
      cwd: project, stdio: 'ignore', env: isolatedAppEnvironment(this.directory, this.environment(ownerId)),
    });
    this.children.push(child);
    for (let count = 0; count < 150; count++) {
      if (child.exitCode !== null) throw new Error('本轮真实联系人后端未启动。');
      try { if ((await this.request('/api/runtime/status')).data.state === 'running') return child; }
      catch { /* 等待本轮握手与真实 HTTP 就绪。 */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('本轮真实联系人后端启动超时。');
  }

  async cleanup(): Promise<void> {
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      for (let count = 0; child.exitCode === null && child.signalCode === null && count < 75; count++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (child.exitCode === null && child.signalCode === null) throw new Error('本轮联系人后端未回收。');
    }
  }

  async stopBackend(): Promise<void> {
    const stopped = await this.request('/api/runtime/shutdown', {});
    if (stopped.status !== 200 || stopped.data.state !== 'stopped') throw new Error('本轮真实后端停读未确认。');
    for (const child of this.children) {
      for (let count = 0; child.exitCode === null && child.signalCode === null && count < 75; count++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (child.exitCode === null && child.signalCode === null) throw new Error('本轮真实后端正常退出未确认。');
    }
  }
}

export async function readContactHttp(fixture: ContactFixture): Promise<unknown> {
  const response = await fixture.request('/api/contacts');
  if (response.status !== 200) throw new Error('本轮联系人 HTTP 查询未成功。');
  return response.data;
}

export const test = appTest.extend<{ contactBackend: ContactFixture; databaseMode: string; backendMode: 'owned' | 'reused' }>({
  databaseMode: ['ready', { option: true }],
  backendMode: ['owned', { option: true }],
  contactBackend: async ({ databaseMode, backendMode }, use) => {
    if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) {
      throw new Error('联系人验收须先激活 Conda NotAlone。');
    }
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-contact-session-'));
    const pythonExecutable = path.join(process.env.CONDA_PREFIX, 'bin/python');
    const script = path.join(project, 'desktop/tests/fixtures/contact-database.py');
    const env = isolatedAppEnvironment(directory, {
      PYTHONPATH: path.join(project, 'backend/src'), NOTALONE_DEEPSEEK_API_KEY: '',
    });
    let data: ContactDatabase | undefined;
    let fixture: ContactFixture | undefined;
    try {
      const prepared = await execute(pythonExecutable, [script, 'create', databaseMode], { env, timeout: 70_000 });
      data = JSON.parse(prepared.stdout);
      fixture = new ContactFixture(directory, pythonExecutable, data!);
      if (backendMode === 'reused') await fixture.startBackend();
      await use(fixture);
    } finally {
      try { await fixture?.cleanup(); }
      finally {
        try { if (data) await execute(pythonExecutable, [script, 'drop', data.database_name], { env, timeout: 15_000 }); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
  },
  appEnvironment: async ({ contactBackend }, use) => {
    await use(contactBackend.environment());
  },
  launchConfiguration: async ({ contactBackend }, use) => {
    await use({ pythonExecutable: contactBackend.pythonExecutable, projectDirectory: project,
      envFilePath: contactBackend.envPath, backendInfoPath: contactBackend.infoPath });
  },
});
