import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { test, selectMenu } from './app-fixture';

// 接缝是公开按钮、原生窗口/菜单和可见结果，不读取界面的私有状态。
test('管理后台和输入小窗可独立打开、关闭隐藏并恢复，退出回收进程', async ({ runningApp: { app, appProcess } }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('heading', { name: '联系人与绑定' })).toBeVisible();
  const helperOpened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  const helper = await helperOpened;
  await expect(helper).toHaveTitle('NotAlone · 输入小窗');
  await expect(helper.getByRole('textbox', { name: '草稿' })).toBeVisible();
  await expect(helper.getByRole('button', { name: '生成候选' })).toBeDisabled();

  await helper.getByRole('button', { name: '隐藏输入小窗' }).click();
  await expect.poll(() => visible(app, helper)).toBe(false);
  await expect.poll(() => visible(app, manager)).toBe(true);
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  await expect.poll(() => visible(app, helper)).toBe(true);

  // 原生关窗等价于用户点击 macOS 标题栏关闭，不调用产品内部方法。
  await (await app.browserWindow(manager)).evaluate((window) => window.close());
  await expect.poll(() => visible(app, manager)).toBe(false);
  await helper.getByRole('button', { name: '打开管理后台' }).click();
  await expect.poll(() => visible(app, manager)).toBe(true);

  await (await app.browserWindow(manager)).evaluate((window) => window.close());
  await (await app.browserWindow(helper)).evaluate((window) => window.close());
  await selectMenu(app, '窗口', '管理后台');
  await expect.poll(() => visible(app, manager)).toBe(true);
  await selectMenu(app, '窗口', '输入小窗');
  await expect.poll(() => visible(app, helper)).toBe(true);
  await expect(manager.getByRole('status')).toContainText('尚未连接');

  await helper.screenshot({ path: test.info().outputPath('input-window.png') });
  await manager.screenshot({ path: test.info().outputPath('manager-window.png') });
  await selectMenu(app, 'NotAlone', '退出 NotAlone');
  await expect.poll(() => appProcess.exitCode).toBe(0);
});

test('原生菜单整体隐藏后仅恢复所选窗口，不展开另一窗口', async ({ runningApp: { app } }) => {
  const manager = await app.firstWindow();
  const helperOpened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  const helper = await helperOpened;
  await expect.poll(() => visible(app, manager)).toBe(true);
  await expect.poll(() => visible(app, helper)).toBe(true);

  await selectMenu(app, 'NotAlone', '隐藏 NotAlone');
  await expect.poll(() => app.evaluate(({ app }) => app.isHidden())).toBe(true);
  await selectMenu(app, '窗口', '输入小窗');
  await expect.poll(() => app.evaluate(({ app }) => app.isHidden())).toBe(false);
  await expect.poll(() => visible(app, helper)).toBe(true);
  await attachWindowState(app, '只恢复输入小窗');
  await expect.poll(() => visible(app, manager)).toBe(false);

  await selectMenu(app, '窗口', '管理后台');
  await expect.poll(() => visible(app, manager)).toBe(true);
  await selectMenu(app, 'NotAlone', '隐藏 NotAlone');
  await expect.poll(() => app.evaluate(({ app }) => app.isHidden())).toBe(true);
  await selectMenu(app, '窗口', '管理后台');
  await expect.poll(() => app.evaluate(({ app }) => app.isHidden())).toBe(false);
  await expect.poll(() => visible(app, manager)).toBe(true);
  await attachWindowState(app, '只恢复管理后台');
  await expect.poll(() => visible(app, helper)).toBe(false);
  expect(app.windows()).toHaveLength(2);
});

test('界面显示品牌资源和真实未就绪状态，不提供假联系人、候选或复制结果', async ({ runningApp: { app } }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('img', { name: 'NotAlone', exact: true })).toBeVisible();
  await expect.poll(() => manager.getByRole('img', { name: 'NotAlone', exact: true })
    .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0)).toBe(true);
  await expect(manager.getByText('联系人暂不可用', { exact: true })).toBeVisible();
  for (const page of ['历史导入', '关系资料', '同步设置', '应用配置']) {
    await manager.getByRole('button', { name: page, exact: true }).click();
    await expect(manager.getByRole('heading', { name: page, exact: true })).toBeVisible();
    await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
  }
  await manager.getByRole('button', { name: '历史导入', exact: true }).click();
  await expect(manager.getByRole('button', { name: '选择历史文件' })).toBeDisabled();
  const helperOpened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  const helper = await helperOpened;
  await expect(helper.getByRole('combobox', { name: '本次联系人' })).toBeDisabled();
  await expect(helper.getByText('本次联系人：未确认', { exact: true })).toBeVisible();
  await expect(helper.getByText('暂无候选', { exact: true })).toBeVisible();
  await expect(helper.getByRole('button', { name: '生成候选' })).toBeDisabled();
  await expect(helper.getByRole('button', { name: '复制', exact: true })).toBeDisabled();
  await expect(helper.getByRole('button', { name: '复制并收起' })).toBeDisabled();
});

async function visible(app: ElectronApplication, page: Page): Promise<boolean> {
  return (await app.browserWindow(page)).evaluate((window) => window.isVisible());
}

async function attachWindowState(app: ElectronApplication, name: string): Promise<void> {
  const state = await app.evaluate(({ app, BrowserWindow }) => ({
    appHidden: app.isHidden(),
    windows: BrowserWindow.getAllWindows().map((window) => ({
      id: window.id, title: window.getTitle(), visible: window.isVisible(), minimized: window.isMinimized(),
    })),
  }));
  await test.info().attach(name, { body: JSON.stringify(state, null, 2), contentType: 'application/json' });
}
