import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

test('历史各阶段均可直接生成，切换联系人或重开无需额外确认', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { UnifiedReplyWorkspace } from './src/renderer/UnifiedReplyWorkspace';
    const root = createRoot(document.getElementById('root')); window.calls = [];
    window.render = (phase = 'incomplete', contactId = 'synthetic-a', sessionId = 'session-a') => root.render(
      <UnifiedReplyWorkspace historyCoverage={phase}
        contacts={{ state: { selectedContactId: contactId, scopeRevision: 1, draft: '合成想法' } }}
        replies={{ state: { contactId, scopeRevision: 1, phase: 'idle', mode: 'rewrite_draft',
          options: { tone: 'original', instruction: '', inputKind: 'workspace', includeRelationshipContext: true },
          savedSession: { phase: 'ready', sessionId }, messages: { phase: 'ready', items: [] } },
          generateWorkspace: async (...args) => window.calls.push(args) }} />);
    window.render();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false,
    loader: { '.css': 'empty' } });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const generate = page.getByRole('button', { name: '帮我想想', exact: true });
  for (const phase of ['not_started', 'syncing', 'incomplete', 'complete']) {
    await page.evaluate(phase => window.render(phase), phase);
    await expect(generate).toBeEnabled();
    await expect(page.getByRole('checkbox', { name: '基于已同步部分继续' })).toHaveCount(0);
    await generate.click();
  }
  const calls = await page.evaluate(() => window.calls);
  assert.equal(calls.length, 4);
  assert.ok(calls.every(args => args[2] === undefined), '直接使用可用资料不伪造用户的历史确认');
  await page.evaluate(() => window.render('incomplete', 'synthetic-b', 'session-restored'));
  await expect(generate).toBeEnabled();
  await expect(page.getByText(/历史尚未追平|等待当前联系人历史同步/)).toHaveCount(0);
});
