import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
test('用量界面合并供应商别名，并保留发送证据与费用口径', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-usage-ui-'));
  try {
    const require = createRequire(path.resolve('package.json')), outfile = path.join(directory, 'panel.mjs');
    await build({ entryPoints: ['src/renderer/UsagePanel.tsx'], outfile, bundle: true, platform: 'node', format: 'esm',
      plugins: [{ name: 'react-runtime', setup(plugin) { plugin.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: require.resolve(args.path), external: true })); } }] });
    const { UsageSummaryView } = await import(pathToFileURL(outfile).href);
    const summary = {
      totalCalls: 1, totalAttempts: 3, authorizedUnconfirmedCalls: 1, notSentAttempts: 1, unknownUsageCalls: 2,
      totalInputTokens: null, totalOutputTokens: null, knownInputTokens: 12, knownOutputTokens: 3,
      unknownCostCalls: 3, providerCounts: { synthetic: 1 }, outcomeCounts: { cancelled: 2, failed: 1 },
      costTotals: [{ status: 'known', currency: 'USD', pricingVersion: 'v1', amount: '0.002', calls: 1 },
        { status: 'estimated', currency: 'CNY', pricingVersion: 'v2', amount: '0.03', calls: 1 }],
      recent: [{ scopeKind: 'owner_memory', provider: 'synthetic', modelName: 'synthetic-model', calledAt: '2026-10-24T00:00:00Z',
        latencyMs: 4, dispatch: 'authorized_unconfirmed', outcome: 'cancelled', inputTokens: null, outputTokens: null,
        cacheReadTokens: null, cacheWriteTokens: null, costStatus: 'unknown', costAmount: null, currency: null,
        pricingVersion: null, source: 'receipt', confirmed: false }] };
    const html = renderToStaticMarkup(React.createElement(UsageSummaryView, { summary }));
    for (const expected of ['已确认调用', '授权未确认', '未发送', '未知', '已知部分', '本人资料', '已取消',
      '失败', 'synthetic-model', 'USD', 'CNY', 'v1', 'v2', '估算', '供应商缓存']) assert.ok(html.includes(expected), expected);
    assert.doesNotMatch(html, /费用：0|费用合计：0|contact_id|entry_id/);
    for (const [providerCounts, totalCalls, expectedRows] of [
      [{ deepseek: 1244, 'notalone-deepseek': 668 }, 1912, [['DeepSeek', '1,912', '100%']]],
      [{ 'notalone-deepseek': 3, deepseek: 1, synthetic: 4 }, 8, [['DeepSeek', '4', '50%'], ['synthetic', '4', '50%']]],
      [{ deepseek: 2 }, 2, [['DeepSeek', '2', '100%']]],
      [{ 'notalone-deepseek': 2 }, 2, [['DeepSeek', '2', '100%']]],
      [{}, 0, []],
    ]) {
      const input = { ...summary, providerCounts, totalCalls,
        recent: [{ ...summary.recent[0], provider: 'notalone-deepseek' }] };
      const before = structuredClone(input);
      const rendered = renderToStaticMarkup(React.createElement(UsageSummaryView, { summary: input }));
      const distribution = rendered.match(/<ul class="usage-provider-list">(.*?)<\/ul>/s)?.[1];
      assert.notEqual(distribution, undefined);
      assert.equal((distribution.match(/<li>/g) ?? []).length, expectedRows.length);
      for (const [name, count, width] of expectedRows) {
        assert.ok(distribution.includes(`<span>${name}</span><strong>${count}<small> 次</small>`));
        assert.ok(distribution.includes(`style="width:${width}"`));
      }
      if (totalCalls === 0) assert.ok(rendered.includes('暂无已确认调用。'));
      assert.ok(rendered.includes('notalone-deepseek · 本人资料'));
      assert.deepEqual(input, before);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
