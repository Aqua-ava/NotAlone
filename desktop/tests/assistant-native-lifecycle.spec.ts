import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { test as rewriteTest } from './rewrite-fixture';
import { selectMenu, isolatedAppEnvironment } from './app-fixture';
import { launchApp, verifyAppTestLease } from './app-test-gate';
import { openRewriteAppPages } from './rewrite-transport-fixture';
import { confirmHelperContact } from './foreground-confirmation-actions';
import { withRewriteFixture, type RewriteFixture } from './rewrite-backend-fixture';

const test = rewriteTest.extend({
  rewriteBackend: async ({}, use) => {
    await withRewriteFixture('notalone-lifecycle-', async fixture => {
      await writeFile(rewriteTest.info().outputPath('rewrite-owned.json'), JSON.stringify({
        childPid: fixture.child.pid, fixtureDirectory: fixture.directory,
        databaseName: /(?:^|\s)dbname=(notalone_core_flow_[0-9a-f]{32}_test)(?:\s|$)/.exec(fixture.data.database_url)?.[1] ?? null,
      }), { mode: 0o600, flag: 'wx' });
      await use(fixture);
    }, undefined, path.resolve('tests/fixtures/assistant-lifecycle-backend.py'));
  },
});

// 只由主Agent在有限test:app窗口显式启动；默认测试不执行Electron。
test.skip(process.env.NOTALONE_ASSISTANT_LIFECYCLE_ACCEPTANCE !== '1', '仅执行已约定的A19／A17原生生命周期验收');

async function chooseContact(manager: Page, helper: Page, fixture: RewriteFixture) {
  await expect(manager.getByRole('button', { name: '选择合成联系人甲', exact: true })).toBeVisible({ timeout: 20_000 });
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, fixture.data.contact_ids[0]);
  await expect.poll(() => helper.evaluate(async () => (await window.notalone.replies.getState()).savedSession?.phase))
    .toBe('ready');
}

async function modelCalls(fixture: RewriteFixture) {
  return ((await fixture.command('observations')).payloads as unknown[]).length;
}

