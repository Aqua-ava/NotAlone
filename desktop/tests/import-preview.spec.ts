import { createImportContact, openFileImport } from './file-import-navigation';
import { expect, type ElectronApplication, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readContactHttp, test as contactTest, type ContactFixture } from './contact-fixture';
import { ContactHttpProxy } from './contact-http-proxy';

const test = contactTest;
test.use({ databaseMode: 'empty' });

// 只替换系统原生对话框 I/O；实际点击 App 按钮并通过真实后端预览。
async function selectedDialog(app: ElectronApplication, selectedPath: string): Promise<void> {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
  }, selectedPath);
}

async function importHttp(fixture: ContactFixture, endpoint: '/api/imports/preview' | '/api/imports/commit', body: object) {
  const info = await readFile(fixture.infoPath, 'utf8');
  const address = /^address=(127\.0\.0\.1:\d+)$/m.exec(info)?.[1];
  const token = /^token=([^\n]+)$/m.exec(info)?.[1];
  if (!address || !token) throw new Error('本轮导入握手尚未就绪。');
  const response = await fetch(`http://${address}${endpoint}`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, data: await response.json() as Record<string, unknown> };
}

async function chooseNewImport(app: ElectronApplication, filePath: string): Promise<Page> {
  await selectedDialog(app, filePath);
  const manager = await app.firstWindow();
  await createImportContact(manager, '预览合成联系人');
  await openFileImport(manager);
  await manager.getByRole('button', { name: '选择历史文件', exact: true }).click();
  return manager;
}

async function syntheticFile(fixture: ContactFixture, fileName = 'synthetic-import.jsonl'): Promise<string> {
  const filePath = path.join(fixture.directory, fileName);
  await writeFile(filePath, await readFile(path.resolve('../backend/tests/fixtures/valid_single_contact.jsonl')));
  return filePath;
}

async function confirmVisiblePreview(manager: Page): Promise<void> {
  await manager.getByRole('checkbox', { name: '我已核对本人渠道身份、联系人和这份文件的资料范围' }).check();
  await manager.getByRole('button', { name: '确认本次预览', exact: true }).click();
  await expect(manager.getByText('已确认本次预览，尚未保存资料。', { exact: true })).toBeVisible();
}

test('主动选择单联系人历史并核对预览，确认不会提前保存资料', async ({ runningApp: { app }, contactBackend }) => {
  const filePath = path.join(contactBackend.directory, 'single-contact.jsonl');
  await writeFile(filePath, await readFile(path.resolve('../backend/tests/fixtures/valid_single_contact.jsonl')));
  await selectedDialog(app, filePath);
  const manager = await app.firstWindow();
  await createImportContact(manager, '首次预览合成联系人');
  await openFileImport(manager);
  await manager.getByRole('button', { name: '选择历史文件', exact: true }).click();
  await expect(manager.getByText('single-contact.jsonl', { exact: true })).toBeVisible();
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  const preview = manager.getByRole('region', { name: '单联系人资料预览' });
  await expect(preview.getByText('6 条记录', { exact: true })).toBeVisible();
  await expect(preview.getByText('wxid_synthetic_owner', { exact: true })).toBeVisible();
  await expect(preview.getByText('wxid_synthetic_contact', { exact: true })).toBeVisible();
  await expect(preview.getByText('首次预览合成联系人', { exact: true })).toBeVisible();
  await expect(preview.getByText('尚未保存资料', { exact: true })).toBeVisible();
  await manager.getByRole('checkbox', { name: '我已核对本人渠道身份、联系人和这份文件的资料范围' }).check();
  await manager.getByRole('button', { name: '确认本次预览', exact: true }).click();
  await expect(manager.getByText('已确认本次预览，尚未保存资料。', { exact: true })).toBeVisible();
  await expectNoImportedRecords(manager, contactBackend);
  await manager.screenshot({ path: test.info().outputPath('import-preview.png') });
});

