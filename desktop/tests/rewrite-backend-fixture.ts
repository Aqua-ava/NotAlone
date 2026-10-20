import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FixtureTransport, requestFixtureHttp } from './fixture-transport';
import { isolatedAppEnvironment } from './isolated-environment';
import { cleanupCoreFixture, FixtureProcessEvidence } from './database-ownership';
const project = path.resolve('..');

export async function currentMigrationCount(): Promise<number> {
  const names = (await readdir(path.join(project, 'backend/database/migrations')))
    .filter(name => name.endsWith('.sql')).sort();
  // Python 夹具另逐项核对完整账本与零重复；这里独立核验当前目录及旧覆盖下限。
  if (names.length < 89 || names.some((name, index) => !name.startsWith(`${String(index + 1).padStart(3, '0')}_`))) {
    throw new Error('完整桌面夹具须覆盖至少89项且连续编号的当前正式迁移。');
  }
  return names.length;
}

export type Prepared = { database_url: string; owner_id: string; contact_ids: string[]; other_contact_id: string; empty_contact_id: string;
  migration_count?: number; migration_repeat?: number };
export type ModelPlan = { select_skill?: string | null; explore?: { understanding?: string; direction?: string; invalid_evidence?: boolean; same_stance?: boolean; cite_all?: boolean;
  options?: Array<{ intent: string; label: string; reason: string; pause?: boolean }>;
  question?: { text: string; impact: 'stance' | 'commitment' | 'ambiguity' } | null; ambiguities?: string[]; group?: string };
  read_skill?: string; count?: number; message_groups?: string[][]; risk_notes?: string[]; prefix?: string; fault?: 'timeout' | 'failure'; probe_history?: boolean; cite_history?: boolean; cite_pending?: boolean; text?: string; basis?: string; citation_ids?: string[] };

export class RewriteFixture {
  private readonly transport: FixtureTransport<Prepared>;
  readonly ready: Promise<Prepared>;
  data!: Prepared;
  constructor(readonly directory: string, readonly pythonExecutable: string, readonly child: ChildProcess, commandTimeoutMs = 5000) {
    this.transport = new FixtureTransport<Prepared>(child, '改写', 70_000, commandTimeoutMs);
    this.ready = this.transport.ready.then((data) => { this.data = data; return data; });
  }
  get infoPath(): string { return path.join(this.directory, 'backend.info'); }
  get envPath(): string { return path.join(this.directory, 'synthetic.env'); }
  environment(): NodeJS.ProcessEnv {
    return { NOTALONE_BACKEND_INFO: this.infoPath, NOTALONE_ENV_FILE: this.envPath,
      NOTALONE_DATABASE_URL: this.data.database_url, NOTALONE_TEST_DATABASE_URL: this.data.database_url,
      NOTALONE_OWNER_ID: this.data.owner_id,
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
    let failure: unknown;
    try {
      if (this.child.exitCode === null && this.child.signalCode === null) await this.command('stop');
    } catch (error) { failure = error; }
    finally {
      // 命令通道失败时仍关闭本轮stdin，使Python进入已有finally清理；不向未知PID发信号。
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.stdin?.end();
    }
    // 分层夹具有三个服务顺序收尾；用一次有界退出等待，不能把十秒后的正常退出误报为泄漏。
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await new Promise<void>((resolve, reject) => {
        const exited = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          this.child.removeListener('exit', exited);
          reject(new Error('本轮改写夹具在 60 秒内未退出。', { cause: failure }));
        }, 60_000);
        this.child.once('exit', exited);
      });
    }
    if (failure || this.child.exitCode !== 0) throw new Error('本轮改写夹具或测试库未正常清理。', { cause: failure });
  }
}

// 两个真实入口只共用改写夹具的生命周期；各自负责页面/App与资源登记。
export async function withRewriteFixture(directoryPrefix: string, use: (fixture: RewriteFixture) => Promise<void>,
  cleanupConfirmed?: () => void, scriptPath = path.join(project, 'desktop/tests/fixtures/rewrite-backend.py'),
  pythonWorkingDirectory = project, ownershipFilename = 'database-ownership.json', commandTimeoutMs = 5000): Promise<void> {
  if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) throw new Error('改写验收须先激活 Conda NotAlone。');
  const directory = await mkdtemp(path.join(tmpdir(), directoryPrefix));
  const pythonExecutable = path.join(process.env.CONDA_PREFIX, 'bin/python');
  const child = spawn(pythonExecutable, [scriptPath], {
    cwd: pythonWorkingDirectory, stdio: ['pipe', 'pipe', 'pipe'], env: isolatedAppEnvironment(directory, {
      PYTHONPATH: `${path.join(project, 'backend/src')}:${path.join(project, 'backend')}`, PYTHONNOUSERSITE: '1',
      NOTALONE_DEEPSEEK_API_KEY: '', NOTALONE_DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
    }),
  });
  const evidence = new FixtureProcessEvidence(child);
  const fixture = new RewriteFixture(directory, pythonExecutable, child, commandTimeoutMs);
  let failure: unknown;
  try { await fixture.ready; await use(fixture); }
  catch (error) { failure = error; }
  try {
    await cleanupCoreFixture(fixture, { label: '改写', cleanupConfirmed, markerFilename: ownershipFilename, evidence,
      preserveDirectory: failure !== undefined,
      matchesPreparedDatabase: (name) => !fixture.data || fixture.data.database_url.endsWith(`dbname=${name}`) });
  } catch (cleanupError) {
    if (failure !== undefined) {
      throw new AggregateError([failure, cleanupError],
        `页面原始失败：${failure instanceof Error ? failure.message : String(failure)}；${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
        { cause: failure });
    }
    throw cleanupError;
  }
  if (failure !== undefined) throw failure;
}
