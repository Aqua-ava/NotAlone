import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ContactFixture, type ContactDatabase } from './contact-backend-fixture';
import { isolatedAppEnvironment } from './isolated-environment';

const execute = promisify(execFile);
const project = path.resolve('..');
const databaseScript = path.join(project, 'backend/tests/integration/server/binding_consent_support.py');
export type BindingMode = 'ready' | 'no-channel';
export type BindingData = ContactDatabase & { foreign_bindings: { contact_id: string; binding_id: string }[] };
export type CliState = { sessions: { username: string; display_name: string; chat_type: string; last_timestamp: number }[];
  messages: Record<string, { local_id: number; text: string; create_time: number }[]> };
export const initialCliState = (): CliState => ({ sessions: ['wxid_synthetic_a', 'wxid_synthetic_b'].map((username) =>
  ({ username, display_name: '同名会话', chat_type: 'private', last_timestamp: 1_700_000_000 })), messages: {} });

export class BindingFixture extends ContactFixture {
  private child: ChildProcess | undefined;
  private shutdownTarget: { address: string; token: string } | undefined;
  private stopped = false;
  private stopSource: 'page-host' | 'app-http-response' | 'fixture-shutdown' | null = null;
  private readonly unconfirmedResources: string[] = [];
  constructor(directory: string, pythonExecutable: string, readonly bindingData: BindingData) {
    super(directory, pythonExecutable, bindingData);
  }
  override environment(ownerId = this.data.owner_id): NodeJS.ProcessEnv {
    return { ...super.environment(ownerId), NOTALONE_WECHAT_CLI: path.join(this.directory, 'controlled-cli'),
      NOTALONE_TEST_BINDING_DIRECTORY: this.directory };
  }
  private async target() {
    const info = await readFile(this.infoPath, 'utf8');
    const address = /^address=(127\.0\.0\.1:\d+)$/m.exec(info)?.[1];
    const token = /^token=([^\n]+)$/m.exec(info)?.[1];
    if (!address || !token) throw new Error('本轮绑定握手尚未就绪。');
    return { address, token };
  }
  private async requestTarget(target: { address: string; token: string }, endpoint: string, body?: object) {
    const response = await fetch(`http://${target.address}${endpoint}`, {
      method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { Authorization: `Bearer ${target.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() as Record<string, unknown> };
  }
  override async request(endpoint: string, body?: object) { return this.requestTarget(await this.target(), endpoint, body); }
  override async startBackend(ownerId = this.data.owner_id): Promise<ChildProcess> {
    if (this.child) throw new Error('本轮绑定夹具不能启动第二个后端。');
    const child = spawn(this.pythonExecutable, ['-m', 'notalone.server.command', '--sync-interval', '60'], {
      cwd: project, stdio: 'ignore', env: isolatedAppEnvironment(this.directory, this.environment(ownerId)),
    });
    this.child = child;
    let spawnFailed = false;
    child.on('error', () => { spawnFailed = true; });
    for (let count = 0; count < 150; count++) {
      if (spawnFailed || child.exitCode !== null || child.signalCode !== null) throw new Error('本轮绑定后端未启动。');
      try {
        const target = await this.target();
        if ((await this.requestTarget(target, '/api/runtime/status')).data.state === 'running') {
          this.shutdownTarget = target; return child;
        }
      } catch { /* 只等待本轮独立握手和认证状态。 */ }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('本轮绑定后端启动未确认。');
  }
  // 仅在 PageHost.close 已认证确认 stopped 后调用；进程退出仍由本夹具独立核验。
  confirmControllerStopped(): void { this.stopped = true; this.stopSource = 'page-host'; }
  // 仅由持有原握手 token 的回环代理在真实认证响应校验后调用。
  confirmProxyStopped(): void { this.stopped = true; this.stopSource = 'app-http-response'; }
  recordUnconfirmedCleanup(resource: 'page-host' | 'http-proxy'): void { this.unconfirmedResources.push(resource); }
  override async stopBackend(): Promise<void> {
    if (!this.shutdownTarget) throw new Error('本轮绑定停读目标未确认。');
    const stopped = await this.requestTarget(this.shutdownTarget, '/api/runtime/shutdown', {});
    if (stopped.status !== 200 || stopped.data.state !== 'stopped') throw new Error('本轮绑定认证停读未确认。');
    this.stopped = true;
    this.stopSource = 'fixture-shutdown';
    await this.waitForOwnedExit();
  }
  private async waitForOwnedExit(): Promise<void> {
    const child = this.child;
    if (!child) return;
    for (let count = 0; child.exitCode === null && child.signalCode === null && count < 100; count++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (child.exitCode !== 0 || child.signalCode !== null) throw new Error('本轮绑定后端正常退出未确认。');
  }
  override async cleanup(): Promise<void> {
    // CLI 准备失败尚未尝试启动后端时，只清理已知的本轮新库；不虚称认证停读。
    if (!this.child) return;
    if (!this.stopped) await this.stopBackend();
    await this.waitForOwnedExit();
  }
  cleanupOwnership() {
    return { childPid: this.child?.pid ?? null, exitCode: this.child?.exitCode ?? null,
      signal: this.child?.signalCode ?? null, authenticatedStopped: this.stopped,
      stopSource: this.stopSource, runtimeStartAttempted: Boolean(this.child),
      databaseName: this.bindingData.database_name, unconfirmedResources: [...this.unconfirmedResources] };
  }
  async prepareCli(): Promise<void> {
    const cli = await readFile(path.join(project, 'backend/tests/fixtures/binding_cli.py'), 'utf8');
    await writeFile(path.join(this.directory, 'controlled-cli'), `#!${this.pythonExecutable}\n${cli}`, { mode: 0o700 });
  }
  async setCli(state: CliState): Promise<void> {
    const location = path.join(this.directory, 'cli-state.json');
    await writeFile(`${location}.tmp`, JSON.stringify(state));
    await rename(`${location}.tmp`, location);
  }
  async tails(): Promise<string[]> {
    try { return (await readFile(path.join(this.directory, 'tail-calls.jsonl'), 'utf8')).trim().split('\n')
      .filter(Boolean).map((line) => JSON.parse(line).locator); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
}

export async function withBindingFixture(directoryPrefix: string, mode: BindingMode,
  use: (fixture: BindingFixture) => Promise<void>, cleanupConfirmed?: () => void): Promise<void> {
  if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) throw new Error('绑定验收须激活 Conda NotAlone。');
  const directory = await mkdtemp(path.join(tmpdir(), directoryPrefix));
  const python = path.join(process.env.CONDA_PREFIX, 'bin/python');
  const env = isolatedAppEnvironment(directory, { PYTHONPATH: path.join(project, 'backend/src') });
  let data: BindingData | undefined;
  let fixture: BindingFixture | undefined;
  let failure: unknown;
  let databaseDropped = false;
  try {
    data = JSON.parse((await execute(python, [databaseScript, 'create', mode], { env, timeout: 70_000 })).stdout) as BindingData;
    if (!/^notalone_binding_[0-9a-f]{32}_test$/.test(data.database_name)) throw new Error('绑定测试库归属无效。');
    fixture = new BindingFixture(directory, python, data);
    await fixture.prepareCli();
    await fixture.setCli(initialCliState());
    await use(fixture);
  } catch (error) { failure = error; }
  try {
    // 准备失败无法确定创建结果时保留目录和 marker，不把未知收尾包装成成功。
    if (!data || !fixture) throw new Error('本轮绑定准备归属未确认。');
    await fixture.cleanup();
    await execute(python, [databaseScript, 'drop', data.database_name], { env, timeout: 15_000 });
    databaseDropped = true;
    if (fixture.cleanupOwnership().unconfirmedResources.length) throw new Error('本轮绑定页面或传输收尾未确认。');
    process.stdout.write(`binding_fixture_cleanup: ${JSON.stringify({ ...fixture.cleanupOwnership(), databaseDropped: true })}\n`);
    await rm(directory, { recursive: true, force: true });
    cleanupConfirmed?.();
  } catch {
    await writeFile(path.join(directory, 'cleanup-unconfirmed.json'), JSON.stringify({
      ...(fixture?.cleanupOwnership() ?? { childPid: null, databaseName: data?.database_name ?? null, authenticatedStopped: false }),
      databaseDropped,
    }), { mode: 0o600 });
    throw new Error(`本轮绑定收尾未确认，保留归属记录：${directory}`, { cause: failure });
  }
  if (failure) throw failure;
}
