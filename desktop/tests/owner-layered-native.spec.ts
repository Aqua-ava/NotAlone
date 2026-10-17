import { test as appTest } from './app-fixture';
import { withLayeredMemoryFixture } from './layered-memory-fixture';
import type { RewriteFixture } from './rewrite-backend-fixture';
import { randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const project = path.resolve('..');
const test = appTest.extend<{ layeredBackend: RewriteFixture }>({
  layeredBackend: async ({}, use) => withLayeredMemoryFixture(use, undefined, { ownerOnly: true }),
  appEnvironment: async ({ layeredBackend }, use) => use(layeredBackend.environment()),
  launchConfiguration: async ({ layeredBackend }, use) => use({
    pythonExecutable: layeredBackend.pythonExecutable, projectDirectory: project,
    envFilePath: layeredBackend.envPath, backendInfoPath: layeredBackend.infoPath,
  }),
});

// 有限等待本次 Computer Use 收据；不自动替代用户操作或签发模型资格。
test('实际 App 的本人独立两层资料 CUA 验收', async ({ runningApp, layeredBackend }) => {
  test.setTimeout(12 * 60_000);
  const requested = process.env.NOTALONE_LAYERED_CUA_DIR;
  if (!requested || !path.isAbsolute(requested)) throw new Error('实际验收须指定本轮私有收据目录。');
  const directory = await realpath(requested);
  const info = await stat(directory);
  if (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || directory.startsWith(project)) {
    throw new Error('实际验收收据目录不可核验。');
  }
  const requestId = randomUUID();
  if (layeredBackend.data.contact_ids.length !== 0) throw new Error('本人验收不得预置联系人。');
  const requiredChecks = ['no_contact_owner_entry', 'initial_closed', 'manual_owner_memory_saved',
    'partial_coverage_paused', 'continue_progress', 'complete_coverage', 'automatic_both_layers',
    'owner_evidence_visible', 'owner_facts_without_contact', 'scope_controls_independent', 'profile_version_withdrawn',
    'scenario_version_withdrawn', 'disabled', 'delete_then_reread'];
  await runningApp.app.firstWindow();
  await writeFile(path.join(directory, 'ready.json'), JSON.stringify({
    request_id: requestId, pid: runningApp.appProcess.pid, user_data: runningApp.userData,
    contact_ids: layeredBackend.data.contact_ids, external_model_calls: 0,
    project, native_app: true, final_signed_package: false,
    required_checks: requiredChecks,
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
          throw new Error('CUA收据未包含本次本人范围的全部实际操作。');
        }
        finish();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') finish(error as Error);
      } finally { checking = false; }
    }
    void check();
  });
  const response = await layeredBackend.request('/api/memories/owner/layered-memory');
  const state = response.data.layered_memory as { scope_kind: string; contact_id: string | null; enabled: boolean; scenarios: unknown[]; profile: unknown | null };
  if (response.status !== 200 || state.scope_kind !== 'owner' || state.contact_id !== null
      || state.enabled || state.scenarios.length || state.profile !== null) {
    throw new Error('实际删除后的本人主题资料与长期背景未同时收口。');
  }
  await writeFile(path.join(directory, 'runtime-proof.json'), JSON.stringify(await layeredBackend.command('runtime_proof')),
    { mode: 0o600, flag: 'wx' });
});
