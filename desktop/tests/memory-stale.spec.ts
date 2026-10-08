import { expect } from '@playwright/test';
import { test as memoryTest } from './memory-fixture';
import { MemoryHttpProxy } from './memory-http-proxy';

const test = memoryTest.extend<{ memoryProxy: MemoryHttpProxy }>({
  memoryBackendMode: 'reused',
  memoryProxy: [async ({ memoryBackend }, use) => {
    const proxy = await MemoryHttpProxy.attach(memoryBackend.infoPath);
    try { await use(proxy); } finally { await proxy.close(); }
  }, { auto: true }],
});

for (const failure of [false, true]) test(`同一范围的新刷新不被旧读取的迟到${failure ? '失败' : '成功'}覆盖`, async ({ runningApp: { app }, memoryBackend, memoryProxy }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  memoryProxy.holdPath = `/api/contacts/${memoryBackend.data.contact_ids[0]}/memories`;
  const refresh = manager.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.memory.refresh({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, section: 'contact' });
  });
  await expect.poll(() => memoryProxy.heldCount).toBe(1);
  await memoryBackend.addSyntheticContactMemory(memoryBackend.data.contact_ids[0], '同一范围最新读取的合成资料。');
  memoryProxy.holdPath = null;
  await manager.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.memory.refresh({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, section: 'contact' });
  });
  await expect(manager.getByText('同一范围最新读取的合成资料。', { exact: true })).toBeVisible();
  memoryProxy.release(failure);
  await refresh;
  await expect(manager.getByText('同一范围最新读取的合成资料。', { exact: true })).toBeVisible();
  await expect(manager.getByText('联系人记忆读取失败，请重试。', { exact: true })).toHaveCount(0);
});

for (const failure of [false, true]) test(`A→B→A 后旧资料读取的迟到${failure ? '失败' : '成功'}不覆盖新范围`, async ({ runningApp: { app }, memoryBackend, memoryProxy }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  memoryProxy.holdPath = `/api/contacts/${memoryBackend.data.contact_ids[0]}/memories`;
  const refresh = manager.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.memory.refresh({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, section: 'contact' });
  });
  await expect.poll(() => memoryProxy.heldCount).toBe(1);
  await expect(manager.getByText('正在读取联系人记忆…', { exact: true })).toBeVisible();
  await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(memoryBackend.data.contact_ids[1]);
  await expect(manager.getByText('乙喜欢合成乌龙茶。', { exact: true })).toBeVisible();
  await memoryBackend.addSyntheticContactMemory(memoryBackend.data.contact_ids[0], '甲在切换后新增的合成资料。');
  memoryProxy.holdPath = null;
  await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(memoryBackend.data.contact_ids[0]);
  await expect(manager.getByText('甲在切换后新增的合成资料。', { exact: true })).toBeVisible();
  memoryProxy.release(failure);
  await refresh;
  await expect(manager.getByText('甲在切换后新增的合成资料。', { exact: true })).toBeVisible();
  await expect(manager.getByText('乙喜欢合成乌龙茶。', { exact: true })).toHaveCount(0);
  await expect(manager.getByText('联系人记忆读取失败，请重试。', { exact: true })).toHaveCount(0);
});

for (const failure of [false, true]) test(`连接 generation 变化后旧资料读取的迟到${failure ? '失败' : '成功'}不恢复`, async ({ runningApp: { app }, memoryBackend, memoryProxy }) => {
  const manager = await app.firstWindow();
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  memoryProxy.holdPath = `/api/contacts/${memoryBackend.data.contact_ids[0]}/memories`;
  const refresh = manager.evaluate(async () => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.memory.refresh({ contactId: state.selectedContactId!, scopeRevision: state.scopeRevision, section: 'contact' });
  });
  await expect.poll(() => memoryProxy.heldCount).toBe(1);
  memoryProxy.failRuntimeStatus = true;
  await expect(manager.getByRole('status').filter({ hasText: '尚未连接' })).toBeVisible();
  await expect(manager.getByRole('region', { name: '资料范围未确认' })).toBeVisible();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toHaveCount(0);
  memoryProxy.failRuntimeStatus = false;
  memoryProxy.holdPath = null;
  await manager.getByRole('button', { name: '重试连接', exact: true }).click();
  await expect(manager.getByRole('combobox', { name: '资料联系人' })).toBeEnabled();
  await manager.getByRole('combobox', { name: '资料联系人' }).selectOption(memoryBackend.data.contact_ids[1]);
  await expect(manager.getByText('乙喜欢合成乌龙茶。', { exact: true })).toBeVisible();
  memoryProxy.release(failure);
  await refresh;
  await expect(manager.getByText('乙喜欢合成乌龙茶。', { exact: true })).toBeVisible();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toHaveCount(0);
  await expect(manager.getByText('联系人记忆读取失败，请重试。', { exact: true })).toHaveCount(0);
});

test('某栏失败不冒充空资料，其他栏可用，失败栏可以独立重读', async ({ runningApp: { app }, memoryBackend, memoryProxy }) => {
  const manager = await app.firstWindow();
  memoryProxy.failurePaths.add('/api/memories/owner');
  memoryProxy.failurePaths.add(`/api/contacts/${memoryBackend.data.contact_ids[0]}/sources`);
  await manager.getByRole('button', { name: '选择合成联系人甲', exact: true }).click();
  await manager.getByRole('button', { name: '关系资料', exact: true }).click();
  await expect(manager.getByText('甲喜欢合成茉莉茶。', { exact: true })).toBeVisible();
  await expect(manager.getByText('本人记忆读取失败，请重试。', { exact: true })).toBeVisible();
  await expect(manager.getByText('当前联系人来源读取失败，请重试。', { exact: true })).toBeVisible();
  await expect(manager.getByText('当前本人暂无有效记忆。', { exact: true })).toHaveCount(0);
  await expect(manager.getByText('这位联系人暂无来源记录。', { exact: true })).toHaveCount(0);
  await manager.getByRole('button', { name: '查看来源与版本：甲喜欢合成茉莉茶。' }).click();
  await expect(manager.getByText('来源目录读取失败，暂时无法核对这项引用。', { exact: true })).toBeVisible();
  memoryProxy.failurePaths.clear();
  await manager.getByRole('button', { name: '重新读取本人记忆', exact: true }).click();
  await expect(manager.getByText('本人喜欢合成绿茶。', { exact: true })).toBeVisible();
  await expect(manager.getByText('当前联系人来源读取失败，请重试。', { exact: true })).toBeVisible();
  await manager.getByRole('button', { name: '重新读取当前联系人来源', exact: true }).click();
  await expect(manager.getByRole('region', { name: '当前联系人来源' }).getByText('synthetic.jsonl', { exact: true })).toBeVisible();
  await expect(manager.getByRole('alert')).toHaveCount(0);
});