test('真实小窗关闭继续、正常退出停止，原目录重开只恢复中断并由用户重试',
  async ({ runningApp: { app, appProcess, userData }, rewriteBackend, appDirectory, appWorkingDirectory }) => {
    test.setTimeout(180_000);
    await verifyAppTestLease();
    await writeFile(test.info().outputPath('owned-app.json'), JSON.stringify({
      pid: appProcess.pid, userData, fixtureDirectory: rewriteBackend.directory, sourceApp: !process.env.NOTALONE_TEST_APP_EXECUTABLE,
      databaseName: /\bdbname=(notalone_core_flow_[a-f\d]{32}_test)\b/.exec(rewriteBackend.data.database_url)?.[1] ?? null,
    }), { mode: 0o600 });
    const { manager, helper } = await openRewriteAppPages(app);
    await chooseContact(manager, helper, rewriteBackend);
    await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('合成原生第一轮已保存草稿。');
    // 先确认主进程公开状态收到草稿，再执行生成；不能仅根据renderer输入框值判定就绪。
    await expect.poll(() => helper.evaluate(async () => (await window.notalone.contacts.getState()).draft))
      .toBe('合成原生第一轮已保存草稿。');
    await rewriteBackend.plan({ count: 1, prefix: '合成原生已保存候选' });
    await helper.getByRole('button', { name: '生成候选', exact: true }).click();
    await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
      .toHaveValue('合成原生已保存候选（说法1）。');
    const sessionId = (await helper.evaluate(() => window.notalone.replies.getState())).savedSession!.sessionId!;
    const endpoint = `/api/contacts/${rewriteBackend.data.contact_ids[0]}/assistant-sessions/${sessionId}`;
    const read = async () => { const saved = await rewriteBackend.request(endpoint);
      expect(saved.status).toBe(200);
      return saved.data as { turns: Array<{ state: string; interruption_reason: string | null; reply: unknown }> }; };

    let reopened: ElectronApplication | undefined;
    let reopenedProcess: ChildProcess | undefined;
    try {
      await rewriteBackend.plan({ count: 1, prefix: '关小窗后可靠完成的合成候选' });
      await rewriteBackend.command('hold');
      await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('合成关小窗时仍在运行的草稿。');
      await helper.getByRole('button', { name: '生成候选', exact: true }).click();
      await expect.poll(async () => (await rewriteBackend.command('observations')).model_entered).toBe(true);
      expect((await read()).turns.at(-1)?.state).toBe('running');
      const helperWindow = await app.browserWindow(helper);
      // 在真实BrowserWindow执行关闭，由生产close事件决定隐藏及生成生命周期。
      await helperWindow.evaluate((window) => window.close());
      await expect.poll(() => helperWindow.evaluate((window) => window.isVisible())).toBe(false);
      expect(appProcess.exitCode).toBeNull();
      await rewriteBackend.command('release');
      await expect.poll(async () => (await read()).turns.at(-1)?.state).toBe('completed');
      expect((await read()).turns.map((turn) => turn.state)).toEqual(['completed', 'completed']);
      await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
      await expect.poll(() => helperWindow.evaluate((window) => window.isVisible())).toBe(true);
      await confirmHelperContact(helper, rewriteBackend.data.contact_ids[0]);
      await helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
      await expect(helper.getByRole('region', { name: '已保存的讨论', exact: true })
        .getByText('关小窗后可靠完成的合成候选（说法1）。', { exact: true })).toBeVisible();

      await rewriteBackend.plan({ count: 1, prefix: '退出后禁止复活的合成迟到候选' });
      await rewriteBackend.command('hold');
      await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('合成真正退出时中断的原草稿。');
      await helper.getByRole('button', { name: '生成候选', exact: true }).click();
      await expect.poll(async () => (await rewriteBackend.command('observations')).model_entered).toBe(true);
      expect((await read()).turns.at(-1)?.state).toBe('running');
      // 真实公开菜单退出，不以Playwright清理、杀进程或模拟事件代签。
      await selectMenu(app, 'NotAlone', '退出 NotAlone');
      await expect.poll(() => appProcess.exitCode).toBe(0);
      // 正常退出允许认证HTTP随服务关闭；先释放旧模型并重建同库读取入口。
      await rewriteBackend.command('release');
      await expect.poll(() => modelCalls(rewriteBackend)).toBe(3);
      await rewriteBackend.command('restart');
      const stopped = await read();
      expect(stopped.turns.map((turn) => turn.state)).toEqual(['completed', 'completed', 'failed']);
      expect(stopped.turns[2]).toMatchObject({ interruption_reason: 'app_quit', reply: null });
      expect(JSON.stringify(await read())).not.toContain('退出后禁止复活的合成迟到候选');
      const beforeReopen = await modelCalls(rewriteBackend);
      reopened = await launchApp({ cwd: appWorkingDirectory,
        executablePath: process.env.NOTALONE_TEST_APP_EXECUTABLE,
        args: [...(process.env.NOTALONE_TEST_APP_EXECUTABLE ? [] : [appDirectory]), `--user-data-dir=${userData}`],
        env: isolatedAppEnvironment(userData, rewriteBackend.environment()),
      });
      // 退出后Playwright会释放通道；启动时保留拥有的进程用于退出断言及清理。
      const nextProcess = reopened.process();
      reopenedProcess = nextProcess;
      await writeFile(test.info().outputPath('owned-reopened-app.json'), JSON.stringify({
        pid: nextProcess.pid, userData, fixtureDirectory: rewriteBackend.directory,
      }), { mode: 0o600 });
      const next = await openRewriteAppPages(reopened);
      await chooseContact(next.manager, next.helper, rewriteBackend);
      await next.helper.getByRole('button', { name: '查看已保存讨论', exact: true }).click();
      await expect(next.helper.getByText('上次生成中断。', { exact: true })).toBeVisible();
      await expect(next.helper.getByRole('button', { name: '重试上次中断生成', exact: true })).toBeEnabled();
      expect((await read()).turns).toEqual(stopped.turns);
      expect(await modelCalls(rewriteBackend)).toBe(beforeReopen);
      await rewriteBackend.plan({ count: 1, prefix: '显式重试后可靠保存的合成候选' });
      await next.helper.getByRole('button', { name: '重试上次中断生成', exact: true }).click();
      await expect(next.helper.getByRole('textbox', { name: '候选1编辑文本', exact: true }))
        .toHaveValue('显式重试后可靠保存的合成候选（说法1）。');
      expect((await read()).turns.map((turn) => turn.state)).toEqual(['completed', 'completed', 'failed', 'completed']);
      expect(await modelCalls(rewriteBackend)).toBe(beforeReopen + 1);
      await selectMenu(reopened, 'NotAlone', '退出 NotAlone');
      await expect.poll(() => nextProcess.exitCode).toBe(0);
      await writeFile(test.info().outputPath('assistant-native-acceptance.json'), JSON.stringify({
        helperClosedGenerationCompleted: true, menuQuitInterrupted: true, savedCompletionsPreserved: true,
        lateResultNotRevived: true, reopenModelDelta: 0, explicitRetryModelDelta: 1,
        sourceApp: !process.env.NOTALONE_TEST_APP_EXECUTABLE, launches: 2,
        ocrRun: false, wechatRead: false, externalModelCalls: 0, externalMessagesSent: 0,
        foregroundAdapter: 'synthetic-non-wechat',
      }), { mode: 0o600 });
    } finally {
      await rewriteBackend.command('release');
      // 仅回收本轮持有的App；失败后的兜底关闭不算产品验收通过。
      if (reopened && reopenedProcess?.exitCode === null && reopenedProcess.signalCode === null) await reopened.close();
    }
  });
