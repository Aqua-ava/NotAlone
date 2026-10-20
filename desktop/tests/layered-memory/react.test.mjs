import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixture, payload, readyPayload, profilePayload, ids } from './support.mjs';
import { selectLayeredMemory, withMemoryPage } from './react-support.mjs';

test('资料页分别展示整理与回复质量，回复合同变化不误报整理资格失效', { timeout: 20000 }, async (t) => {
  let replyChanged = false;
  const f = await fixture(async (request) => {
    if (request.path.includes('/layered-memory')) {
      if (request.method === 'POST') replyChanged = true;
      return { generation: 1, data: readyPayload({ quality_status: 'verified', quality: {
        organization: { status: 'verified', reasons: [], contract_id: 'organization-v1', report_id: 'organization-report-v1' },
        reply: replyChanged ? { status: 'unknown', reasons: ['contract_changed'], contract_id: 'reply-v2', report_id: 'reply-report-v1' }
          : { status: 'verified', reasons: [], contract_id: 'reply-v1', report_id: 'reply-report-v1' },
        automatic_use_allowed: !replyChanged, synthetic: false,
      } }) };
    }
    return { generation: 1, data: request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } };
  });
  await withMemoryPage(f, t.signal, async (page) => {
    await selectLayeredMemory(page);
    const organization = page.getByRole('group', { name: '整理质量' });
    const reply = page.getByRole('group', { name: '回复读取质量' });
    await organization.getByText('已验证', { exact: true }).waitFor();
    await organization.getByText('评测报告：organization-report-v1', { exact: true }).waitFor();
    await reply.getByText('已验证', { exact: true }).waitFor();
    await page.getByText('质量资格有效；仅在关系语境及对应范围已开启时允许真实资料自动加载。', { exact: true }).waitFor();
    assert.equal(await page.getByText('仅用于受控合成验证，不代表真实模型质量已获资格。', { exact: true }).count(), 0);
    await page.getByRole('button', { name: '刷新主题资料', exact: true }).click();
    await reply.getByText('未验证', { exact: true }).waitFor();
    await reply.getByText('模型、规则、用途或预算合同已变化，须重新评测。', { exact: true }).waitFor();
    await reply.getByText('质量合同：reply-v2', { exact: true }).waitFor();
    await organization.getByText('已验证', { exact: true }).waitFor();
    await organization.getByText('评测报告：organization-report-v1', { exact: true }).waitFor();
    await page.getByText('真实资料自动加载已关闭；整理与回复读取质量均已验证后才可使用。', { exact: true }).waitFor();
    await page.getByRole('heading', { name: '合成读书计划' }).waitFor();
  });
});

test('资料页显示未通过的具体原因与报告，合成控制数据不显示真实已验证', { timeout: 20000 }, async (t) => {
  let synthetic = false;
  const f = await fixture(async (request) => {
    if (request.path.includes('/layered-memory')) return { generation: 1, data: readyPayload({ quality_status: synthetic ? 'synthetic' : 'failed', quality: {
      organization: { status: synthetic ? 'unknown' : 'failed', reasons: synthetic ? ['no_evaluation_report'] : ['critical_semantic_errors', 'unrecognized_failure'],
        contract_id: 'organization-v1', report_id: synthetic ? null : 'failed-report-v1' },
      reply: { status: 'unknown', reasons: ['no_evaluation_report'], contract_id: 'reply-v1', report_id: null },
      automatic_use_allowed: false, synthetic,
    } }) };
    return { generation: 1, data: request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } };
  });
  await withMemoryPage(f, t.signal, async (page) => {
    await selectLayeredMemory(page);
    const organization = page.getByRole('group', { name: '整理质量' });
    await organization.getByText('未通过', { exact: true }).waitFor();
    await organization.getByText('出现关键语义错误，未满足零关键错误要求。', { exact: true }).waitFor();
    await organization.getByText('当前质量证据尚不完整，请查看对应评测报告。', { exact: true }).waitFor();
    assert.equal(await organization.getByText('unrecognized_failure', { exact: true }).count(), 0);
    await organization.getByText('评测报告：failed-report-v1', { exact: true }).waitFor();
    await page.getByRole('heading', { name: '合成读书计划' }).waitFor();
    synthetic = true;
    await page.getByRole('button', { name: '重新读取主题资料', exact: true }).click();
    await page.getByText('仅用于受控合成验证，不代表真实模型质量已获资格。', { exact: true }).waitFor();
    await organization.getByText('未验证', { exact: true }).waitFor();
    assert.equal(await page.getByText('已验证', { exact: true }).count(), 0);
    assert.equal(await page.getByText('评测报告：failed-report-v1', { exact: true }).count(), 0);
  });
});

