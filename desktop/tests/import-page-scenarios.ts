import { openFileImport } from './file-import-navigation';
import { confirmHelperContact } from './foreground-confirmation-actions';
import { expect, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContactFixture } from './contact-backend-fixture';
import { requestFixtureHttp } from './fixture-transport';
import type { ImportFixture } from './import-backend-fixture';
import type { ContactHttpProxy } from './contact-http-proxy';

export type ImportPages = {
  manager: Page; helper: Page; importBackend: ImportFixture;
  chooseFile(filePath: string): Promise<void>;
  screenshotPath?: string;
};

// 文件输入由测试宿主拥有，页面仅使用生产具名选择和预览确认入口。
export async function confirmImportPage(manager: Page, target?: string): Promise<void> {
  await openFileImport(manager);
  await manager.getByRole('button', { name: '选择历史文件', exact: true }).click();
  await manager.getByRole('combobox', { name: '资料归属联系人' }).selectOption(target ?? 'new');
  if (!target) await manager.getByRole('textbox', { name: '新联系人名称' }).fill('合成导入联系人');
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await manager.getByRole('checkbox', { name: '我已核对本人渠道身份、联系人和这份文件的资料范围' }).check();
  await manager.getByRole('button', { name: '确认本次预览', exact: true }).click();
  await expect(manager.getByText('已确认本次预览，尚未保存资料。', { exact: true })).toBeVisible();
}
async function confirm(pages: ImportPages, filePath: string, target?: string): Promise<void> {
  await pages.chooseFile(filePath);
  await confirmImportPage(pages.manager, target);
}
export async function originalImport(fixture: ImportFixture) {
  const response = await fixture.request('/api/contacts');
  expect(response.status).toBe(200);
  const contact = (response.data.contacts as Array<{ contact_id: string; display_name: string }>).find((item) => item.display_name === '合成导入联系人');
  if (!contact) throw new Error('本轮合成联系人尚未保存。');
  const repeated = await fixture.request('/api/imports/commit', { path: fixture.data.file_path, contact_id: contact.contact_id });
  expect(repeated.status).toBe(200);
  return repeated.data as { contact_id: string; task_id: string };
}

export async function savedImport(pages: ImportPages): Promise<void> {
  const { manager, helper, importBackend } = pages;
  await confirm(pages, importBackend.data.file_path);
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
  await confirm(pages, importBackend.data.file_path, original.contact_id);
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  await expect(progress.getByText('新增 0 条消息，已存在 6 条消息。', { exact: true })).toBeVisible();
  await expect(progress.getByText('原任务全部步骤和最终核验已成功。', { exact: true })).toBeVisible();
  expect(await importBackend.task(original)).toEqual(first);
  expect((await importBackend.request(`/api/contacts/${original.contact_id}/sources`)).data.sources).toHaveLength(1);
  if (pages.screenshotPath) await manager.screenshot({ path: pages.screenshotPath });
}

export async function changedImport(pages: ImportPages): Promise<void> {
  const { manager, helper, importBackend } = pages;
  expect(await helper.evaluate(async () => {
    const outcomes: string[] = [];
    for (const action of [() => window.notalone.imports.chooseFile(),
      () => window.notalone.imports.setTarget({ kind: 'new', displayName: '未授权联系人' }),
      () => window.notalone.imports.submit({ selectionRevision: 0 })]) {
      try { await action(); outcomes.push('accepted'); } catch { outcomes.push('rejected'); }
    }
    return outcomes;
  })).toEqual(['rejected', 'rejected', 'rejected']);
  expect(await manager.evaluate(async () => {
    try {
      // @ts-expect-error 具名选择不接受路径或角色，由真实host核验页面来源。
      await window.notalone.imports.chooseFile({ path: '/synthetic/arbitrary.jsonl', role: 'manager' });
      return 'accepted';
    } catch { return 'rejected'; }
  })).toBe('rejected');
  expect(await manager.evaluate(async (contactId) => {
    try { await window.notalone.imports.setTarget({ kind: 'existing', contactId }); return 'accepted'; }
    catch { return 'rejected'; }
  }, importBackend.data.other_contact_id)).toBe('rejected');
  await confirm(pages, importBackend.data.file_path);
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
}

export async function failedImportRecovery(pages: ImportPages): Promise<void> {
  const { manager, helper, importBackend } = pages;
  await importBackend.command('fail-extraction');
  await confirm(pages, importBackend.data.file_path);
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
}

