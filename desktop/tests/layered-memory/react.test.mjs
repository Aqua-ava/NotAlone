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
    assert.equal(await page.getByRole('heading', { name: '合成读书计划' }).count(), 0);
  });
});
