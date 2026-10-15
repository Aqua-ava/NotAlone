import { expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { test } from './reply-model-smoke-fixture';
import { selectMenu } from './app-fixture';
import { confirmHelperContact } from './foreground-confirmation-actions';
import { createAcceptanceCoordinator } from './acceptance-coordinator.mjs';
import { verifyAppTestLease } from './app-test-gate';

// 默认skip；即使已有key，也必须先取得独立新run的1次HTTP预算。
test.skip(process.env.NOTALONE_REPLY_MODEL_SMOKE_APP_ACCEPTANCE !== '1', '仅执行单独批准的官方DeepSeek合成回复App冒烟');
test.use({ appWorkingDirectory: '/' });

test('当前签名App显式生成一次合成草稿候选、保存依据并正常退出', async ({ runningApp: { app, appProcess }, smokeBackend }) => {
  test.setTimeout(180_000);
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成模型冒烟联系人', exact: true }).click();
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opened;
  await confirmHelperContact(helper, smokeBackend.data.contact_id);
  await expect(helper.getByRole('checkbox', { name: '结合关系语境', exact: true })).not.toBeChecked();
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('明天我有空，晚点见。');
  await helper.getByRole('textbox', { name: '本次要求', exact: true }).fill('更自然一点，保留原意，不添加新事实。');
  await expect.poll(() => helper.evaluate(async () => (await window.notalone.contacts.getState()).draft)).toBe('明天我有空，晚点见。');
  await expect.poll(() => helper.evaluate(async () => (await window.notalone.replies.getState()).options.instruction))
    .toBe('更自然一点，保留原意，不添加新事实。');
  const before = await smokeBackend.command('inspect');
  expect(before.counts).toMatchObject({ message: 0, source_document: 0, confirmed_memory: 0, memory_candidate: 0, background_task: 0 });
  expect(before.budget).toMatchObject({ request_limit: 1, reserved_requests: 0 });
  console.log('reply_model_smoke_stage: explicit-app-generate');
  // 只点击公开生成控件一次；失败不重试、不改key、不另开run。
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect.poll(() => helper.evaluate(async () => {
    const state = await window.notalone.replies.getState();
    return state.result ? 'completed' : state.phase === 'failed' ? 'failed' : 'pending';
  }), { timeout: 30_000 }).toMatch(/^(completed|failed)$/);
  const terminal = await helper.evaluate(async () => {
    const state = await window.notalone.replies.getState();
    return { phase: state.phase, errorCode: state.errorCode ?? null };
  });
  if (terminal.phase === 'failed') {
    const closed = await smokeBackend.command('finish');
    await writeFile(test.info().outputPath('reply-model-smoke-original-failure.json'), JSON.stringify({ ...terminal, ...closed }),
      { mode: 0o600, flag: 'wx' });
  }
  expect(terminal, '保留原始失败分类，不重试本场生成').toMatchObject({ phase: 'ready', errorCode: null });
  const first = helper.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  await expect(first).toBeVisible({ timeout: 30_000 });
  expect((await first.inputValue()).trim().length).toBeGreaterThan(0);
  const state = await helper.evaluate(() => window.notalone.replies.getState());
  expect(state.result?.input).toMatchObject({ mode: 'rewrite_draft', contactId: smokeBackend.data.contact_id,
    draftText: '明天我有空，晚点见。', includeRelationshipContext: false });
  expect(state.result?.candidates.length).toBeGreaterThanOrEqual(1);
  expect(state.result?.candidates.length).toBeLessThanOrEqual(3);
  expect(state.result?.usedSkill ?? null).toBeNull();
  expect(state.result?.inputBudget).toMatchObject({ allowed: true, modelId: 'deepseek-flash',
    measurementKind: 'approximate', outputReserveTokens: 2048, safetyMarginTokens: 16384 });
  const sid = state.savedSession?.sessionId;
  expect(sid).toBeTruthy();
  const saved = await smokeBackend.request(`/api/contacts/${smokeBackend.data.contact_id}/assistant-sessions/${sid}`);
  expect(saved.status).toBe(200);
  expect((saved.data.turns as Array<{ state: string }>).map(turn => turn.state)).toEqual(['completed']);
  const evidence = await smokeBackend.request(`/api/contacts/${smokeBackend.data.contact_id}/replies/${state.result?.replyRequestId}/evidence`);
  expect(evidence.status).toBe(200);
  expect((evidence.data.evidence as Array<{ kind: string }>).map(item => item.kind)).toEqual(['user_draft']);
  const inspection = await smokeBackend.command('inspect');
  expect(inspection.budget).toMatchObject({ request_limit: 1, reserved_requests: 1 });
  expect(inspection).toMatchObject({ responses: 1, response_model_matches: true, reply_states: ['completed'] });
  expect(inspection.counts).toMatchObject({ message: 0, source_document: 0, confirmed_memory: 0, memory_candidate: 0, background_task: 0 });
  const closed = await smokeBackend.command('finish');
  expect(closed.budget).toMatchObject({ request_limit: 1, reserved_requests: 1, closed: true });
  // 预算已经关闭；保留同一真实小窗供主Agent用Computer Use核对与本地编辑。
  const coordinator = await createAcceptanceCoordinator({ directory: smokeBackend.directory, pid: appProcess.pid!,
    checkLease: verifyAppTestLease, isAlive: () => appProcess.exitCode === null && appProcess.signalCode === null });
  try {
    console.log(`reply_model_smoke_stage: computer-use-review ${smokeBackend.directory}/control-state.json`);
    await coordinator.waitFor('review');
  } finally { await coordinator.close(); }
  // 只验证本地编辑，不调用复制或任何外部发送接口。
  await first.fill('合成本地编辑，未复制或发送。');
  await expect(first).toHaveValue('合成本地编辑，未复制或发送。');
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
  await writeFile(test.info().outputPath('reply-model-smoke-app-results.json'), JSON.stringify({
    packaged: true, explicitGenerations: 1, providerHttpResponses: 1, reservedRequests: 1, requestLimit: 1,
    persistentBudgetClosed: true, responseModelMatches: true, savedSessionCompleted: true, userDraftEvidenceOnly: true,
    computerUseReviewCoordinated: true,
    localEdit: true, menuQuitExitZero: true, relationshipContext: false, modelRetryCount: 0,
    wechatRead: false, nativeProbeRun: false, realCliRun: false, copied: false, messagesSent: 0,
    defaultProductionModelConfigurationCertified: false, relationshipOrMultiTurnCertified: false,
  }), { mode: 0o600, flag: 'wx' });
  console.log('reply_model_smoke_stage: normal-quit-completed');
});