export async function priorityImport(pages: ImportPages): Promise<void> {
  const { manager, helper, importBackend } = pages;
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirmHelperContact(helper, importBackend.data.contact_ids[0]);
  const prepared = await importBackend.command('prepare-priority-import');
  await importBackend.command('hold-reply');
  await confirm(pages, prepared.file_path as string);
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  await expect.poll(async () => (await importBackend.command('observations')).extraction_entered).toBe(true);
  await helper.getByRole('textbox', { name: '有什么想说的', exact: true }).fill('我会晚一点回复你。');
  await helper.getByRole('button', { name: '帮我表达', exact: true }).click();
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveCount(0);
  // 点击完成不证明 HTTP 已进入优先级等待；逐个释放已开始的模型调用，
  // 直到真实回复模型进入。最多释放三次，始终留下至少一次后续模型工作。
  for (let released = 0; released < 3; released++) {
    const before = await importBackend.command('observations');
    if (before.reply_entered) break;
    await importBackend.command('release-active-extraction');
    await expect.poll(async () => {
      const observed = await importBackend.command('observations');
      return observed.reply_entered || Number(observed.extraction_calls) > Number(before.extraction_calls);
    }).toBe(true);
  }
  const active = await importBackend.command('observations');
  expect(active.reply_entered).toBe(true);
  expect(Number(active.extraction_calls)).toBeLessThan(4);
  const receipt = await manager.evaluate(async () => (await window.notalone.imports.getState()).submission?.receipt);
  if (!receipt) throw new Error('本轮公开导入收据尚未就绪。');
  const imported = { contact_id: receipt.contactId, task_id: receipt.taskId };
  await importBackend.command('release-extraction');
  expect(await importBackend.command('observe-next-extraction')).toEqual({
    next_extraction_entered: false, extraction_calls: active.extraction_calls,
  });
  expect((await importBackend.task(imported)).data.status).toBe('running');
  await importBackend.command('release-reply');
  await expect(helper.getByRole('textbox', { name: '候选1编辑文本', exact: true })).toHaveValue('我会晚一点回复你。');
  await expect.poll(async () => (await importBackend.task(imported)).data.status, { timeout: 20_000 }).toBe('succeeded');
  const observations = await importBackend.command('observations');
  expect(Number(observations.extraction_calls)).toBeGreaterThan(Number(active.extraction_calls));
  expect(JSON.stringify(observations.reply_outbound)).not.toContain('茉莉茶');
  expect((observations.tool_names as string[]).some((name) => name.includes('send'))).toBe(false);
}

export type ImportStalePages = ImportPages & { importProxy: ContactHttpProxy };
// 等待公开操作实际结束，避免页面尚未收到迟到结果时就判定旧响应失效。
function pendingImportSubmit(manager: Page): Promise<string> {
  return manager.evaluate(async () => {
    const { selectionRevision } = await window.notalone.imports.getState();
    try { await window.notalone.imports.submit({ selectionRevision }); return 'completed'; }
    catch { return 'rejected'; }
  });
}

export async function staleImportViewing(pages: ImportStalePages, failure: boolean): Promise<void> {
  const { manager, helper, importBackend, importProxy } = pages;
  await confirm(pages, importBackend.data.file_path);
  const revision = (await manager.evaluate(() => window.notalone.imports.getState())).selectionRevision;
  importProxy.holdContacts = true;
  const latePromise = pendingImportSubmit(manager);
  await expect.poll(() => importProxy.heldCount).toBe(1);
  await manager.getByRole('button', { name: '停止查看本次提交', exact: true }).click();
  importProxy.release(failure);
  expect(await latePromise).toBe('completed');
  await expect(manager.getByRole('region', { name: '本次导入处理', exact: true })).toHaveCount(0);
  await expect(manager.getByText('已确认本次预览，尚未保存资料。', { exact: true })).toHaveCount(0);
  await expect(manager.getByRole('alert')).toHaveCount(0);
  expect((await importBackend.request('/api/contacts')).data.contacts).toHaveLength(3);
  expect(await manager.evaluate(async (selectionRevision) => {
    try { await window.notalone.imports.submit({ selectionRevision }); return 'accepted'; } catch { return 'rejected'; }
  }, revision)).toBe('rejected');
}

export async function staleImportContact(pages: ImportStalePages, failure: boolean): Promise<void> {
  const { manager, helper, importBackend, importProxy } = pages;
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await confirm(pages, importBackend.data.file_path);
  importProxy.holdContacts = true;
  const latePromise = pendingImportSubmit(manager);
  await expect.poll(() => importProxy.heldCount).toBe(1);
  await helper.getByRole('combobox', { name: '本次联系人' }).selectOption(importBackend.data.contact_ids[1]);
  importProxy.release(failure);
  expect(await latePromise).toBe('completed');
  await expect(manager.getByText('尚未选择文件', { exact: true })).toBeVisible();
  await expect(manager.getByRole('region', { name: '本次导入处理', exact: true })).toHaveCount(0);
  await expect(manager.getByRole('alert')).toHaveCount(0);
  await expect(helper.getByText('本次联系人：合成联系人乙', { exact: true })).toBeVisible();
}

