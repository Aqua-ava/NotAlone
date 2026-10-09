import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ContactFixture, type ContactDatabase } from './contact-backend-fixture';
import { isolatedAppEnvironment } from './isolated-environment';
import { ownResource } from './headless/cleanup';
const cleanupRecords: { databaseName: string; databaseRemaining: number; databaseAbsent: boolean; prepareExitCode: number; backendCleanupConfirmed: boolean }[] = [];

export class SourceDeletionFixture extends ContactFixture {
  private backendChild: ChildProcess | undefined;
  private controllerStopped = false;
  constructor(directory: string, python: string, data: ContactDatabase, private readonly replyEnabled = false) { super(directory, python, data); }
  async failFinalVerification(contactId: string, taskId: string) {
    if (!this.data.contact_ids.includes(contactId) || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(taskId)) throw new Error('仅能安排本轮原任务。');
    await promisify(execFile)(this.pythonExecutable, [path.resolve('tests/fixtures/source-deletion-arrangement.py'),
      this.data.database_name, this.data.owner_id, contactId, taskId], {
      env: isolatedAppEnvironment(this.directory, this.environment()), timeout: 5_000,
    });
  }
  async http(endpoint: string, body?: object, method = body ? 'POST' : 'GET') {
    const info = await readFile(this.infoPath, 'utf8');
    const address = /^address=(127\.0\.0\.1:\d+)$/m.exec(info)?.[1];
    const token = /^token=([^\n]+)$/m.exec(info)?.[1];
    if (!address || !token || !endpoint.startsWith('/api/')) throw new Error('来源删除本轮握手不可用。');
    const response = await fetch(`http://${address}${endpoint}`, { method, redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  }
  override request(endpoint: Parameters<ContactFixture['request']>[0], body?: object) { return this.http(endpoint, body); }
  override async startBackend(): Promise<ChildProcess> {
    if (this.replyEnabled) {
      const project = path.resolve('..');
      this.backendChild = spawn(this.pythonExecutable, [path.resolve('tests/fixtures/source-deletion-backend.py')], {
        cwd: project, stdio: 'ignore', env: isolatedAppEnvironment(this.directory, {
          ...this.environment(), PYTHONPATH: `${path.join(project, 'backend/src')}:${path.join(project, 'backend')}`,
        }),
      });
      for (let count = 0; count < 150; count++) {
        if (this.backendChild.exitCode !== null || this.backendChild.signalCode !== null) throw new Error('本轮来源回复后端未启动。');
        try { if ((await this.http('/api/runtime/status')).data.state === 'running') return this.backendChild; }
        catch { /* 有限等待本轮真实认证HTTP就绪。 */ }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('本轮来源回复后端启动超时。');
    }
    this.backendChild = await super.startBackend();
    return this.backendChild;
  }
  confirmControllerStopped() { this.controllerStopped = true; }
  override async cleanup() {
    const child = this.backendChild;
    if (!child) throw new Error('本轮来源后端启动或退出归属未确认。');
    if (!this.controllerStopped) {
      const response = await this.http('/api/runtime/shutdown', {});
      if (response.status !== 200 || response.data.state !== 'stopped') throw new Error('本轮认证停读未确认。');
    }
    for (let count = 0; child.exitCode === null && child.signalCode === null && count < 75; count++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (child.exitCode !== 0 || child.signalCode !== null) throw new Error('本轮来源后端正常退出未确认。');
  }
}

// 准备未知或任一资源收尾未确认时保留目录及标记，不清理前缀范围或杀未知进程。
export async function withSourceDeletionFixture(use: (fixture: SourceDeletionFixture) => Promise<void>, mode: 'basic' | 'reply' | 'multi-source' = 'basic') {
  if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) throw new Error('来源删除验收须先激活 Conda NotAlone。');
  const released = ownResource();
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-headless-source-deletion-'));
  const ownershipPath = path.join(directory, 'database-ownership.json');
  const python = path.join(process.env.CONDA_PREFIX, 'bin/python');
  const script = path.resolve('tests/fixtures/source-deletion-database.py');
  const execute = promisify(execFile);
  const environment = isolatedAppEnvironment(directory, { PYTHONPATH: path.resolve('../backend/src'), NOTALONE_DEEPSEEK_API_KEY: '' });
  let prepareStopped = false;
  let data: ContactDatabase | undefined;
  let fixture: SourceDeletionFixture | undefined;
  let failure: unknown;
  try {
    const prepared = await execute(python, [script, 'create', ownershipPath, mode], { env: environment, timeout: 70_000 });
    prepareStopped = true;
    data = JSON.parse(prepared.stdout) as ContactDatabase;
    fixture = new SourceDeletionFixture(directory, python, data, mode === 'reply');
    await fixture.startBackend();
    await use(fixture);
  } catch (error) { failure = error; }
  try {
    if (!prepareStopped) throw new Error('来源删除准备退出未确认。');
    await fixture?.cleanup();
    const stat = await lstat(ownershipPath);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) throw new Error('本轮归属文件不可核验。');
    const ownership = JSON.parse(await readFile(ownershipPath, 'utf8'));
    if (ownership.version !== 1 || typeof ownership.database_name !== 'string'
      || !/^notalone_contact_session_[0-9a-f]{32}_test$/.test(ownership.database_name)
      || !Number.isInteger(ownership.pid) || ownership.pid <= 0
      || (data && ownership.database_name !== data.database_name)) throw new Error('本轮库归属不匹配。');
    await execute(python, [script, 'drop', ownership.database_name], { env: environment, timeout: 15_000 });
    const absent = await execute(python, ['-c', 'import sys, psycopg\nwith psycopg.connect("host=/tmp dbname=postgres") as c:\n n = c.execute("SELECT count(*) FROM pg_database WHERE datname = %s", (sys.argv[1],)).fetchone()[0]\n if n: raise RuntimeError("本轮来源库仍存在")\n print(n)', ownership.database_name], { env: environment, timeout: 15_000 });
    assert.equal(absent.stdout.trim(), '0');
    const evidence = {
      databaseName: ownership.database_name, databaseRemaining: 0, databaseAbsent: true,
      prepareExitCode: 0, backendCleanupConfirmed: Boolean(fixture),
    };
    cleanupRecords.push(evidence);
    await writeFile('artifacts/headless-pages/source-deletion-cleanup.json', JSON.stringify(evidence, null, 2));
    await writeFile('artifacts/headless-pages/source-deletion-databases.json', JSON.stringify(cleanupRecords, null, 2));
    await rm(directory, { recursive: true });
    released();
    process.stdout.write('page_test_source_cleanup: 精确本轮库查询为0，认证后端退出及目录清理已确认。\n');
  } catch {
    await writeFile(path.join(directory, 'cleanup-unconfirmed.json'), JSON.stringify({ prepareStopped, databaseName: data?.database_name ?? null, ownershipPath }), { mode: 0o600 });
    throw new Error(`来源删除资源收尾未确认，保留本轮归属：${directory}`);
  }
  if (failure) throw failure;
}
