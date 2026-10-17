import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, payload } from './support.mjs';
import { withMemoryPage } from './react-support.mjs';

test('无联系人可通过当前React页面确认本人范围、停用及删除', { timeout: 20000 }, async (t) => {
  let saved = payload({ scope_kind: 'owner', contact_id: null });
  const f = await fixture(async request => {
    if (request.path.endsWith('/enable')) saved = payload({ scope_kind: 'owner', contact_id: null, enabled: true, status: 'blocked', settings_generation: 1 });
    if (request.path.endsWith('/disable') || request.path.endsWith('/delete')) saved = payload({ scope_kind: 'owner', contact_id: null, settings_generation: 2 });
    return { generation: 1, data: saved };
  }, { noContact: true });
  await withMemoryPage(f, t.signal, async page => {
    await page.getByRole('button', { name: '本人主题资料', exact: true }).click();
    await page.getByRole('checkbox', { name: /确认仅整理本人的/ }).check();
    await page.getByRole('button', { name: '确认范围并开启' }).click();
    await page.getByText('已开启范围，质量资格待核验', { exact: true }).waitFor();
    await page.getByRole('button', { name: '停用主题资料' }).click();
    await page.getByRole('checkbox', { name: /确认仅整理本人的/ }).waitFor();
    await page.getByRole('button', { name: '删除整理结果', exact: true }).click();
    await page.getByRole('button', { name: '确认删除整理结果' }).click();
    await page.getByText('本人资料操作已完成并核对。', { exact: true }).waitFor();
    assert.equal((await f.bridge.getOwnerLayeredMemoryState()).value.enabled, false);
  });
});

test('React测试取消立即结束页面等待并关闭自有浏览器', { timeout: 20000 }, async (t) => {
  const cancellation = new AbortController();
  const f = await fixture(async () => ({ generation: 1, data: payload({ scope_kind: 'owner', contact_id: null }) }), { noContact: true });
  await assert.rejects(withMemoryPage(f, AbortSignal.any([t.signal, cancellation.signal]), async page => {
    const waiting = page.getByRole('button', { name: '不存在的合成控件', exact: true }).waitFor({ timeout: 0 });
    cancellation.abort();
    await waiting;
  }), /closed|cancel/i);
});
