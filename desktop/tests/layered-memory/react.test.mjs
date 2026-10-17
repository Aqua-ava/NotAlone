import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, payload, readyPayload, ids } from './support.mjs';
import { withMemoryPage } from './react-support.mjs';

test('当前关系资料页面由用户确认用途后开启主题资料，未知质量不会当作成功', { timeout: 20000 }, async () => {
  let saved = payload();
  const f = await fixture(async (request) => {
    if (request.path.includes('/layered-memory')) {
      if (request.method === 'POST') saved = payload({ enabled: true, settings_generation: 1, status: 'blocked' });
      return { generation: 1, data: saved };
    }
    return { generation: 1, data: request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } };
  });
  await withMemoryPage(f, async (page) => {
      await page.getByRole('button', { name: '主题资料', exact: true }).click({ timeout: 3000 });
      const confirm = page.getByRole('checkbox', { name: /确认仅整理/ });
      await confirm.waitFor();
      assert.equal(await confirm.isChecked(), false);
      assert.equal(await page.getByRole('button', { name: '确认范围并开启' }).isEnabled(), false);
      await confirm.check();
      await page.getByRole('button', { name: '确认范围并开启' }).click();
      await page.getByText('质量资格未知，资料不会发给模型。', { exact: true }).waitFor();
      await page.getByText('已开启范围，质量资格待核验', { exact: true }).waitFor();
      assert.equal((await f.bridge.getState()).layeredMemory.value.status, 'blocked');
  });
});

test('用户查看系统整理的部分覆盖与段落时间依据，停用回看、重新读取和删除各自生效', { timeout: 20000 }, async () => {
  let saved = readyPayload();
  const f = await fixture(async (request) => {
    if (request.path.includes('/layered-memory')) {
      if (request.path.endsWith('/disable')) saved = readyPayload({ enabled: false, status: 'disabled', settings_generation: 2 });
      if (request.path.endsWith('/delete')) saved = payload({ quality_status: 'synthetic', settings_generation: 3 });
      return { generation: 1, data: saved };
    }
    return { generation: 1, data: request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } };
  });
  await withMemoryPage(f, async (page) => {
    await page.getByRole('button', { name: '主题资料', exact: true }).click();
    await page.getByText('本批主题资料整理成功', { exact: true }).waitFor();
    await page.getByText('合格资料 3 条 · 已覆盖 2 条 · 剩余 1 条', { exact: true }).waitFor();
    await page.getByText('系统整理', { exact: true }).waitFor();
    await page.getByText('目前仅覆盖部分资料；剩余资料尚未整理。', { exact: true }).waitFor();
    await page.getByText('查看第 1 段依据与时间', { exact: true }).click();
    const reference = page.getByText(`底层记忆：${ids.memory} · 版本 1 · 用户手动录入`, { exact: true });
    await reference.waitFor();
    await page.getByText('生成时核实状态：当前未核实', { exact: true }).waitFor();
    await page.getByText('来源聊天时间：未知（来源时间不完整）', { exact: true }).waitFor();
    await page.getByRole('button', { name: '停用主题资料' }).click();
    await page.getByText('已停止整理及回复加载；下方仅供回看来源仍有效的现有文档。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重新读取主题资料' }).click();
    await page.getByRole('heading', { name: '合成读书计划' }).waitFor();
    await page.getByRole('button', { name: '删除整理结果', exact: true }).click();
    await page.getByRole('button', { name: '确认删除整理结果' }).click();
    await page.getByText('主题资料整理结果已删除，本范围已关闭。底层记忆可另行管理。', { exact: true }).waitFor();
    assert.equal(await page.getByText('曾计划参加合成读书会，当前是否成行尚未核实。', { exact: true }).count(), 0);
    assert.deepEqual((await f.bridge.getState()).layeredMemory.value.scenarios, []);
    await page.getByRole('button', { name: '管理底层联系人记忆' }).click();
    assert.equal(await page.getByRole('button', { name: '联系人记忆', exact: true }).getAttribute('aria-pressed'), 'true');
  });
});

