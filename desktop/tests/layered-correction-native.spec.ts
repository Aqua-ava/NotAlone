import { test as appTest } from './app-fixture';
import { withLayeredMemoryFixture } from './layered-memory-fixture';
import type { RewriteFixture } from './rewrite-backend-fixture';
import { prepareNativeCorrection, checkNativeCorrection, type NativeCorrectionStep } from './layered-correction-native-flow';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { cuaReceiptDirectory, waitForCuaReceipt } from './cua-receipt';
import path from 'node:path';
import assert from 'node:assert/strict';

const project = path.resolve('..');
const test = appTest.extend<{ layeredBackend: RewriteFixture }>({
  layeredBackend: async ({}, use) => withLayeredMemoryFixture(use, undefined, { maxMemories: 2, separateTopics: true }),
  appEnvironment: async ({ layeredBackend }, use) => use(layeredBackend.environment()),
  launchConfiguration: async ({ layeredBackend }, use) => use({ pythonExecutable: layeredBackend.pythonExecutable,
    projectDirectory: project, envFilePath: layeredBackend.envPath, backendInfoPath: layeredBackend.infoPath }),
});

test('实际 App 的双范围两层事实及总结纠错 CUA 验收', async ({ runningApp, layeredBackend }) => {
  // 所有实际操作共用有限期限，给预约窗口内的退出清理留出余量。
  test.setTimeout(24 * 60_000);
  const cuaDeadline = Date.now() + 22 * 60_000;
  const stageTimeout = () => {
    const remaining = cuaDeadline - Date.now();
    if (remaining <= 0) throw new Error('本次CUA整体期限已到。');
    return Math.min(4 * 60_000, remaining);
  };
  const directory = await cuaReceiptDirectory(project);
  const requestId = randomUUID();
  await runningApp.app.firstWindow();
  const steps = [];
  let previous: NativeCorrectionStep | undefined;
  for (const scope of ['contact', 'owner'] as const) for (let index = 0; index < 4; index++) {
    const step = await prepareNativeCorrection(layeredBackend, scope, index, previous);
    const stageDirectory = path.join(directory, step.name);
    await mkdir(stageDirectory, { mode: 0o700 });
    const checks = [step.name, 'precise_target_visible', 'old_body_retracted',
      step.action === 'summary' ? 'independent_topic_retained' : 'precise_leaf_corrected'];
    if (index === 0) checks.push('feedback_basis_inspected');
    await writeFile(path.join(stageDirectory, 'ready.json'), JSON.stringify({ request_id: requestId,
      pid: runningApp.appProcess.pid, user_data: runningApp.userData, project, native_app: true,
      external_model_calls: 0, preparation: 'public-http-synthetic', contact_ids: layeredBackend.data.contact_ids,
      required_checks: checks, step }), { mode: 0o600, flag: 'wx' });
    await waitForCuaReceipt(stageDirectory, requestId, checks, stageTimeout());
    const observed = await checkNativeCorrection(layeredBackend, step);
    await writeFile(path.join(stageDirectory, 'public-proof.json'), JSON.stringify(observed), { mode: 0o600, flag: 'wx' });
    steps.push(step.name);
    previous = step;
  }
  const checks = ['manual_owner_supplement', 'empty_contact_isolation'];
  await writeFile(path.join(directory, 'ready.json'), JSON.stringify({ request_id: requestId,
    pid: runningApp.appProcess.pid, user_data: runningApp.userData, native_app: true, steps,
    contact_ids: layeredBackend.data.contact_ids, required_checks: checks,
    supplement: '本人通过原生入口补充独立合成背景。' }), { mode: 0o600, flag: 'wx' });
  await waitForCuaReceipt(directory, requestId, checks, stageTimeout());
  const memories = await layeredBackend.request('/api/memories/owner');
  assert.equal(memories.status, 200);
  assert.ok((memories.data.memories as { text: string }[]).some(item => item.text === '本人通过原生入口补充独立合成背景。'));
  const empty = await layeredBackend.request(`/api/contacts/${layeredBackend.data.empty_contact_id}/layered-memory`);
  assert.equal(empty.status, 200);
  assert.deepEqual((empty.data.layered_memory as { scenarios: unknown[] }).scenarios, []);
  await writeFile(path.join(directory, 'final-public-proof.json'), JSON.stringify({
    memories: memories.data, empty_contact: empty.data }), { mode: 0o600, flag: 'wx' });
  await writeFile(path.join(directory, 'runtime-proof.json'), JSON.stringify(await layeredBackend.command('runtime_proof')),
    { mode: 0o600, flag: 'wx' });

  // 公共退出会认证停止后端；先完成全部公开后验，再等待实际菜单退出，之后不再请求 HTTP。
  const quitDirectory = path.join(directory, 'public-quit');
  const quitChecks = ['public_app_quit'];
  await mkdir(quitDirectory, { mode: 0o700 });
  await writeFile(path.join(quitDirectory, 'ready.json'), JSON.stringify({ request_id: requestId,
    pid: runningApp.appProcess.pid, user_data: runningApp.userData, native_app: true,
    pre_quit_checks_completed: true, required_checks: quitChecks }), { mode: 0o600, flag: 'wx' });
  await waitForCuaReceipt(quitDirectory, requestId, quitChecks, stageTimeout());
  assert.equal(runningApp.appProcess.exitCode, 0, '实际公共退出必须使本轮 App 正常结束。');
  assert.equal(runningApp.appProcess.signalCode, null, '终止信号不得替代公共菜单退出。');
  await writeFile(path.join(quitDirectory, 'public-proof.json'), JSON.stringify({
    pid: runningApp.appProcess.pid, exit_code: runningApp.appProcess.exitCode,
    signal: runningApp.appProcess.signalCode }), { mode: 0o600, flag: 'wx' });
});