test('导航返回后仍准确显示本次新联系人名称，重新预览须重新核对', async ({ runningApp: { app }, contactBackend }) => {
  const filePath = path.join(contactBackend.directory, 'return-preview.jsonl');
  await writeFile(filePath, await readFile(path.resolve('../backend/tests/fixtures/valid_single_contact.jsonl')));
  const manager = await chooseNewImport(app, filePath);
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await manager.getByRole('checkbox', { name: '我已核对本人渠道身份、联系人和这份文件的资料范围' }).check();
  await manager.getByRole('button', { name: '联系人', exact: true }).click();
  await openFileImport(manager);
  await expect(manager.getByRole('combobox', { name: '本次联系人', exact: true }).locator('option:checked')).toHaveText('预览合成联系人');
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await expect(manager.getByRole('checkbox', { name: '我已核对本人渠道身份、联系人和这份文件的资料范围' })).not.toBeChecked();
  await expect(manager.getByRole('button', { name: '确认本次预览', exact: true })).toBeDisabled();
});

test('文件内容变动后旧预览不能确认，重新预览才可确认新范围', async ({ runningApp: { app }, contactBackend }) => {
  const filePath = await syntheticFile(contactBackend);
  const manager = await chooseNewImport(app, filePath);
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await expect(manager.getByRole('region', { name: '单联系人资料预览' })).toBeVisible();
  const oldRevision = (await manager.evaluate(() => window.notalone.imports.getState())).selectionRevision;
  const records = (await readFile(filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  records[0].text = '只用于文件变动验收的合成文字。';
  await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  await manager.getByRole('checkbox', { name: '我已核对本人渠道身份、联系人和这份文件的资料范围' }).check();
  await manager.getByRole('button', { name: '确认本次预览', exact: true }).click();
  await expect(manager.getByRole('alert')).toHaveText('文件内容已变化，请重新预览并确认。');
  await expect(manager.getByRole('region', { name: '单联系人资料预览' })).toHaveCount(0);
  expect(await manager.evaluate(async (revision) => {
    try { await window.notalone.imports.confirmPreview({ selectionRevision: revision }); return 'accepted'; }
    catch { return 'rejected'; }
  }, oldRevision)).toBe('rejected');
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await confirmVisiblePreview(manager);
  await expectNoImportedRecords(manager, contactBackend);
});

test('换文件或取消新的文件选择后，旧确认立即撤销', async ({ runningApp: { app }, contactBackend }) => {
  const first = await syntheticFile(contactBackend, 'first.jsonl');
  const second = await syntheticFile(contactBackend, 'second.jsonl');
  const manager = await chooseNewImport(app, first);
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await confirmVisiblePreview(manager);
  const revision = (await manager.evaluate(() => window.notalone.imports.getState())).selectionRevision;
  await selectedDialog(app, second);
  await manager.getByRole('button', { name: '选择历史文件', exact: true }).click();
  await expect(manager.getByText('second.jsonl', { exact: true })).toBeVisible();
  await expect(manager.getByText('已确认本次预览，尚未保存资料。', { exact: true })).toHaveCount(0);
  expect(await manager.evaluate(async (selectionRevision) => {
    try { await window.notalone.imports.confirmPreview({ selectionRevision }); return 'accepted'; }
    catch { return 'rejected'; }
  }, revision)).toBe('rejected');
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await confirmVisiblePreview(manager);
  await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
  await manager.getByRole('button', { name: '选择历史文件', exact: true }).click();
  await expect(manager.getByText('尚未选择文件', { exact: true })).toBeVisible();
  await expect(manager.getByRole('button', { name: '预览资料范围', exact: true })).toBeDisabled();
  await expect(manager.getByText('已确认本次预览，尚未保存资料。', { exact: true })).toHaveCount(0);
});

test('主动取消本次确认后旧确认不能复用', async ({ runningApp: { app }, contactBackend }) => {
  const manager = await chooseNewImport(app, await syntheticFile(contactBackend));
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await confirmVisiblePreview(manager);
  const revision = (await manager.evaluate(() => window.notalone.imports.getState())).selectionRevision;
  await manager.getByRole('button', { name: '取消本次确认', exact: true }).click();
  await expect(manager.getByText('已确认本次预览，尚未保存资料。', { exact: true })).toHaveCount(0);
  await expect(manager.getByRole('region', { name: '单联系人资料预览' })).toHaveCount(0);
  expect(await manager.evaluate(async (selectionRevision) => {
    try { await window.notalone.imports.confirmPreview({ selectionRevision }); return 'accepted'; }
    catch { return 'rejected'; }
  }, revision)).toBe('rejected');
});

for (const invalid of ['mixed', 'broken', 'group', 'multiple-owners'] as const) test(`${invalid} 合成资料被拒绝且不增加联系人或消息`, async ({ runningApp: { app }, contactBackend }) => {
  const filePath = await syntheticFile(contactBackend, `${invalid}.jsonl`);
  if (invalid === 'mixed') await writeFile(filePath, await readFile(path.resolve('../backend/tests/fixtures/mixed_contacts.jsonl')));
  else if (invalid === 'broken') await writeFile(filePath, '{损坏的合成 JSONL');
  else {
    const records = (await readFile(filePath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    if (invalid === 'group') {
      for (const record of records) {
        record.id.talker = 'synthetic-room@chatroom';
        if (!record.is_from_me && record.kind !== 'system') record.sender_wxid = 'synthetic-room@chatroom';
      }
    } else {
      const owner = structuredClone(records.find((record) => record.is_from_me && record.kind !== 'system'));
      owner.id.local_id += 100; owner.create_time += 100; owner.sender_wxid = 'wxid_other_synthetic_owner';
      records.push(owner);
    }
    await writeFile(filePath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  }
  const manager = await chooseNewImport(app, filePath);
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await expect(manager.getByRole('alert')).toHaveText('预览已拒绝。请提供有效的单联系人 JSONL 文件；混合联系人、群聊、损坏或身份不明确的资料不能导入。');
  await expect(manager.getByRole('region', { name: '单联系人资料预览' })).toHaveCount(0);
  await expectNoImportedRecords(manager, contactBackend);
});

test('库内本人渠道冲突在页面明确拒绝，既有资料保持原范围', async ({ runningApp: { app }, contactBackend }) => {
  const filePath = await syntheticFile(contactBackend);
  const manager = await app.firstWindow();
  await expect(manager.getByText('还没有联系人', { exact: true })).toBeVisible({ timeout: 15_000 });
  const imported = await importHttp(contactBackend, '/api/imports/commit', { path: filePath, new_contact_name: '已导入合成联系人' });
  expect(imported.status).toBe(200);
  await writeFile(filePath, (await readFile(filePath, 'utf8')).replaceAll('wxid_synthetic_owner', 'wxid_changed_owner'));
  await chooseNewImport(app, filePath);
  const before = await readContactHttp(contactBackend);
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await expect(manager.getByRole('alert')).toHaveText('本人或联系人渠道身份不一致，预览已拒绝。请检查文件或重新选择联系人。');
  expect(await readContactHttp(contactBackend)).toEqual(before);
});

test('渲染层不能提供文件路径或选择目录外联系人，也不取得摘要或路径', async ({ runningApp: { app }, contactBackend }) => {
  const filePath = await syntheticFile(contactBackend);
  await writeFile(path.join(contactBackend.directory, 'unselected.jsonl'), '未选择的损坏文件不得影响预览。');
  const manager = await chooseNewImport(app, filePath);
  await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
  await expect(manager.getByRole('region', { name: '单联系人资料预览' })).toBeVisible();
  expect(await manager.evaluate(async (foreignContact) => {
    const results = [];
    try {
      // @ts-expect-error 非法参数用于验证具名公开桥接拒绝任意路径。
      await window.notalone.imports.chooseFile('/synthetic/arbitrary.jsonl'); results.push('accepted');
    } catch { results.push('rejected'); }
    try { await window.notalone.imports.setTarget({ kind: 'existing', contactId: foreignContact }); results.push('accepted'); }
    catch { results.push('rejected'); }
    return results;
  }, contactBackend.data.other_contact_id)).toEqual(['rejected', 'rejected']);
  const state = await manager.evaluate(() => window.notalone.imports.getState());
  expect(JSON.stringify(state)).not.toContain(filePath);
  expect(JSON.stringify(state)).not.toContain('content_sha256');
  await expect(manager.getByRole('region', { name: '单联系人资料预览' })).toContainText('6 条记录');
  await expectNoImportedRecords(manager, contactBackend);
});

test.describe('已有联系人确认', () => {
  test.use({ databaseMode: 'ready' });
  test('只选一位既有联系人，切换归属后旧预览与确认失效', async ({ runningApp: { app }, contactBackend }) => {
    const filePath = await syntheticFile(contactBackend);
    await selectedDialog(app, filePath);
    const manager = await app.firstWindow();
    await openFileImport(manager);
    await manager.getByRole('combobox', { name: '本次联系人', exact: true }).selectOption(contactBackend.data.contact_ids[0]);
    await manager.getByRole('button', { name: '选择历史文件', exact: true }).click();
    await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
    await expect(manager.getByRole('region', { name: '单联系人资料预览' })).toContainText('合成联系人甲');
    await confirmVisiblePreview(manager);
    const revision = (await manager.evaluate(() => window.notalone.imports.getState())).selectionRevision;
    await manager.getByRole('combobox', { name: '本次联系人' }).selectOption(contactBackend.data.contact_ids[1]);
    await expect(manager.getByRole('region', { name: '单联系人资料预览' })).toHaveCount(0);
    await expect(manager.getByText('已确认本次预览，尚未保存资料。', { exact: true })).toHaveCount(0);
    expect(await manager.evaluate(async (selectionRevision) => {
      try { await window.notalone.imports.confirmPreview({ selectionRevision }); return 'accepted'; }
      catch { return 'rejected'; }
    }, revision)).toBe('rejected');
    await expect(manager.getByRole('button', { name: '预览资料范围', exact: true })).toBeDisabled();
    await manager.getByRole('button', { name: '选择历史文件', exact: true }).click();
    await manager.getByRole('button', { name: '预览资料范围', exact: true }).click();
    await expect(manager.getByRole('region', { name: '单联系人资料预览' })).toContainText('合成联系人乙');
  });
});

const staleTest = contactTest.extend<{ importProxy: ContactHttpProxy }>({
  importProxy: [async ({ contactBackend }, use) => {
    const proxy = await ContactHttpProxy.attach(contactBackend.infoPath, '/api/imports/preview');
    try { await use(proxy); } finally { await proxy.close(); }
  }, { auto: true }],
});

staleTest.describe('双窗口预览范围失效', () => {
  staleTest.use({ databaseMode: 'ready', backendMode: 'reused' });
  for (const failure of [false, true]) staleTest(`另一窗口切换联系人后旧预览的迟到${failure ? '失败' : '成功'}不能恢复确认`, async ({ runningApp: { app }, contactBackend, importProxy }) => {
    const manager = await chooseNewImport(app, await syntheticFile(contactBackend));
    importProxy.holdContacts = true;
    // 公开预览 Promise 用于等待真实在途 HTTP 收尾；结果仍由实际两窗可见状态判断。
    const pending = manager.evaluate(async () => {
      const state = await window.notalone.imports.getState();
      await window.notalone.imports.preview({ selectionRevision: state.selectionRevision });
    });
    await expect.poll(() => importProxy.heldCount).toBe(1);
    const opened = app.waitForEvent('window');
    await manager.getByRole('button', { name: '打开输入小窗' }).click();
    const helper = await opened;
    await helper.getByRole('combobox', { name: '本次联系人' }).selectOption(contactBackend.data.contact_ids[0]);
    await expect(manager.getByText('尚未选择文件', { exact: true })).toBeVisible();
    importProxy.release(failure);
    await pending;
    await expect(manager.getByRole('region', { name: '单联系人资料预览' })).toHaveCount(0);
    await expect(manager.getByRole('button', { name: '预览资料范围', exact: true })).toBeDisabled();
    await expect(manager.getByRole('alert')).toHaveCount(0);
    await expect(helper.getByRole('combobox', { name: '本次联系人', exact: true }).locator('option:checked')).toHaveText('合成联系人甲');
  });
});

async function expectNoImportedRecords(manager: Page, fixture: ContactFixture): Promise<void> {
  const contact = await manager.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    return state.contacts.find(entry => entry.contactId === state.selectedContactId)!;
  });
  expect(await readContactHttp(fixture)).toEqual({ contacts: [{ contact_id: contact.contactId,
    display_name: contact.displayName, data_status: { message_count: 0, source_count: 0 } }] });
}
