import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test as bindingTest } from './binding-fixture';
import { withBindingFixture } from './binding-backend-fixture';
import { selectMenu } from './app-fixture';
import { verifyAppTestLease } from './app-test-gate';

// 仅正式包、真实原生名称识别；CLI正文和业务数据均为合成输入。
const test = bindingTest.extend({
  bindingBackend: async ({}, use) => {
    await verifyAppTestLease();
    const executable = process.env.NOTALONE_TEST_APP_EXECUTABLE;
    const names = [process.env.NOTALONE_FOLLOW_TEST_NAME_A, process.env.NOTALONE_FOLLOW_TEST_NAME_B].filter((name): name is string => Boolean(name?.trim()));
    if (!executable || !path.isAbsolute(executable) || !process.env.NOTALONE_FOLLOW_TEST_NAME_A?.trim()
      || new Set(names).size !== names.length) {
      throw new Error('缺少正式包或本轮已确认测试会话的明确范围。');
    }
    const probe = path.resolve(path.dirname(executable), '../Resources/notalone-probe/notalone-sync-probe');
    await withBindingFixture('notalone-follow-app-', 'single-account', async fixture => {
      const environment = fixture.environment.bind(fixture);
      fixture.environment = owner => ({ ...environment(owner), NOTALONE_SYNC_PROBE: probe });
      await fixture.setCli({ sessions: names.map((name, index) => ({ username: `wxid_synthetic_${index ? 'b' : 'a'}`,
        display_name: name, chat_type: 'private', last_timestamp: 1700000000 })), messages: {} });
      await fixture.startBackend();
      expect((await fixture.request('/api/sync/cli-bindings/confirm', { selections: fixture.data.contact_ids.slice(0, names.length).map((id, index) =>
        ({ locator: `wxid_synthetic_${index ? 'b' : 'a'}`, contact_id: id })) })).status).toBe(200);
      await use(fixture);
    });
  },
});
test.skip(process.env.NOTALONE_CONTINUOUS_APP_ACCEPTANCE !== '1', '须明确本轮时段、正式包和测试联系人');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('正式App持续单帧名称跟随及原位移动缩放、助手暂停恢复', async ({ runningApp: { app, appProcess }, bindingBackend }) => {
  test.setTimeout(1_100_000);
  const directory = process.env.NOTALONE_AUTOMATIC_CONTROL_DIRECTORY;
  if (!directory || !path.isAbsolute(directory)) throw new Error('缺少本轮私有协调目录。');
  expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  const reports: Array<Record<string, unknown>> = [];
  const ready = async (phase: string) => {
    await verifyAppTestLease();
    process.stdout.write(`continuous_ready:${phase}\n`);
    await expect.poll(async () => readFile(path.join(directory, `${phase}.trigger`), 'utf8')
      .then(value => value === 'ready').catch(() => false), { timeout: 120000 }).toBe(true);
  };
  let normalQuit = false;
  try {
    await selectMenu(app, '窗口', '输入小窗');
    await expect.poll(() => app.windows().find(page => page.url().endsWith('#helper')) !== undefined).toBe(true);
    const helper = app.windows().find(page => page.url().endsWith('#helper'))!;
    await expect.poll(() => helper.evaluate(async () => (await window.notalone.contacts.getState()).directoryPhase)).toBe('ready');
    expect((await bindingBackend.request('/api/sync/enable', {})).status).toBe(200);
    const phases: Array<[string, number]> = [['baseline', 0], ['moved', 0], ['resized', 0]];
    if (process.env.NOTALONE_FOLLOW_TEST_NAME_B?.trim()) phases.push(['switch-b', 1], ['return-a', 0]);
    for (const [phase, index] of phases) {
      await ready(phase);
      const started = Date.now();
      const matched = () => helper.evaluate(async ({ expected, since }) => {
        const foreground = await window.notalone.foreground.getState();
        const contacts = await window.notalone.contacts.getState();
        return { matched: contacts.selectedContactId === expected && foreground.confirmedContactId === expected
          && foreground.confirmation === 'verified-binding' && Date.parse(foreground.observedAt ?? '') >= since,
          phase: foreground.phase, reason: foreground.reason };
      }, { expected: bindingBackend.data.contact_ids[index], since: started });
      await expect.poll(async () => (await matched()).matched, { timeout: 30000 }).toBe(true);
      reports.push({ phase, matched: true, displayedAfterTriggerMs: Date.now() - started });
      await writeFile(path.join(directory, `${phase}.result.json`), JSON.stringify(reports.at(-1)), { mode: 0o600, flag: 'wx' });
    }
    await ready('other-app');
    await expect.poll(async () => helper.evaluate(async () => {
      const state = await window.notalone.foreground.getState();
      return state.phase === 'paused' && state.wechatInFront === false;
    }), { timeout: 30000 }).toBe(true);
    reports.push({ phase: 'other-app', paused: true });
    await selectMenu(app, '窗口', '输入小窗');
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('持续跟随验收合成草稿（不发送）');
    const paused = await helper.evaluate(async () => window.notalone.foreground.getState());
    expect(paused.suspendedByHelperFocus).toBe(true);
    expect(paused.generationBlock).toBeNull();
    await new Promise(resolve => setTimeout(resolve, 4500));
    const held = await helper.evaluate(async () => window.notalone.foreground.getState());
    expect(held.foregroundRevision).toBe(paused.foregroundRevision);
    expect(await helper.getByRole('textbox', { name: '草稿', exact: true }).inputValue()).toBe('持续跟随验收合成草稿（不发送）');
    reports.push({ phase: 'helper-pause', noNewObservation: true, draftPreserved: true });
    await ready('resume-a');
    await expect.poll(async () => helper.evaluate(async expected => {
      const state = await window.notalone.foreground.getState();
      return !state.suspendedByHelperFocus && state.confirmedContactId === expected && state.phase === 'confirmed';
    }, bindingBackend.data.contact_ids[0]), { timeout: 30000 }).toBe(true);
    await selectMenu(app, 'NotAlone', '退出 NotAlone');
    await expect.poll(() => appProcess.exitCode, { timeout: 15000 }).toBe(0);
    normalQuit = true;
  } finally {
    // 只输出阶段/布尔/耗时；不输出联系人身份、名称或原生原始输出。
    await writeFile(test.info().outputPath('continuous-follow-results.json'), JSON.stringify({ reports, normalQuit,
      privateBodyRead: false, sentMessages: 0, modelCalls: 0, runtimeFrameCountVerified: false,
      nativeDurationMeasured: false, backendDurationMeasured: false }), { mode: 0o600, flag: 'wx' });
  }
});
