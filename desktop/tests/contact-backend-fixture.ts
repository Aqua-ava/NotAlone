import { spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isolatedAppEnvironment } from './isolated-environment';
const project = path.resolve('..');

export type ContactDatabase = {
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
      await this.waitForChildExit(child, '本轮联系人后端未回收。');
    }
  }

  async stopBackend(): Promise<void> {
    const stopped = await this.request('/api/runtime/shutdown', {});
    if (stopped.status !== 200 || stopped.data.state !== 'stopped') throw new Error('本轮真实后端停读未确认。');
    for (const child of this.children) {
      await this.waitForChildExit(child, '本轮真实后端正常退出未确认。');
    }
  }

  private async waitForChildExit(child: ChildProcess, failureMessage: string): Promise<void> {
    const exited = () => child.exitCode !== null || child.signalCode !== null;
    for (let count = 0; !exited() && count < 75; count++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!exited()) throw new Error(failureMessage);
  }
}