test('当前关系资料页面由用户确认用途后开启主题资料，未知质量不会当作成功', { timeout: 20000 }, async (t) => {
  let saved = payload();
  const f = await fixture(async (request) => {
    if (request.path.includes('/layered-memory')) {
      if (request.method === 'POST') saved = payload({ enabled: true, settings_generation: 1, status: 'blocked' });
      return { generation: 1, data: saved };
    }
    return { generation: 1, data: request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } };
  });
  await withMemoryPage(f, t.signal, async (page) => {
      await selectLayeredMemory(page);
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

test('用户查看系统整理的部分覆盖与段落时间依据，停用回看、重新读取和删除各自生效', { timeout: 20000 }, async (t) => {
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
  await withMemoryPage(f, t.signal, async (page) => {
    await selectLayeredMemory(page);
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
    assert.equal(await page.getByRole('button', { name: '对方', exact: true }).getAttribute('aria-pressed'), 'true');
  });
});

test('用户刷新可分别观察空资料与整理失败，失败不会保留旧主题正文', { timeout: 20000 }, async (t) => {
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
  await withMemoryPage(f, t.signal, async (page) => {
    await selectLayeredMemory(page);
    await page.getByText('暂无合格资料可整理', { exact: true }).waitFor();
    await page.getByRole('button', { name: '刷新主题资料' }).click();
    await page.getByText('暂无合格资料可整理', { exact: true }).waitFor();
    await page.getByRole('button', { name: '刷新主题资料' }).click();
    await page.getByRole('alert').filter({ hasText: '部分整理未完成，请核对主题资料与长期背景状态' }).waitFor();
    await page.getByRole('button', { name: '继续整理主题资料', exact: true }).click();
    await page.getByText('暂无合格资料可整理', { exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: '合成读书计划' }).count(), 0);
  });
});

test('用户逐项查看长期背景与依据，停用仍可回看，并可撤回当前版而不恢复旧版', { timeout: 20000 }, async (t) => {
  let saved = profilePayload(), posted;
  const f = await fixture(async (request) => {
    if (request.path.includes('/layered-memory')) {
      if (request.path.endsWith('/disable')) saved = profilePayload({ enabled: false, status: 'disabled', settings_generation: 2 });
      if (request.path.endsWith('/withdraw-profile')) { posted = request; saved = readyPayload({ enabled: false, status: 'disabled',
        settings_generation: 2, organization_generation: 2 }); }
      return { generation: 1, data: saved };
    }
    return { generation: 1, data: request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } };
  });
  await withMemoryPage(f, t.signal, async (page) => {
    await selectLayeredMemory(page);
    const profile = page.getByRole('region', { name: '长期背景', exact: true });
    await profile.getByText('系统整理', { exact: true }).waitFor({ timeout: 3000 });
    await profile.getByText('曾有共同读书安排，是否持续尚未核实。', { exact: true }).waitFor();
    await profile.getByText('时间状态：尚不确定', { exact: true }).waitFor();
    await profile.getByText('不确定性：没有新的来源核实持续状态。', { exact: true }).waitFor();
    await profile.getByText('查看第 1 项依据与时间', { exact: true }).click();
    await profile.getByText(`底层记忆：${ids.memory} · 版本 1 · 用户手动录入`, { exact: true }).waitFor();
    await profile.getByText('生成时核实状态：当前未核实', { exact: true }).waitFor();
    await profile.getByText('查看长期背景版本', { exact: true }).click();
    await profile.getByText(`版本标识：${ids.profile}`, { exact: true }).waitFor();
    await page.getByRole('button', { name: '停用主题资料', exact: true }).click();
    await page.getByText('已停用', { exact: true }).waitFor();
    await profile.getByText('曾有共同读书安排，是否持续尚未核实。', { exact: true }).waitFor();
    await profile.getByRole('button', { name: '撤回本版长期背景', exact: true }).click();
    await page.getByText('本版长期背景已撤回，未自动恢复旧版。底层记忆可另行管理。', { exact: true }).waitFor();
    assert.deepEqual(posted.body, { settings_generation: 2, organization_generation: 1, profile_version_id: ids.profile });
    assert.equal(await page.getByText('曾有共同读书安排，是否持续尚未核实。', { exact: true }).count(), 0);
    await page.getByText('暂无可展示的长期背景。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '重新读取主题资料', exact: true }).click();
    assert.equal(await page.getByText('曾有共同读书安排，是否持续尚未核实。', { exact: true }).count(), 0);
  });
});

test('模型调用额度耗尽时显示累计与剩余，刷新后仍暂停并解释额度范围', { timeout: 20000 }, async (t) => {
  let refreshed = false;
  const ready = profilePayload();
  const f = await fixture(async (request) => {
    if (request.path.includes('/layered-memory')) {
      if (request.method === 'POST') refreshed = true;
      return { generation: 1, data: readyPayload({ status: 'paused', error_code: 'model_call_budget_exhausted',
        scenarios: [], model_calls_used: 4, model_call_limit: 4, budget: ready.layered_memory.budget }) };
    }
    return { generation: 1, data: request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } };
  });
  await withMemoryPage(f, t.signal, async (page) => {
    await selectLayeredMemory(page);
    const paused = page.getByText('当前工作模型调用预算已耗尽，整理已暂停。刷新不会重置预算。', { exact: true });
    await paused.waitFor({ timeout: 3000 });
    await page.getByText('当前工作模型调用：累计已消耗 4 次 · 剩余 0 次 · 上限 4 次。', { exact: true }).waitFor();
    await page.getByText('额度包含失败、超时及已预留后中断的调用。当前合法的新目标或新启用世代独立计额。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '刷新主题资料', exact: true }).click();
    await paused.waitFor();
    assert.equal(refreshed, true);
    assert.equal((await f.bridge.getState()).layeredMemory.value.budget.modelCallsUsed, 4);
    assert.equal((await f.bridge.getState()).layeredMemory.value.budget.modelCallsRemaining, 0);
    assert.equal(await page.getByRole('heading', { name: '合成读书计划' }).count(), 0);
  });
});

test('模型调用计数缺失或不合法时撤下旧正文，不能显示未经核对的额度', { timeout: 20000 }, async (t) => {
  const valid = profilePayload(), budget = valid.layered_memory.budget;
  let saved = valid;
  const f = await fixture(async (request) => {
    if (request.path.includes('/layered-memory')) return { generation: 1, data: saved };
    return { generation: 1, data: request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } };
  });
  await withMemoryPage(f, t.signal, async (page) => {
    await selectLayeredMemory(page);
    const wrong = [
      { model_calls_used: 3, model_calls_remaining: 0 },
      { model_calls_used: 4, model_calls_remaining: 1 },
      { model_calls_used: undefined }, { model_calls_remaining: undefined },
      { model_calls_used: -1, model_calls_remaining: 5 },
      { model_calls_used: 4.5, model_calls_remaining: 0 },
      { model_calls_used: '4' }, { model_calls_used: 5, model_calls_remaining: -1 },
    ];
    for (const invalid of wrong) {
      saved = valid;
      await page.getByRole('button', { name: '重新读取主题资料', exact: true }).click();
      await page.getByRole('heading', { name: '合成读书计划', exact: true }).waitFor();
      saved = profilePayload({ budget: { ...budget, ...invalid } });
      await page.getByRole('button', { name: '重新读取主题资料', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: '主题资料读取失败或旧入口分页已过期，旧内容已撤下。请重新读取首屏。' }).waitFor({ timeout: 3000 });
      assert.equal(await page.getByRole('heading', { name: '合成读书计划', exact: true }).count(), 0);
      assert.equal(await page.getByText('曾有共同读书安排，是否持续尚未核实。', { exact: true }).count(), 0);
      assert.equal(await page.getByText('当前工作模型调用：', { exact: false }).count(), 0);
    }
  });
});

test('用户暂停首次覆盖再继续同一工作，显示真实批次且保留先前主题正文', { timeout: 20000 }, async (t) => {
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
          budget: { ...saved.layered_memory.budget, max_model_calls: 4, model_calls_used: 4, model_calls_remaining: 0 },
          scenarios: [{ ...first, paragraphs: [...first.paragraphs, {
            text: '后来继续参加合成阅读讨论。', references: first.paragraphs[0].references,
          }] }] });
      }
      return { generation: 1, data: saved };
    }
    return { generation: 1, data: request.path.endsWith('/sources') ? { sources: [] }
      : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } };
  });
  await withMemoryPage(f, t.signal, async (page) => {
    await selectLayeredMemory(page);
    await page.getByText('正在整理，尚未完成', { exact: true }).waitFor();
    await page.getByRole('button', { name: '暂停整理主题资料', exact: true }).click();
    await page.getByText('已暂停，剩余资料可继续整理', { exact: true }).waitFor({ timeout: 3000 });
    await page.getByText('合格资料 2 条 · 已覆盖 1 条 · 剩余 1 条', { exact: true }).waitFor();
    await page.getByText('当前批次：1', { exact: true }).waitFor();
    await page.getByText('累计已用 2 / 已授权 2 次模型调用', { exact: true }).waitFor({ timeout: 3000 });
    await page.getByText('本批上限：2 条新记忆、2 个主题、3 段、500 字符。', { exact: true }).waitFor({ timeout: 3000 });
    await page.getByText('当前工作模型调用授权上限：2 次。', { exact: true }).waitFor();
    await page.getByText('每次继续仅推进一批，并追加模型调用额度；已消耗调用不会因继续或重启清零。', { exact: true }).waitFor();
    await page.getByRole('button', { name: '继续整理主题资料', exact: true }).click();
    await page.getByText('合格资料 2 条 · 已覆盖 2 条 · 剩余 0 条', { exact: true }).waitFor();
    await page.getByText('当前批次：2', { exact: true }).waitFor();
    await page.getByText('累计已用 4 / 已授权 4 次模型调用', { exact: true }).waitFor();
    await page.getByText('当前工作模型调用授权上限：4 次。', { exact: true }).waitFor();
    await page.getByText('本批上限：2 条新记忆、2 个主题、3 段、500 字符。', { exact: true }).waitFor();
    await page.getByText('曾计划参加合成读书会，当前是否成行尚未核实。', { exact: true }).waitFor();
    await page.getByText('后来继续参加合成阅读讨论。', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '继续整理主题资料', exact: true }).count(), 0);
    assert.equal(posted[0].path, `/api/contacts/${ids.contact}/layered-memory/pause`);
    assert.deepEqual(posted[0].body, { settings_generation: 1, work_revision: 1 });
    assert.equal(posted[1].path, `/api/contacts/${ids.contact}/layered-memory/continue`);
    assert.deepEqual(posted[1].body, { settings_generation: 1, work_revision: 2 });
  });
});

