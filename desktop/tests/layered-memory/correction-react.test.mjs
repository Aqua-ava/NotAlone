import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, profilePayload, ids } from './support.mjs';
import { withMemoryPage } from './react-support.mjs';

for (const scope of ['contact', 'owner']) for (const kind of ['scenario', 'profile']) for (const action of ['summary', 'fact']) {
  test(`当前React ${scope}/${kind} ${action}纠错使用实际目标并保留手录入口`, { timeout: 20000 }, async t => {
    const original = profilePayload({ scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact });
    let saved = original;
    const posts = [];
    const memory = { memory_id: ids.other, level: scope, ...(scope === 'contact' ? { contact_id: ids.contact } : {}),
      text: '当前应修正的独立底层事实。', category: 'common_fact', topic: 'other', source_ids: [ids.memory],
      status: 'active', adoption_method: 'manual', confidence: 1, risk_flags: [], revision: 2,
      supersedes_memory_id: ids.memory, source_candidate_id: null, valid_at: null, invalid_at: null,
      timing: { recorded_at: null, source_started_at: null, source_ended_at: null, source_time_complete: false } };
    const memories = [...Array.from({ length: 7 }, (_, index) => ({ ...memory, memory_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index).padStart(12, '0')}`, text: `无关底层资料${index}。` })), memory];
    const f = await fixture(async request => {
      if (request.path.includes('/layered-memory')) {
        if (request.method === 'POST') {
          posts.push(request);
          saved = profilePayload({ scope_kind: scope, contact_id: scope === 'owner' ? null : ids.contact,
            scenarios: kind === 'scenario' ? [] : original.layered_memory.scenarios, profile: null,
            correction_revision: action === 'summary' ? 1 : 0, protected_count: action === 'summary' ? 1 : 0,
            ...(action === 'fact' ? { correction_target: { memory_id: ids.other, revision: 2 } } : { feedback: [{ id: ids.other,
              target_kind: kind, version_id: kind === 'scenario' ? ids.version : ids.profile, item_index: 0,
              reason: '总结把计划写成事实。', state: 'active' }] }) });
        }
        return { generation: 1, data: saved };
      }
      return { generation: 1, data: request.path.endsWith('/sources') ? { sources: [] }
        : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories } };
    });
    await withMemoryPage(f, t.signal, async page => {
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.getByRole('button', { name: scope === 'owner' ? '本人主题资料' : '主题资料', exact: true }).click();
      const item = kind === 'profile' ? page.getByRole('region', { name: '长期背景', exact: true })
        : page.locator(`#layered-scenario-${ids.version}`);
      if (action === 'summary') {
        await item.getByRole('button', { name: '总结有误', exact: true }).click();
        await item.getByLabel('总结错误说明').fill('总结把计划写成事实。');
        await item.getByRole('button', { name: '提交总结纠错' }).click();
        await page.getByRole('region', { name: '整理纠错反馈' }).getByText(/总结把计划写成事实/).waitFor().catch(error => { throw new Error(`${error.message}; 页面错误=${JSON.stringify(errors)}; 写请求=${posts.length}`); });
        assert.equal(posts[0].body.reason, '总结把计划写成事实。');
        await page.getByRole('button', { name: scope === 'owner' ? '管理底层本人记忆' : '管理底层联系人记忆' }).click();
        if (scope === 'contact') await page.getByRole('button', { name: '补充联系人资料', exact: true }).click();
        await page.getByRole('button', { name: scope === 'owner' ? '保存本人资料' : '保存资料', exact: true }).waitFor();
      } else {
        await item.getByText(kind === 'profile' ? '查看第 1 项依据与时间' : '查看第 1 段依据与时间', { exact: true }).click();
        await item.getByRole('button', { name: '事实有误：修正此条' }).click();
        const target = page.getByRole('region', { name: scope === 'owner' ? '本次纠错的本人底层记忆' : '本次纠错的底层记忆', exact: true });
        await target.locator('p.memory-text').getByText(memory.text, { exact: true }).waitFor();
        assert.equal(await target.getByRole('textbox').inputValue(), memory.text);
        assert.equal(await target.getByText('无关底层资料0。', { exact: true }).count(), 0);
        assert.equal(posts[0].body.memory_id, ids.memory);
      }
      assert.equal(posts[0].body.target_kind, kind);
      assert.equal(posts[0].body.version_id, kind === 'scenario' ? ids.version : ids.profile);
      assert.equal(posts[0].body.item_index, 0);
    });
  });
}
