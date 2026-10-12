import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test as appTest, isolatedAppEnvironment } from './app-fixture';
import { verifyAppTestLease } from './app-test-gate';
import { BindingFixture, type BindingData } from './binding-backend-fixture';
import { ContactHttpProxy } from './contact-http-proxy';

const execute = promisify(execFile);
const project = path.resolve('..');
const databaseScript = path.join(project, 'backend/tests/integration/server/real_sync_quit_support.py');
type Scope = { real_cli: string; audit_path: string; pid_audit_path: string; not_before: number; until: number };
export type CliAudit = { event: string; kind: string; pid?: number; returncode?: number };

class RealSyncFixture extends BindingFixture {
  constructor(directory: string, python: string, data: BindingData, readonly scopePath: string, readonly scope: Scope) {
    super(directory, python, data);
  }
  override environment(ownerId = this.data.owner_id): NodeJS.ProcessEnv {
    return { ...super.environment(ownerId), NOTALONE_WECHAT_CLI: this.scope.real_cli,
      NOTALONE_REAL_SYNC_SCOPE: this.scopePath, NOTALONE_TEST_BINDING_DIRECTORY: undefined };
  }
  async audit(): Promise<CliAudit[]> {
    try { return (await readFile(this.scope.audit_path, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
}

export const test = appTest.extend<{ realSyncBackend: RealSyncFixture; realSyncProxy: ContactHttpProxy }>({
  realSyncBackend: async ({}, use) => {
    const lease = await verifyAppTestLease();
    if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) throw new Error('真实同步验收须激活 NotAlone。');
    const scopePath = process.env.NOTALONE_TEST_REAL_SYNC_SCOPE;
    if (!scopePath || !path.isAbsolute(scopePath)) throw new Error('未提供已确认的私有验收范围。');
    const metadata = await lstat(scopePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || (metadata.mode & 0o077)) throw new Error('私有验收范围权限不合格。');
    const scope = JSON.parse(await readFile(scopePath, 'utf8')) as Scope;
    if (Date.now() >= scope.until * 1000 || scope.until * 1000 > lease.until) throw new Error('验收范围超出有限时段。');
    const directory = await mkdtemp(path.join(tmpdir(), 'notalone-real-sync-'));
    await chmod(directory, 0o700);
    const originalPython = path.join(process.env.CONDA_PREFIX, 'bin/python');
    const python = path.join(directory, 'controlled-python');
    const source = await readFile(path.join(project, 'desktop/tests/fixtures/real-sync-python.py'), 'utf8');
    await writeFile(python, `#!${originalPython}\n${source}`, { mode: 0o700 });
    const marker = appTest.info().outputPath('database-ownership.json');
    const env = isolatedAppEnvironment(directory, { PYTHONPATH: path.join(project, 'backend/src'), PYTHONNOUSERSITE: '1',
      NOTALONE_REAL_SYNC_SCOPE: scopePath, NOTALONE_DEEPSEEK_API_KEY: '', NOTALONE_DEEPSEEK_BASE_URL: 'http://127.0.0.1:1' });
    let fixture: RealSyncFixture | undefined;
    let data: BindingData | undefined;
    let failure: unknown;
    let dropped = false;
    try {
      data = JSON.parse((await execute(originalPython, [databaseScript, 'create', marker], { env, timeout: 70_000 })).stdout) as BindingData;
      fixture = new RealSyncFixture(directory, python, data, scopePath, scope);
      await writeFile(appTest.info().outputPath('real-sync-owned.json'), JSON.stringify({ fixtureDirectory: directory, databaseName: data.database_name }), { mode: 0o600 });
      await fixture.startBackend();
      await writeFile(appTest.info().outputPath('real-sync-backend-owned.json'), JSON.stringify(fixture.cleanupOwnership()), { mode: 0o600 });
      await use(fixture);
    } catch (error) { failure = error; }
    try {
      if (!fixture || !data) throw new Error('本轮真实同步准备归属未确认。');
      await fixture.cleanup();
      await execute(originalPython, [databaseScript, 'drop', marker, data.database_name], { env, timeout: 15_000 });
      dropped = true;
      if (fixture.cleanupOwnership().unconfirmedResources.length) throw new Error('本轮HTTP收尾未确认。');
      await writeFile(appTest.info().outputPath('real-sync-cleanup.json'), JSON.stringify({ ...fixture.cleanupOwnership(), databaseDropped: true, fixtureDirectory: directory }), { mode: 0o600 });
      await rm(directory, { recursive: true, force: true });
    } catch {
      await writeFile(path.join(directory, 'cleanup-unconfirmed.json'), JSON.stringify({ ...(fixture?.cleanupOwnership() ?? {}), databaseDropped: dropped }), { mode: 0o600 });
      throw new Error('本轮真实同步收尾未确认，保留自有范围与归属记录。', { cause: failure });
    }
    if (failure) throw failure;
  },
  realSyncProxy: [async ({ realSyncBackend }, use) => {
    const proxy = await ContactHttpProxy.attach(realSyncBackend.infoPath);
    try { await use(proxy); }
    finally {
      if (proxy.authenticatedRuntimeStopped) realSyncBackend.confirmProxyStopped();
      proxy.release();
      try { await proxy.close(); }
      catch (error) { realSyncBackend.recordUnconfirmedCleanup('http-proxy'); throw error; }
    }
  }, { auto: true }],
  appEnvironment: async ({ realSyncBackend, realSyncProxy }, use) => { await use(realSyncBackend.environment()); },
  launchConfiguration: async ({ realSyncBackend }, use) => { await use({
    pythonExecutable: realSyncBackend.pythonExecutable, projectDirectory: project,
    envFilePath: realSyncBackend.envPath, backendInfoPath: realSyncBackend.infoPath,
    wechatCliPath: realSyncBackend.scope.real_cli, syncProbePath: path.join(realSyncBackend.directory, 'unavailable-probe'),
  }); },
  appWorkingDirectory: '/',
});
