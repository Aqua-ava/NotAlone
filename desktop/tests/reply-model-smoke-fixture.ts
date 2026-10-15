import { test as appTest } from './app-fixture';
import { isolatedAppEnvironment } from './isolated-environment';
import { FixtureTransport, requestFixtureHttp } from './fixture-transport';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const project = path.resolve('..');
type Prepared = { owner_id: string; contact_id: string; database_name: string; database_url: string };
const variables = ['NOTALONE_REPLY_MODEL_SMOKE_AUTHORIZED_RUN_ID', 'NOTALONE_REPLY_MODEL_SMOKE_APP_ASAR_SHA256',
  'NOTALONE_REPLY_MODEL_SMOKE_CONFIG_SHA256', 'NOTALONE_REPLY_MODEL_SMOKE_KEY_FILE', 'NOTALONE_REPLY_MODEL_SMOKE_OUTPUT'] as const;

export class ReplyModelSmokeFixture {
  readonly transport: FixtureTransport<Prepared>;
  data!: Prepared;
  constructor(readonly directory: string, readonly pythonExecutable: string, readonly child: ChildProcess) {
    this.transport = new FixtureTransport(child, '单次合成模型', 70_000, 10_000);
  }
  get infoPath() { return path.join(this.directory, 'backend.info'); }
  get envPath() { return path.join(this.directory, 'synthetic.env'); }
  environment(): NodeJS.ProcessEnv {
    // key及其文件位置只交专用后端；App和兜底生产后端均没有模型凭据。
    return { NOTALONE_BACKEND_INFO: this.infoPath, NOTALONE_ENV_FILE: this.envPath,
      NOTALONE_DATABASE_URL: this.data.database_url, NOTALONE_OWNER_ID: this.data.owner_id,
      NOTALONE_DEEPSEEK_API_KEY: '', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '',
      NOTALONE_REPLY_MODEL_SMOKE_KEY_FILE: '',
      NOTALONE_DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
      NOTALONE_WECHAT_CLI: path.join(this.directory, 'unavailable-cli'),
      NOTALONE_SYNC_PROBE: path.join(this.directory, 'unavailable-probe'),
      LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false',
      PYTHONPATH: `${path.join(project, 'backend/src')}:${path.join(project, 'backend')}`, PYTHONNOUSERSITE: '1' };
  }
  command(operation: 'inspect' | 'finish' | 'stop') { return this.transport.command(operation); }
  request(endpoint: string) { return requestFixtureHttp(this.infoPath, endpoint); }
  async cleanup() {
    let commandFailed = false;
    try {
      if (this.child.exitCode === null && this.child.signalCode === null) await this.command('stop');
    } catch {
      commandFailed = true;
    } finally { this.child.stdin?.end(); }
    const until = Date.now() + 30_000;
    while (this.child.exitCode === null && this.child.signalCode === null && Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (commandFailed || this.child.exitCode !== 0) throw new Error('本轮模型后端或隔离库收尾未确认。');
    const closed = JSON.parse(await readFile(path.join(process.env.NOTALONE_REPLY_MODEL_SMOKE_OUTPUT!, 'reply-smoke-closed.json'), 'utf8'));
    if (closed.cleanup_confirmed !== true || closed.budget?.closed !== true || closed.budget.request_limit !== 1
      || closed.budget.reserved_requests > 1) throw new Error('本轮持久预算与隔离库未确认关闭。');
  }
}

export const test = appTest.extend<{ smokeBackend: ReplyModelSmokeFixture }>({
  smokeBackend: async ({}, use) => {
    if (process.env.NOTALONE_REPLY_MODEL_SMOKE_APP_ACCEPTANCE !== '1') throw new Error('本场模型验收未显式启用。');
    if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) throw new Error('须先激活 Conda NotAlone。');
    if (variables.some(name => !process.env[name])) throw new Error('缺本场新的预算授权或冻结参数。');
    const executable = process.env.NOTALONE_TEST_APP_EXECUTABLE;
    if (!executable || !path.isAbsolute(executable) || !/\.app\/Contents\/MacOS\/[^/]+$/.test(executable)) {
      throw new Error('本场仅允许当前签名App的绝对可执行路径。');
    }
    const contents = path.dirname(path.dirname(executable));
    const asar = createHash('sha256').update(await readFile(path.join(contents, 'Resources/app.asar'))).digest('hex');
    if (asar !== process.env.NOTALONE_REPLY_MODEL_SMOKE_APP_ASAR_SHA256) throw new Error('当前App与本场冻结摘要不一致。');
    await promisify(execFile)('/usr/bin/codesign', ['--verify', '--deep', '--strict', path.dirname(contents)]);
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-reply-model-smoke-'));
    const pythonExecutable = path.join(process.env.CONDA_PREFIX, 'bin/python');
    await writeFile(path.join(directory, 'synthetic.env'), 'NOTALONE_DISABLE_DOTENV=1\n', { mode: 0o600, flag: 'wx' });
    const authorization = Object.fromEntries(variables.map(name => [name, process.env[name]!])) as NodeJS.ProcessEnv;
    const child = spawn(pythonExecutable, [path.join(project, 'desktop/tests/fixtures/reply-model-smoke-backend.py')], {
      cwd: project, stdio: ['pipe', 'pipe', 'ignore'], env: isolatedAppEnvironment(directory, {
        ...authorization, NOTALONE_REPLY_MODEL_SMOKE_APP_ACCEPTANCE: '1',
        NOTALONE_REPLY_MODEL_SMOKE_FIXTURE_DIRECTORY: directory,
        NOTALONE_DEEPSEEK_API_KEY: '', DEEPSEEK_API_KEY: '', OPENAI_API_KEY: '',
        PYTHONPATH: `${path.join(project, 'backend/src')}:${path.join(project, 'backend')}`, PYTHONNOUSERSITE: '1',
      }),
    });
    const fixture = new ReplyModelSmokeFixture(directory, pythonExecutable, child);
    try {
      await writeFile(appTest.info().outputPath('reply-model-smoke-owned-backend.json'), JSON.stringify({
        childPid: child.pid, fixtureDirectory: directory, executable,
      }), { mode: 0o600, flag: 'wx' });
      fixture.data = await fixture.transport.ready;
      await use(fixture);
    } finally {
      try { await fixture.cleanup(); await rm(directory, { recursive: true, force: true }); }
      catch {
        await writeFile(path.join(directory, 'cleanup-unconfirmed.json'), JSON.stringify({
          childPid: child.pid, databaseName: fixture.data?.database_name ?? null,
          exitCode: child.exitCode, signal: child.signalCode,
        }), { mode: 0o600 });
        throw new Error(`本场模型预算或精确资源收尾未确认，保留：${directory}`);
      }
    }
  },
  appEnvironment: async ({ smokeBackend }, use) => { await use(smokeBackend.environment()); },
  launchConfiguration: async ({ smokeBackend }, use) => {
    await use({ pythonExecutable: smokeBackend.pythonExecutable, projectDirectory: project,
      envFilePath: smokeBackend.envPath, backendInfoPath: smokeBackend.infoPath });
  },
});