test('资料变化显示待更新与真实剩余，后台完成后自动展示新正文', { timeout: 20000 }, async (t) => {
  let saved = readyPayload({ maintenance_pending: true, status: 'stale', covered_count: 0, remaining_count: 3, scenarios: [] });
  const f = await fixture(async (request) => ({ generation: 1, data: request.path.includes('/layered-memory') ? saved
    : request.path.endsWith('/sources') ? { sources: [] } : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } }));
  try { await withMemoryPage(f, t.signal, async (page) => {
    await selectLayeredMemory(page);
    await page.getByText('资料已变化，等待后台更新。', { exact: true }).waitFor({ timeout: 3000 });
    await page.getByText('合格资料 3 条 · 已覆盖 0 条 · 剩余 3 条', { exact: true }).waitFor();
    saved = readyPayload({ maintenance_pending: false });
    await page.getByRole('heading', { name: '合成读书计划' }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByText('资料已变化，等待后台更新。', { exact: true }).count(), 0);
  }); } finally { f.disconnect(); }
});

test('旧主题入口展示拆分后的合法终端并导航到当前版本', { timeout: 20000 }, async (t) => {
  const first = readyPayload().layered_memory.scenarios[0];
  const saved = readyPayload({ scenario_mappings: [{ source_scenario_id: ids.other, source_version_id: ids.work,
    targets: [{ scenario_id: ids.scenario, version_id: ids.version }, { scenario_id: ids.memory, version_id: ids.contact }] }],
    scenarios: [first, { ...first, scenario_id: ids.memory, version_id: ids.contact, title: '合成写作计划' }] });
  const f = await fixture(async (request) => ({ generation: 1, data: request.path.includes('/layered-memory') ? saved
    : request.path.endsWith('/sources') ? { sources: [] } : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } }));
  try { await withMemoryPage(f, t.signal, async (page) => {
    await selectLayeredMemory(page);
    await page.getByText('查看旧主题入口的当前去向', { exact: true }).click({ timeout: 3000 });
    await page.getByText(`旧主题：${ids.other} · 旧版本：${ids.work}`, { exact: true }).waitFor();
    await page.getByRole('link', { name: '查看当前主题：合成写作计划', exact: true }).click();
    const target = page.getByRole('article').filter({ has: page.getByRole('heading', { name: '合成写作计划' }) });
    assert.equal(await target.getAttribute('id'), `layered-scenario-${ids.contact}`);
    assert.equal(await page.getByRole('link', { name: '查看当前主题：合成读书计划', exact: true }).count(), 1);
  }); } finally { f.disconnect(); }
});

