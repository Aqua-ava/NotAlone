import { expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from './import-fixture';
import { test as bootstrapTest } from './contact-fixture';
import { confirmImport, originalImport } from './import-app-actions';

test('正式导入刷新真实联系人来源并核验五步，同一联系人重复导入复用原任务', async ({ runningApp: { app }, importBackend }) => {
  const manager = await confirmImport(app, importBackend.data.file_path);
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  const progress = manager.getByRole('region', { name: '本次导入处理', exact: true });
  await expect(progress.getByText('新增 6 条消息，已存在 0 条消息。', { exact: true })).toBeVisible();
  await expect(progress.getByText('原任务全部步骤和最终核验已成功。', { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(progress.getByRole('region', { name: '归属联系人来源', exact: true })).toContainText('synthetic-import.jsonl · 6 条 · 有效来源');
  const original = await originalImport(importBackend);
  const first = await importBackend.task(original);
  expect((first.data.steps as Array<{ status: string }>).map((step) => step.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded', 'succeeded']);
  await manager.getByRole('button', { name: '联系人与绑定', exact: true }).click();
  await expect(manager.getByRole('button', { name: '选择合成导入联系人', exact: true })).toBeVisible();
  await confirmImport(app, importBackend.data.file_path, original.contact_id);
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  await expect(progress.getByText('新增 0 条消息，已存在 6 条消息。', { exact: true })).toBeVisible();
  await expect(progress.getByText('原任务全部步骤和最终核验已成功。', { exact: true })).toBeVisible();
  expect(await importBackend.task(original)).toEqual(first);
  expect((await importBackend.request(`/api/contacts/${original.contact_id}/sources`)).data.sources).toHaveLength(1);
  await manager.screenshot({ path: test.info().outputPath('import-task-completed.png') });
});

test('确认后文件变化在正式保存时拒绝，失败不能复用旧确认或带任意路径', async ({ runningApp: { app }, importBackend }) => {
  const manager = await confirmImport(app, importBackend.data.file_path);
  const revision = (await manager.evaluate(() => window.notalone.imports.getState())).selectionRevision;
  const original = await readFile(importBackend.data.file_path, 'utf8');
  await writeFile(importBackend.data.file_path, original.replace('我平时喜欢茉莉茶。', '预览后更改的合成文字。'));
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  await expect(manager.getByRole('alert')).toHaveText('文件内容已变化，请重新预览并确认。');
  await expect(manager.getByRole('region', { name: '本次导入处理', exact: true })).toHaveCount(0);
  expect((await importBackend.request('/api/contacts')).data.contacts).toHaveLength(2);
  expect(await manager.evaluate(async (selectionRevision) => {
    const outcomes = [];
    try { await window.notalone.imports.submit({ selectionRevision }); outcomes.push('accepted'); } catch { outcomes.push('rejected'); }
    try {
      // @ts-expect-error 非法调用验证具名桥接拒绝额外路径，不通过私有 IPC。
      await window.notalone.imports.submit({ selectionRevision, path: '/synthetic/arbitrary.jsonl' }); outcomes.push('accepted');
    } catch { outcomes.push('rejected'); }
    return outcomes;
  }, revision)).toEqual(['rejected', 'rejected']);
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await manager.getByRole('checkbox', { name: '我已核对本人渠道身份、联系人和这份文件的资料范围' }).check();
  await manager.getByRole('button', { name: '确认本次预览', exact: true }).click();
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  await expect(manager.getByText('新增 6 条消息，已存在 0 条消息。', { exact: true })).toBeVisible();
});

test('真实模型失败显示原步骤，重试只恢复失败任务并保留成功步骤', async ({ runningApp: { app }, importBackend }) => {
  await importBackend.command('fail-extraction');
  const manager = await confirmImport(app, importBackend.data.file_path);
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  const progress = manager.getByRole('region', { name: '本次导入处理', exact: true });
  await expect(progress.getByRole('heading', { name: '处理失败', exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(progress.getByText('关系提取未完成，已保存的消息保留，可重试原失败任务。', { exact: true }).first()).toBeVisible();
  await expect(progress.getByText('原任务全部步骤和最终核验已成功。', { exact: true })).toHaveCount(0);
  const imported = await originalImport(importBackend);
  const failed = await importBackend.task(imported);
  await manager.getByRole('button', { name: '重试原失败任务', exact: true }).click();
  await expect(progress.getByText('原任务全部步骤和最终核验已成功。', { exact: true })).toBeVisible({ timeout: 20_000 });
  const recovered = await importBackend.task(imported);
  expect(recovered.data.task_id).toBe(failed.data.task_id);
  expect((recovered.data.steps as unknown[]).slice(0, 2)).toEqual((failed.data.steps as unknown[]).slice(0, 2));
  expect(JSON.stringify(await manager.evaluate(() => window.notalone.imports.getState()))).not.toContain('原始错误');
  expect((await importBackend.request(`/api/contacts/${imported.contact_id}/messages`)).data.messages).toHaveLength(6);
});

test('导入后台模型等待时小窗仍能发起当前已绑定联系人的候选，前台生成期间后台让位', async ({ runningApp: { app }, importBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opened;
  await importBackend.command('hold-extraction');
  await importBackend.command('hold-reply');
  await confirmImport(app, importBackend.data.file_path);
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  await expect.poll(async () => (await importBackend.command('observations')).extraction_entered).toBe(true);
  await helper.getByRole('textbox', { name: '草稿', exact: true }).fill('我会晚一点回复你。');
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
  await importBackend.command('release-extraction');
  await expect.poll(async () => (await importBackend.command('observations')).reply_entered).toBe(true);
  const imported = await originalImport(importBackend);
  expect((await importBackend.task(imported)).data.status).toBe('running');
  expect((await importBackend.command('observations')).extraction_calls).toBe(1);
  await importBackend.command('release-reply');
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我会晚一点回复你。');
  const observations = await importBackend.command('observations');
  expect(JSON.stringify(observations.reply_outbound)).not.toContain('茉莉茶');
  expect((observations.tool_names as string[]).some((name) => name.includes('send'))).toBe(false);
});

bootstrapTest.describe('首份渠道身份重装配', () => {
  bootstrapTest.use({ databaseMode: 'empty' });
  bootstrapTest('首份导入后用户明确认证停读重启装配 SyncHost，导入不新增同步授权', async ({ runningApp: { app }, contactBackend }) => {
    const filePath = path.join(contactBackend.directory, 'first-owner.jsonl');
    await writeFile(filePath, await readFile(path.resolve('../backend/tests/fixtures/valid_single_contact.jsonl')));
    const manager = await confirmImport(app, filePath);
    await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
    await expect(manager.getByText('新增 6 条消息，已存在 0 条消息。', { exact: true })).toBeVisible();
    const reload = manager.getByRole('button', { name: '认证停读并重新加载同步服务', exact: true });
    await expect(reload).toBeEnabled();
    const before = await readFile(contactBackend.infoPath, 'utf8');
    await reload.click();
    await expect(manager.getByText('同步服务已重新加载。请在同步设置中主动选择并确认会话授权；如需查看原导入任务，请重新预览确认同一份文件。', { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(await readFile(contactBackend.infoPath, 'utf8')).not.toBe(before);
    expect((await contactBackend.request('/api/sync/cli-bindings' as '/api/contacts')).data.bindings).toEqual([]);
    expect((await contactBackend.request('/api/contacts')).data.contacts).toHaveLength(1);
  });
});