export async function staleImportConnection(pages: ImportStalePages, failure: boolean): Promise<void> {
  const { manager, helper, importBackend, importProxy } = pages;
  await confirm(pages, importBackend.data.file_path);
  importProxy.holdContacts = true;
  const latePromise = pendingImportSubmit(manager);
  await expect.poll(() => importProxy.heldCount).toBe(1);
  importProxy.failRuntimeStatus = true;
  await expect(manager.getByText('本机服务尚未连接', { exact: true })).toBeVisible();
  await importBackend.command('restart');
  await manager.getByRole('button', { name: '重试连接', exact: true }).click();
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible();
  importProxy.release(failure);
  expect(await latePromise).toBe('completed');
  await expect(manager.getByText('尚未选择文件', { exact: true })).toBeVisible();
  await expect(manager.getByRole('region', { name: '本次导入处理', exact: true })).toHaveCount(0);
  await expect(manager.getByRole('alert')).toHaveCount(0);
  expect((await importBackend.request('/api/contacts')).data.contacts).toHaveLength(3);
}

export async function lostImportResponse(pages: ImportStalePages): Promise<void> {
  const { manager, helper, importBackend, importProxy } = pages;
  await confirm(pages, importBackend.data.file_path);
  importProxy.holdContacts = true;
  const latePromise = pendingImportSubmit(manager);
  await expect.poll(() => importProxy.heldCount).toBe(1);
  importProxy.holdContacts = false;
  importProxy.release(true);
  expect(await latePromise).toBe('completed');
  await expect(manager.getByRole('alert')).toContainText('本次保存结果尚未确认');
  await expect(manager.getByRole('region', { name: '本次导入处理', exact: true })).toHaveCount(0);
  const before = await importBackend.request('/api/contacts');
  expect(before.data.contacts).toHaveLength(3);
  await confirm(pages, importBackend.data.file_path);
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  await expect(manager.getByText('新增 0 条消息，已存在 6 条消息。', { exact: true })).toBeVisible();
  expect(await importBackend.request('/api/contacts')).toEqual(before);
}

export async function firstImportBootstrap(manager: Page, contactBackend: ContactFixture,
  chooseFile: (filePath: string) => Promise<void>): Promise<void> {
  await expect(manager.getByText('已连接', { exact: true })).toBeVisible({ timeout: 20_000 });
  const request = (endpoint: string) => requestFixtureHttp(contactBackend.infoPath, endpoint);
  expect((await request('/api/sync/status')).status).toBe(503);
  const filePath = path.join(contactBackend.directory, 'first-owner.jsonl');
  await writeFile(filePath, await readFile(path.resolve('../backend/tests/fixtures/valid_single_contact.jsonl')));
  await chooseFile(filePath);
  await confirmImportPage(manager);
  await manager.getByRole('button', { name: '正式导入这份资料', exact: true }).click();
  await expect(manager.getByText('新增 6 条消息，已存在 0 条消息。', { exact: true })).toBeVisible();
  const receipt = (await manager.evaluate(() => window.notalone.imports.getState())).submission?.receipt;
  if (!receipt) throw new Error('首份导入收据尚未就绪。');
  const reload = manager.getByRole('button', { name: '认证停读并重新加载同步服务', exact: true });
  await expect(reload).toBeEnabled();
  const before = await readFile(contactBackend.infoPath, 'utf8');
  await reload.click();
  await expect(manager.getByText('同步服务已重新加载。请在同步设置中主动选择并确认会话授权；如需查看原导入任务，请重新预览确认同一份文件。', { exact: true })).toBeVisible({ timeout: 20_000 });
  expect(await readFile(contactBackend.infoPath, 'utf8')).not.toBe(before);
  const sync = await request('/api/sync/status');
  expect(sync.status).toBe(200);
  expect(typeof sync.data.sync_enabled).toBe('boolean');
  expect(typeof sync.data.probe_available).toBe('boolean');
  expect(typeof sync.data.cli_available).toBe('boolean');
  expect((await request('/api/sync/cli-bindings')).data.bindings).toEqual([]);
  expect((await request('/api/contacts')).data.contacts).toHaveLength(1);
  expect((await request(`/api/contacts/${receipt.contactId}/sources`)).data.sources).toHaveLength(1);
  expect((await request(`/api/contacts/${receipt.contactId}/messages`)).data.messages).toHaveLength(6);
  // 空模型配置不得把消息保存成功冒充记忆提取完成；重启不自动扫描旧任务。
  const task = await request(`/api/tasks/status?contact_id=${receipt.contactId}&task_id=${receipt.taskId}`);
  expect(task.status).toBe(200);
  expect(task.data.status).toBe('queued');
}