test('旧入口分页只显示当前页，可查看最旧入口并返回首屏', { timeout: 20000 }, async (t) => {
  const first = readyPayload({ mapping_cursor: null, mapping_next_cursor: '1:100' });
  const last = readyPayload({ mapping_cursor: '1:100', mapping_next_cursor: null,
    scenario_mappings: [{ source_scenario_id: ids.other, source_version_id: ids.work,
      targets: [{ scenario_id: ids.scenario, version_id: ids.version }] }] });
  const f = await fixture(async (request) => ({ generation: 1, data: request.path.includes('/layered-memory')
    ? request.path.includes('mapping_cursor=') ? last : first
    : request.path.endsWith('/sources') ? { sources: [] } : request.path.endsWith('/memory-candidates') ? { candidates: [] } : { memories: [] } }));
  await withMemoryPage(f, t.signal, async (page) => {
    await selectLayeredMemory(page);
    await page.getByRole('button', { name: '下一页旧入口', exact: true }).click({ timeout: 3000 });
    await page.getByText('查看旧主题入口的当前去向', { exact: true }).click();
    await page.getByText(`旧主题：${ids.other} · 旧版本：${ids.work}`, { exact: true }).waitFor();
    await page.getByRole('button', { name: '返回旧入口首屏', exact: true }).click();
    await page.getByText(`旧主题：${ids.other} · 旧版本：${ids.work}`, { exact: true }).waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '下一页旧入口', exact: true }).waitFor();
  });
});
