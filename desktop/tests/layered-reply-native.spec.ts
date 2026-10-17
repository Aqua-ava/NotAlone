import { test as appTest } from './app-fixture';
import { withLayeredReplyFixture } from './layered-reply-fixture';
import type { RewriteFixture } from './rewrite-backend-fixture';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const project = path.resolve('..');
const test = appTest.extend<{ layeredBackend: RewriteFixture }>({
  layeredBackend: async ({}, use) => withLayeredReplyFixture(use),
  appEnvironment: async ({ layeredBackend }, use) => use(layeredBackend.environment()),
  launchConfiguration: async ({ layeredBackend }, use) => use({
    pythonExecutable: layeredBackend.pythonExecutable, projectDirectory: project,
    envFilePath: layeredBackend.envPath, backendInfoPath: layeredBackend.infoPath,
  }),
});

// 有限等待本次 Computer Use 收据；不自动替代用户操作或签发模型资格。
test('实际 App 的合成分层回复依据 CUA 验收', async ({ runningApp, layeredBackend }) => {
  test.setTimeout(12 * 60_000);
  const requested = process.env.NOTALONE_LAYERED_CUA_DIR;
  if (!requested || !path.isAbsolute(requested)) throw new Error('实际验收须指定本轮私有收据目录。');
  const directory = await realpath(requested);
  const info = await stat(directory);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || directory.startsWith(project)) {
    throw new Error('实际验收收据目录不可核验。');
  }
  const requestId = randomUUID();
  const requiredChecks = ['layered_background', 'directory_not_body', 'saved_versions', 'contact_isolation', 'disabled_fallback'];
  if (process.env.NOTALONE_LAYERED_SCENARIO_READS === '1') requiredChecks.push(
    'scenario_body', 'scenario_range_references', 'scenario_receipts', 'scenario_frozen_history', 'scenario_source_cleanup');
  if (process.env.NOTALONE_LAYERED_OWNER_CONTEXT === '1') requiredChecks.push(
    'owner_background', 'owner_directory_and_body', 'owner_scope_separation',
    'owner_independent_fallback', 'owner_change_cache_cleanup', 'owner_legal_history');
  const prepared = await layeredBackend.command('prepared');
  await runningApp.app.firstWindow();
  await writeFile(path.join(directory, 'ready.json'), JSON.stringify({
    request_id: requestId, pid: runningApp.appProcess.pid, user_data: runningApp.userData,
    contact_ids: layeredBackend.data.contact_ids, external_model_calls: 0,
    project, native_app: true, final_signed_package: false,
    required_checks: requiredChecks, prepared,
  }), { mode: 0o600, flag: 'wx' });
  await new Promise<void>((resolve, reject) => {
    let checking = false;
    let settled = false;
    const watcher = watch(directory, (_event, filename) => { if (filename === 'done.json') void check(); });
    const timer = setTimeout(() => finish(new Error('本次CUA未在有限期限内完成。')), 11 * 60_000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error); else resolve();
    }
    async function check() {
      if (checking || settled) return;
      checking = true;
      try {
        const receipt = JSON.parse(await readFile(path.join(directory, 'done.json'), 'utf8'));
        if (receipt.request_id !== requestId || receipt.passed !== true) throw new Error('CUA收据未通过或不属于本次实例。');
        if (!requiredChecks.every((name) => receipt.checks?.[name] === true)) {
          throw new Error('CUA收据未包含本次分层回复的全部实际操作。');
        }
        finish();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') finish(error as Error);
      } finally { checking = false; }
    }
    void check();
  });
  await writeFile(path.join(directory, 'runtime-proof.json'), JSON.stringify(await layeredBackend.command('runtime_proof')),
    { mode: 0o600, flag: 'wx' });
});