test('用户刷新可分别观察空资料与整理失败，失败不会保留旧主题正文', { timeout: 20000 }, async () => {
  let count = 0;
  const f = await fixture(async (request) => {
    if (request.path.includes('/layered-memory')) {
      const failed = request.method === 'POST' && ++count === 2;
      return { generation: 1, data: readyPayload({ status: failed ? 'failed' : 'empty', scenarios: [],
        eligible_count: 0, covered_count: 0, remaining_count: 0, error_code: failed ? 'verification_failed' : null }) };
    }
    return { generation: 1, data: request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } };
  });
  await withMemoryPage(f, async (page) => {
    await page.getByRole('button', { name: '主题资料', exact: true }).click();
    await page.getByText('暂无合格资料可整理', { exact: true }).waitFor();
    await page.getByRole('button', { name: '刷新主题资料' }).click();
    await page.getByText('暂无合格资料可整理', { exact: true }).waitFor();
    await page.getByRole('button', { name: '刷新主题资料' }).click();
    await page.getByRole('alert').filter({ hasText: '整理失败，未采用本批结果' }).waitFor();
    await page.getByRole('button', { name: '继续整理主题资料', exact: true }).click();
    await page.getByText('暂无合格资料可整理', { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '合成读书计划' }).count(), 0);
  });
});

test('用户暂停首次覆盖再继续同一工作，显示真实批次且保留先前主题正文', { timeout: 20000 }, async () => {
  const posted = [];
  let saved = readyPayload({ status: 'updating', eligible_count: 2, covered_count: 1, remaining_count: 1,
    work_id: ids.work, work_revision: 1, current_batch: 1 });
  const first = saved.layered_memory.scenarios[0];
  const f = await fixture(async (request) => {
    if (request.path.includes('/layered-memory')) {
      if (request.method === 'POST') {
        posted.push(request);
        saved = request.path.endsWith('/pause') ? { layered_memory: { ...saved.layered_memory, status: 'paused', work_revision: 2 } }
          : readyPayload({ eligible_count: 2, covered_count: 2, remaining_count: 0,
          work_id: ids.work, work_revision: 3, current_batch: 2, model_calls_used: 4, model_call_limit: 4,
          scenarios: [{ ...first, paragraphs: [...first.paragraphs, {
            text: '后来继续参加合成阅读讨论。', references: first.paragraphs[0].references,
          }] }] });
      }
      return { generation: 1, data: saved };
    }
    return { generation: 1, data: request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } };
  });
  await withMemoryPage(f, async (page) => {
    await page.getByRole('button', { name: '主题资料', exact: true }).click();
    await page.getByText('正在整理，尚未完成', { exact: true }).waitFor();
    await page.getByRole('button', { name: '暂停整理主题资料', exact: true }).click();
    await page.getByText('已暂停，剩余资料可继续整理', { exact: true }).waitFor({ timeout: 3000 });
    await page.getByText('合格资料 2 条 · 已覆盖 1 条 · 剩余 1 条', { exact: true }).waitFor();
    await page.getByText('当前批次：1', { exact: true }).waitFor();
    await page.getByText('累计已用 2 / 已授权 2 次模型调用', { exact: true }).waitFor({ timeout: 3000 });
    await page.getByText('每次继续仅推进一批，追加本批最多 2 次模型调用；已消耗调用不会因继续或重启清零。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '继续整理主题资料', exact: true }).click();
    await page.getByText('合格资料 2 条 · 已覆盖 2 条 · 剩余 0 条', { exact: true }).waitFor();
    await page.getByText('当前批次：2', { exact: true }).waitFor();
    await page.getByText('累计已用 4 / 已授权 4 次模型调用', { exact: true }).waitFor();
    await page.getByText('曾计划参加合成读书会，当前是否成行尚未核实。', { exact: true }).waitFor();
    await page.getByText('后来继续参加合成阅读讨论。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '继续整理主题资料', exact: true }).count(), 0);
    assert.equal(posted[0].path, `/api/contacts/${ids.contact}/layered-memory/pause`);
    assert.deepEqual(posted[0].body, { settings_generation: 1, work_revision: 1 });
    assert.equal(posted[1].path, `/api/contacts/${ids.contact}/layered-memory/continue`);
    assert.deepEqual(posted[1].body, { settings_generation: 1, work_revision: 2 });
  });
});

test('资料变化显示待更新与真实剩余，后台完成后自动展示新正文', { timeout: 20000 }, async () => {
  let saved = readyPayload({ maintenance_pending: true, status: 'stale', covered_count: 0, remaining_count: 3, scenarios: [] });
  const f = await fixture(async (request) => ({ generation: 1, data: request.path.includes('/layered-memory') ? saved
    : request.path.endsWith('/sources') ? { sources: [] } : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } }));
  try { await withMemoryPage(f, async (page) => {
    await page.getByRole('button', { name: '主题资料', exact: true }).click();
    await page.getByText('资料已变化，等待后台更新。', { exact: true }).waitFor({ timeout: 3000 });
    await page.getByText('合格资料 3 条 · 已覆盖 0 条 · 剩余 3 条', { exact: true }).waitFor();
    saved = readyPayload({ maintenance_pending: false });
    await page.getByRole('heading', { name: '合成读书计划' }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByText('资料已变化，等待后台更新。', { exact: true }).count(), 0);
  }); } finally { f.disconnect(); }
});

