import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, profilePayload } from './support.mjs';
import { withMemoryPage } from './react-support.mjs';

test('旧资料模式无联系人时仍展示三个入口并可进入本人主题资料', { timeout: 15000 }, async t => {
  const requests = [];
  const f = await fixture(async request => {
    requests.push(request);
    return { generation: 1, data: request.path.includes('/layered-memory')
      ? profilePayload({ scope_kind: 'owner', contact_id: null }) : { memories: [] } };
  }, { noContact: true });
  await withMemoryPage(f, t.signal, async page => {
    const navigation = page.getByRole('navigation', { name: '记忆分类' });
    await navigation.waitFor();
    assert.deepEqual(await navigation.getByRole('button').allTextContents(), ['对方', '我', '待确认']);
    await navigation.getByRole('button', { name: '我', exact: true }).click();
    await page.getByRole('region', { name: '本人主题资料', exact: true }).waitFor();
    assert.ok(requests.some(request => request.path.includes('/memories/owner/layered-memory')));
    assert.equal(f.contacts.getState().selectedContactId, null);
  });
});
