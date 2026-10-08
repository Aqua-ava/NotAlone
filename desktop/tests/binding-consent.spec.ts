import { expect } from '@playwright/test';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { initialCliState, test } from './binding-fixture';

test('首次没有选择，刷新只保留仍有效的手选，新会话不授权且不读正文', async ({ runningApp: { app }, bindingBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '同步设置', exact: true }).click();
  const metadata = manager.getByRole('region', { name: '待授权会话' });
  const first = metadata.getByRole('checkbox', { name: '选择会话 wxid_synthetic_a' });
  const second = metadata.getByRole('checkbox', { name: '选择会话 wxid_synthetic_b' });
  await expect(first).toBeVisible({ timeout: 15_000 });
  await expect(first).not.toBeChecked();
  await expect(second).not.toBeChecked();
  await expect(manager.getByRole('button', { name: '确认并授权所选会话', exact: true })).toBeDisabled();
  await first.check();
  const state = initialCliState();
  state.sessions.push({ username: 'wxid_synthetic_new', display_name: '新增合成会话', chat_type: 'private', last_timestamp: 1_700_000_001 });
  state.sessions.push({ username: 'synthetic_group', display_name: '合成群聊', chat_type: 'group', last_timestamp: 1_700_000_001 });
  await bindingBackend.setCli(state);
  await manager.getByRole('button', { name: '刷新会话与授权', exact: true }).click();
  await expect(metadata.getByRole('checkbox', { name: '选择会话 wxid_synthetic_new' })).toBeVisible();
  await expect(metadata.getByRole('checkbox', { name: '选择会话 wxid_synthetic_new' })).not.toBeChecked();
  await expect(first).toBeChecked();
  await expect(second).not.toBeChecked();
  await expect(metadata.getByText('合成群聊')).toHaveCount(0);
  expect((await bindingBackend.request('/api/sync/cli-bindings')).data).toEqual({ bindings: [] });
  expect(await bindingBackend.tails()).toEqual([]);
  await manager.screenshot({ path: test.info().outputPath('bindings-unselected-refresh.png') });
});