test('旧主题入口展示拆分后的合法终端并导航到当前版本', { timeout: 20000 }, async () => {
  const first = readyPayload().layered_memory.scenarios[0];
  const saved = readyPayload({ scenario_mappings: [{ source_scenario_id: ids.other, source_version_id: ids.work,
    targets: [{ scenario_id: ids.scenario, version_id: ids.version }, { scenario_id: ids.memory, version_id: ids.contact }] }],
    scenarios: [first, { ...first, scenario_id: ids.memory, version_id: ids.contact, title: '合成写作计划' }] });
  const f = await fixture(async (request) => ({ generation: 1, data: request.path.includes('/layered-memory') ? saved
    : request.path.endsWith('/sources') ? { sources: [] } : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } }));
  try { await withMemoryPage(f, async (page) => {
    await page.getByRole('button', { name: '主题资料', exact: true }).click();
    await page.getByText('查看旧主题入口的当前去向', { exact: true }).click({ timeout: 3000 });
    await page.getByText(`旧主题：${ids.other} · 旧版本：${ids.work}`, { exact: true }).waitFor();
    await page.getByRole('link', { name: '查看当前主题：合成写作计划', exact: true }).click();
    const target = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '合成写作计划' }) });
    assert.equal(await target.getAttribute('id'), `layered-scenario-${ids.contact}`);
    assert.equal(await page.getByRole('link', { name: '查看当前主题：合成读书计划', exact: true }).count(), 1);
  }); } finally { f.disconnect(); }
});

test('旧入口分页只显示当前页，可查看最旧入口并返回首屏', { timeout: 20000 }, async () => {
  const first = readyPayload({ mapping_cursor: null, mapping_next_cursor: '1:100' });
  const last = readyPayload({ mapping_cursor: '1:100', mapping_next_cursor: null,
    scenario_mappings: [{ source_scenario_id: ids.other, source_version_id: ids.work,
      targets: [{ scenario_id: ids.scenario, version_id: ids.version }] }] });
  const f = await fixture(async (request) => ({ generation: 1, data: request.path.includes('/layered-memory')
    ? request.path.includes('mapping_cursor=') ? last : first
    : request.path.endsWith('/sources') ? { sources: [] } : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } }));
  await withMemoryPage(f, async (page) => {
    await page.getByRole('button', { name: '主题资料', exact: true }).click();
    await page.getByRole('button', { name: '下一页旧入口', exact: true }).click({ timeout: 3000 });
    await page.getByText('查看旧主题入口的当前去向', { exact: true }).click();
    await page.getByText(`旧主题：${ids.other} · 旧版本：${ids.work}`, { exact: true }).waitFor();
    await page.getByRole('button', { name: '返回旧入口首屏', exact: true }).click();
    await page.getByText(`旧主题：${ids.other} · 旧版本：${ids.work}`, { exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '下一页旧入口', exact: true }).waitFor();
  });
});
