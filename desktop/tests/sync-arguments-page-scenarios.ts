import { expect, type Page } from '@playwright/test';
import type { BindingFixture } from './binding-backend-fixture';

type SyncPage = { manager: Page; syncBackend: BindingFixture };

// 通过真正具名bridge拒绝调用，再由真实HTTP与合成CLI证明仍未开启正文读取。
export async function syncArgumentsPreserveStoppedScope({ manager, syncBackend }: SyncPage): Promise<void> {
  const [contactA, contactB] = syncBackend.data.contact_ids;
  expect((await syncBackend.request('/api/sync/cli-bindings/confirm', { selections: [{
    locator: 'wxid_synthetic_a', contact_id: contactA,
  }] })).status).toBe(200);
  await manager.getByRole('button', { name: '同步设置', exact: true }).click();
  const background = manager.getByRole('region', { name: '后台 CLI 同步', exact: true });
  await expect(background.getByText('后台正文同步已关闭', { exact: true })).toBeVisible();
  const opened = manager.context().waitForEvent('page');
  await manager.getByRole('button', { name: '打开输入小窗', exact: true }).click();
  const helper = await opened;
  // 普通页面使用 /#helper，签名包使用 /index.html#helper；两者共享同一公开角色。
  await helper.waitForURL(/#helper$/);
  const scopeRevision = await manager.evaluate(async () => (await window.notalone.syncControl.getState()).scopeRevision);
  const helperRejected = await helper.evaluate(async (scopeRevision) => {
    const bridge = window.notalone.syncControl;
    const operations = [() => bridge.getState(), () => bridge.refresh(),
      () => bridge.enable({ scopeRevision }), () => bridge.disable({ scopeRevision }),
      () => bridge.pause({ scopeRevision }), () => bridge.retry({ scopeRevision })];
    const rejected: boolean[] = [];
    for (const operation of operations) {
      try { await operation(); rejected.push(false); } catch { rejected.push(true); }
    }
    return rejected;
  }, scopeRevision);
  expect(helperRejected).toEqual([true, true, true, true, true, true]);

  const invalidRejected = await manager.evaluate(async ({ scopeRevision, otherOwner, contactB }) => {
    const bridge = window.notalone.syncControl;
    const operations = [bridge.enable, bridge.disable, bridge.pause, bridge.retry] as unknown as ((...args: unknown[]) => Promise<void>)[];
    // 没有额外位置参数：非空请求仅改变具名对象字段，不能让未知owner/contact/path进入主进程。
    const requests: unknown[][] = [[], [undefined], [null], [[]], [{}],
      [{ scopeRevision: null }], [{ scopeRevision: true }], [{ scopeRevision: String(scopeRevision) }],
      [{ scopeRevision: -1 }], [{ scopeRevision: 0.5 }], [{ scopeRevision: NaN }], [{ scopeRevision: Infinity }],
      [{ scopeRevision: Number.MAX_SAFE_INTEGER + 1 }], [{ scopeRevision, owner_id: otherOwner }],
      [{ scopeRevision, ownerId: otherOwner }], [{ scopeRevision, contact_id: contactB }],
      [{ scopeRevision, contactId: contactB }], [{ scopeRevision, url: 'http://127.0.0.1:1/api/sync/enable' }],
      [{ scopeRevision, path: '/api/runtime/shutdown' }], [{ scopeRevision, role: 'manager' }]];
    const rejected: boolean[] = [];
    for (const operation of operations) for (const request of requests) {
      try { await operation(...request); rejected.push(false); } catch { rejected.push(true); }
    }
    return rejected;
  }, { scopeRevision, otherOwner: syncBackend.data.other_owner_id, contactB });
  expect(invalidRejected).toHaveLength(80);
  expect(invalidRejected.every(Boolean)).toBe(true);

  await manager.evaluate(async (contactId) => {
    const state = await window.notalone.contacts.getState();
    await window.notalone.contacts.selectContact({ contactId, scopeRevision: state.scopeRevision });
  }, contactA);
  await expect.poll(() => manager.evaluate(async () => {
    const state = await window.notalone.syncControl.getState();
    return { phase: state.phase, scopeRevision: state.scopeRevision, enabled: state.report?.enabled ?? null };
  })).toMatchObject({ phase: 'ready', enabled: false });
  const currentScope = await manager.evaluate(async () => (await window.notalone.syncControl.getState()).scopeRevision);
  expect(currentScope).toBeGreaterThan(scopeRevision);
  const staleRejected = await manager.evaluate(async (scopeRevision) => {
    const bridge = window.notalone.syncControl;
    const operations = [bridge.enable, bridge.disable, bridge.pause, bridge.retry];
    const rejected: boolean[] = [];
    for (const operation of operations) {
      try { await operation({ scopeRevision }); rejected.push(false); } catch { rejected.push(true); }
    }
    return rejected;
  }, scopeRevision);
  expect(staleRejected).toEqual([true, true, true, true]);
  const status = await syncBackend.request('/api/sync/status');
  expect(status.status).toBe(200);
  expect(status.data).toMatchObject({ sync_enabled: false, cli_sync_phase: 'disabled' });
  for (const contactId of [contactA, contactB]) {
    expect((await syncBackend.request(`/api/contacts/${contactId}/messages`)).data.messages).toEqual([]);
  }
  expect(await syncBackend.tails()).toEqual([]);
  await expect(background.getByText('后台正文同步已关闭', { exact: true })).toBeVisible();
  console.log('sync_arguments_rejected:', JSON.stringify({ helper: helperRejected.length,
    invalidNamedRequests: invalidRejected.length, staleScope: staleRejected.length, enabled: false, tails: 0 }));
}