test('等待本轮超时显示未撤销并保留重试，成功响应后实际 HTTP 检查不再新增 tail', async ({ runningApp: { app }, bindingBackend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status').filter({ hasText: '已连接' })).toBeVisible({ timeout: 15_000 });
  await bindingBackend.request('/api/sync/cli-bindings/confirm', { selections: [
    { locator: 'wxid_synthetic_a', contact_id: bindingBackend.data.contact_ids[0] },
  ] });
  await bindingBackend.request('/api/sync/enable', {});
  await manager.getByRole('button', { name: '同步设置', exact: true }).click();
  await manager.getByRole('button', { name: '刷新会话与授权', exact: true }).click();
  const authorized = manager.getByRole('region', { name: '已授权会话' });
  await authorized.getByRole('button', { name: '撤销会话 wxid_synthetic_a 的后台读取授权', exact: true }).click();
  const dialog = manager.getByRole('dialog', { name: '撤销后台读取授权确认' });
  const gate = path.join(bindingBackend.directory, 'hold-tail-wxid_synthetic_a');
  const reads = (await bindingBackend.tails()).length;
  await writeFile(gate, '');
  const cycle = bindingBackend.request('/api/sync/check', {});
  try {
    await expect.poll(async () => (await bindingBackend.tails()).length).toBeGreaterThan(reads);
    await dialog.getByRole('button', { name: '确认撤销此会话授权', exact: true }).click();
    await expect(dialog.getByText('当前同步仍在收尾，尚未撤销授权。请稍后重新确认撤销。', { exact: true })).toBeVisible({ timeout: 7000 });
    await expect(dialog.getByRole('button', { name: '确认撤销此会话授权', exact: true })).toBeEnabled();
    await expect(manager.getByText('已撤销此会话的后台读取授权，历史资料仍保留。', { exact: true })).toHaveCount(0);
    await manager.screenshot({ path: test.info().outputPath('bindings-revoke-busy.png') });
  } finally { await rm(gate, { force: true }); await cycle; }
  expect(((await bindingBackend.request('/api/sync/cli-bindings')).data.bindings as unknown[]).length).toBe(1);
  await dialog.getByRole('button', { name: '确认撤销此会话授权', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(authorized.getByText('wxid_synthetic_a', { exact: true })).toHaveCount(0);
  const finalReads = await bindingBackend.tails();
  for (let count = 0; count < 2; count++) await bindingBackend.request('/api/sync/check', {});
  expect(await bindingBackend.tails()).toEqual(finalReads);
});

test('元数据改名使旧手选失效，最终提交前失效或已绑定冲突不静默授权', async ({ runningApp: { app }, bindingBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '同步设置', exact: true }).click();
  const pending = manager.getByRole('region', { name: '待授权会话' });
  const choice = pending.getByRole('checkbox', { name: '选择会话 wxid_synthetic_a' });
  const target = pending.getByRole('combobox', { name: '会话 wxid_synthetic_a 对应联系人' });
  const submit = manager.getByRole('button', { name: '确认并授权所选会话', exact: true });
  await choice.check();
  await target.selectOption(bindingBackend.data.contact_ids[0]);
  const state = initialCliState();
  state.sessions[0].display_name = '刷新后新名';
  await bindingBackend.setCli(state);
  await manager.getByRole('button', { name: '刷新会话与授权', exact: true }).click();
  await expect(pending.getByText('刷新后新名', { exact: true })).toBeVisible();
  await expect(choice).not.toBeChecked();
  await choice.check();
  await target.selectOption(bindingBackend.data.contact_ids[0]);
  state.sessions = state.sessions.slice(1);
  await bindingBackend.setCli(state);
  await submit.click();
  await expect(manager.getByText('会话、名称或联系人归属已变化，请重新核对并选择；已有授权不会被静默修改。', { exact: true })).toBeVisible();
  expect((await bindingBackend.request('/api/sync/cli-bindings')).data).toEqual({ bindings: [] });
  await bindingBackend.setCli(initialCliState());
  await manager.getByRole('button', { name: '刷新会话与授权', exact: true }).click();
  await choice.check();
  await target.selectOption(bindingBackend.data.contact_ids[1]);
  await bindingBackend.request('/api/sync/cli-bindings/confirm', { selections: [
    { locator: 'wxid_synthetic_a', contact_id: bindingBackend.data.contact_ids[0] },
  ] });
  await submit.click();
  await expect(manager.getByText('会话、名称或联系人归属已变化，请重新核对并选择；已有授权不会被静默修改。', { exact: true })).toBeVisible();
  const active = (await bindingBackend.request('/api/sync/cli-bindings')).data.bindings as { contact_id: string; display_name: string }[];
  expect(active.map((item) => item.contact_id)).toEqual([bindingBackend.data.contact_ids[0]]);
  expect(active[0].display_name).toBe('同名会话');
  expect(await bindingBackend.tails()).toEqual([]);
});

test('App 复读后服务端最终复读发生改名时整批拒绝，不部分新建联系人或授权', async ({ runningApp: { app }, bindingBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '同步设置', exact: true }).click();
  const pending = manager.getByRole('region', { name: '待授权会话' });
  await pending.getByRole('checkbox', { name: '选择会话 wxid_synthetic_a' }).check();
  await pending.getByRole('combobox', { name: '会话 wxid_synthetic_a 对应联系人' }).selectOption(bindingBackend.data.contact_ids[0]);
  await pending.getByRole('checkbox', { name: '选择会话 wxid_synthetic_b' }).check();
  await pending.getByRole('combobox', { name: '会话 wxid_synthetic_b 对应联系人' }).selectOption('new');
  const contacts = (await bindingBackend.request('/api/contacts')).data;
  const gate = path.join(bindingBackend.directory, 'hold-sessions');
  await writeFile(gate, '');
  try {
    await manager.getByRole('button', { name: '确认并授权所选会话', exact: true }).click();
    await expect.poll(async () => {
      try { await readFile(path.join(bindingBackend.directory, 'held-sessions-ready')); return true; } catch { return false; }
    }).toBe(true);
    const state = initialCliState();
    state.sessions[0].display_name = '服务端最后复读的新名';
    await bindingBackend.setCli(state);
  } finally { await rm(gate, { force: true }); }
  await expect(manager.getByText('会话、名称或联系人归属已变化，请重新核对并选择；已有授权不会被静默修改。', { exact: true })).toBeVisible();
  expect((await bindingBackend.request('/api/sync/cli-bindings')).data).toEqual({ bindings: [] });
  expect((await bindingBackend.request('/api/contacts')).data).toEqual(contacts);
  expect(await bindingBackend.tails()).toEqual([]);
  await expect(pending.getByRole('checkbox', { name: '选择会话 wxid_synthetic_a' })).not.toBeChecked();
  await manager.screenshot({ path: test.info().outputPath('bindings-final-name-stale.png') });
});

test.describe('本人渠道身份尚未确认', () => {
  test.use({ bindingMode: 'no-channel' });
  test('真实同步接口不可用时引导先单联系人历史导入，不伪装就绪', async ({ runningApp: { app }, bindingBackend }) => {
    const manager = await app.firstWindow();
    await manager.getByRole('button', { name: '同步设置', exact: true }).click();
    await expect(manager.getByText('同步宿主尚未就绪', { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(manager.getByRole('button', { name: '前往历史导入', exact: true })).toBeVisible();
    expect((await bindingBackend.request('/api/sync/cli-sessions')).status).toBe(503);
    await expect(manager.getByRole('checkbox')).toHaveCount(0);
    expect(await bindingBackend.tails()).toEqual([]);
  });
});

test('已授权目录在 CLI 不可用时仍能撤销，新增范围诚实显示不可用', async ({ runningApp: { app }, bindingBackend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status').filter({ hasText: '已连接' })).toBeVisible({ timeout: 15_000 });
  await bindingBackend.request('/api/sync/cli-bindings/confirm', { selections: [
    { locator: 'wxid_synthetic_a', contact_id: bindingBackend.data.contact_ids[0] },
  ] });
  await rm(path.join(bindingBackend.directory, 'controlled-cli'));
  await manager.getByRole('button', { name: '同步设置', exact: true }).click();
  await manager.getByRole('button', { name: '刷新会话与授权', exact: true }).click();
  await expect(manager.getByText('无法取得当前 CLI 会话元数据，请检查已安装的只读 CLI 后刷新。已有授权如下显示，仍可明确撤销。', { exact: true })).toBeVisible();
  await expect(manager.getByRole('region', { name: '待授权会话' }).getByRole('checkbox')).toHaveCount(0);
  await manager.getByRole('button', { name: '撤销会话 wxid_synthetic_a 的后台读取授权', exact: true }).click();
  await manager.getByRole('dialog', { name: '撤销后台读取授权确认' }).getByRole('button', { name: '确认撤销此会话授权', exact: true }).click();
  await expect(manager.getByText('已撤销此会话的后台读取授权，历史资料仍保留。', { exact: true })).toBeVisible();
  expect((await bindingBackend.request('/api/sync/cli-bindings')).data).toEqual({ bindings: [] });
  expect(await bindingBackend.tails()).toEqual([]);
});

test('明确新建联系人后才写入，受限具名桥接拒绝零选择、额外参数、跨范围和小窗变更', async ({ runningApp: { app }, bindingBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '同步设置', exact: true }).click();
  const pending = manager.getByRole('region', { name: '待授权会话' });
  await pending.getByRole('checkbox', { name: '选择会话 wxid_synthetic_a' }).check();
  const rejected = await manager.evaluate(async (foreign) => {
    const state = await window.notalone.bindings.getState();
    const bridge = window.notalone.bindings as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    const values = [
      () => bridge.getState('/api/contacts'),
      () => bridge.refresh('/api/sync/enable'),
      () => bridge.confirmSelections({ scopeRevision: state.scopeRevision, selections: [] }),
      () => bridge.confirmSelections({ scopeRevision: state.scopeRevision, ownerId: 'arbitrary', selections: [{ locator: 'wxid_synthetic_a', displayName: '同名会话', contactId: null }] }),
      () => bridge.revokeBinding({ scopeRevision: state.scopeRevision, contactId: foreign.contact_id, bindingId: foreign.binding_id }),
    ];
    return Promise.all(values.map(async (operation) => { try { await operation(); return false; } catch { return true; } }));
  }, bindingBackend.bindingData.foreign_bindings[0]);
  expect(rejected).toEqual([true, true, true, true, true]);
  expect((await bindingBackend.request('/api/sync/cli-bindings')).data).toEqual({ bindings: [] });
  await pending.getByRole('combobox', { name: '会话 wxid_synthetic_a 对应联系人' }).selectOption('new');
  await manager.getByRole('button', { name: '确认并授权所选会话', exact: true }).click();
  const authorized = manager.getByRole('region', { name: '已授权会话' });
  await expect(authorized.getByText('wxid_synthetic_a', { exact: true })).toBeVisible();
  const active = (await bindingBackend.request('/api/sync/cli-bindings')).data.bindings as { contact_id: string; binding_id: string }[];
  expect(bindingBackend.data.contact_ids).not.toContain(active[0].contact_id);
  const contacts = (await bindingBackend.request('/api/contacts')).data.contacts as { contact_id: string; display_name: string }[];
  expect(contacts.find((contact) => contact.contact_id === active[0].contact_id)?.display_name).toBe('同名会话');
  const opened = app.waitForEvent('window');
  await manager.getByRole('button', { name: '打开输入小窗' }).click();
  const helper = await opened;
  const blocked = await helper.evaluate(async (binding) => {
    const state = await window.notalone.bindings.getState();
    try { await window.notalone.bindings.revokeBinding({ scopeRevision: state.scopeRevision, contactId: binding.contact_id, bindingId: binding.binding_id }); return false; }
    catch { return true; }
  }, active[0]);
  expect(blocked).toBe(true);
  expect(((await bindingBackend.request('/api/sync/cli-bindings')).data.bindings as unknown[]).length).toBe(1);
  expect(await bindingBackend.tails()).toEqual([]);
});

test('按稳定标识明确选择同名联系人，最终确认只追加授权，已开总开关时新增范围立即可读', async ({ runningApp: { app }, bindingBackend }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '同步设置', exact: true }).click();
  const pending = manager.getByRole('region', { name: '待授权会话' });
  const authorized = manager.getByRole('region', { name: '已授权会话' });
  const submit = manager.getByRole('button', { name: '确认并授权所选会话', exact: true });
  await pending.getByRole('checkbox', { name: '选择会话 wxid_synthetic_a' }).check();
  await expect(submit).toBeDisabled();
  await pending.getByRole('combobox', { name: '会话 wxid_synthetic_a 对应联系人' }).selectOption(bindingBackend.data.contact_ids[0]);
  await expect(submit).toBeEnabled();
  expect((await bindingBackend.request('/api/sync/cli-bindings')).data).toEqual({ bindings: [] });
  expect(await bindingBackend.tails()).toEqual([]);
  await submit.click();
  await expect(authorized.getByText('wxid_synthetic_a', { exact: true })).toBeVisible();
  await expect(authorized.getByText(`联系人：同名联系人 · ${bindingBackend.data.contact_ids[0]}`, { exact: true })).toBeVisible();
  await expect(pending.getByRole('checkbox', { name: '选择会话 wxid_synthetic_b' })).not.toBeChecked();
  expect(await bindingBackend.tails()).toEqual([]);
  await bindingBackend.request('/api/sync/enable', {});
  const state = initialCliState();
  state.sessions.push({ username: 'wxid_synthetic_new', display_name: '尚未确认会话', chat_type: 'private', last_timestamp: 1_700_000_001 });
  await bindingBackend.setCli(state);
  await manager.getByRole('button', { name: '刷新会话与授权', exact: true }).click();
  await expect(manager.getByText('当前总开关已开启：新确认范围会立即允许后台读取。', { exact: true })).toBeVisible();
  await pending.getByRole('checkbox', { name: '选择会话 wxid_synthetic_b' }).check();
  await pending.getByRole('combobox', { name: '会话 wxid_synthetic_b 对应联系人' }).selectOption(bindingBackend.data.contact_ids[1]);
  await submit.click();
  await expect(authorized.getByText('wxid_synthetic_b', { exact: true })).toBeVisible();
  await expect(authorized.getByText('wxid_synthetic_a', { exact: true })).toBeVisible();
  await expect(pending.getByRole('checkbox', { name: '选择会话 wxid_synthetic_new' })).not.toBeChecked();
  const response = await bindingBackend.request('/api/sync/cli-bindings');
  const bindings = response.data.bindings as { contact_id: string; conversation_locator: string }[];
  expect(bindings.find((item) => item.conversation_locator === 'wxid_synthetic_a')?.contact_id).toBe(bindingBackend.data.contact_ids[0]);
  expect(bindings.find((item) => item.conversation_locator === 'wxid_synthetic_b')?.contact_id).toBe(bindingBackend.data.contact_ids[1]);
  const tails = await bindingBackend.tails();
  expect(tails).toContain('wxid_synthetic_b');
  expect(tails.every((locator) => ['wxid_synthetic_a', 'wxid_synthetic_b'].includes(locator))).toBe(true);
  await manager.screenshot({ path: test.info().outputPath('bindings-confirmed.png') });
});

test('改名与列表消失如实保留授权，用户明确撤销后重新确认才产生新绑定', async ({ runningApp: { app }, bindingBackend }) => {
  const manager = await app.firstWindow();
  await expect(manager.getByRole('status').filter({ hasText: '已连接' })).toBeVisible({ timeout: 15_000 });
  await bindingBackend.request('/api/sync/cli-bindings/confirm', { selections: [
    { locator: 'wxid_synthetic_a', contact_id: bindingBackend.data.contact_ids[0] },
    { locator: 'wxid_synthetic_b', contact_id: bindingBackend.data.contact_ids[1] },
  ] });
  const before = (await bindingBackend.request('/api/sync/cli-bindings')).data.bindings as { binding_id: string; conversation_locator: string }[];
  const state = initialCliState();
  state.sessions = [{ ...state.sessions[0], display_name: '改名后的合成会话' }];
  await bindingBackend.setCli(state);
  await manager.getByRole('button', { name: '同步设置', exact: true }).click();
  await manager.getByRole('button', { name: '刷新会话与授权', exact: true }).click();
  const authorized = manager.getByRole('region', { name: '已授权会话' });
  await expect(authorized.getByText('会话显示名已变为“改名后的合成会话”，不会静默更新绑定。请明确撤销后重新核对并确认。', { exact: true })).toBeVisible();
  await expect(authorized.getByText('当前 CLI 列表已无此会话，授权仍有效；请核对并明确撤销，重新出现后再确认。', { exact: true })).toBeVisible();
  const revokeA = authorized.getByRole('button', { name: '撤销会话 wxid_synthetic_a 的后台读取授权', exact: true });
  await expect(revokeA).toBeEnabled();
  await revokeA.click();
  const dialog = manager.getByRole('dialog', { name: '撤销后台读取授权确认' });
  await expect(dialog.getByText('wxid_synthetic_a', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '取消撤销', exact: true }).click();
  expect(((await bindingBackend.request('/api/sync/cli-bindings')).data.bindings as unknown[]).length).toBe(2);
  await revokeA.click();
  await dialog.getByRole('button', { name: '确认撤销此会话授权', exact: true }).click();
  await expect(authorized.getByText('wxid_synthetic_a', { exact: true })).toHaveCount(0);
  const pending = manager.getByRole('region', { name: '待授权会话' });
  await expect(pending.getByRole('checkbox', { name: '选择会话 wxid_synthetic_a' })).not.toBeChecked();
  await pending.getByRole('checkbox', { name: '选择会话 wxid_synthetic_a' }).check();
  await pending.getByRole('combobox', { name: '会话 wxid_synthetic_a 对应联系人' }).selectOption(bindingBackend.data.contact_ids[0]);
  await manager.getByRole('button', { name: '确认并授权所选会话', exact: true }).click();
  await expect(authorized.getByText('改名后的合成会话', { exact: true })).toBeVisible();
  const after = (await bindingBackend.request('/api/sync/cli-bindings')).data.bindings as { binding_id: string; conversation_locator: string; display_name: string }[];
  expect(after.find((item) => item.conversation_locator === 'wxid_synthetic_a')?.binding_id).not.toBe(before.find((item) => item.conversation_locator === 'wxid_synthetic_a')?.binding_id);
  expect(after.find((item) => item.conversation_locator === 'wxid_synthetic_a')?.display_name).toBe('改名后的合成会话');
  await authorized.getByRole('button', { name: '撤销会话 wxid_synthetic_b 的后台读取授权', exact: true }).click();
  await dialog.getByRole('button', { name: '确认撤销此会话授权', exact: true }).click();
  await expect(authorized.getByText('wxid_synthetic_b', { exact: true })).toHaveCount(0);
  expect(await bindingBackend.tails()).toEqual([]);
  await manager.screenshot({ path: test.info().outputPath('bindings-reconfirmed.png') });
});
