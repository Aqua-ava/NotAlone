import { test as appTest } from './app-fixture';
import { withLayeredMemoryFixture } from './layered-memory-fixture';
import type { RewriteFixture } from './rewrite-backend-fixture';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { cuaReceiptDirectory, waitForCuaReceipt } from './cua-receipt';
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
  const directory = await cuaReceiptDirectory(project);
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
  await waitForCuaReceipt(directory, requestId, requiredChecks, 11 * 60_000);
  const response = await layeredBackend.request('/api/memories/owner/layered-memory');
  const state = response.data.layered_memory as { scope_kind: string; contact_id: string | null; enabled: boolean; scenarios: unknown[]; profile: unknown | null };
  if (response.status !== 200 || state.scope_kind !== 'owner' || state.contact_id !== null
      || state.enabled || state.scenarios.length || state.profile !== null) {
    throw new Error('实际删除后的本人主题资料与长期背景未同时收口。');
  }
  await writeFile(path.join(directory, 'runtime-proof.json'), JSON.stringify(await layeredBackend.command('runtime_proof')),
    { mode: 0o600, flag: 'wx' });
});
