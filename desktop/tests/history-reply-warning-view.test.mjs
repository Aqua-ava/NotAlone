import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

test('不完整确认只作用于当前联系人当前会话，状态恢复及重开仍显示警告', async t => {
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
  const consent = page.getByRole('checkbox', { name: '基于已同步部分继续' });
  await expect(generate).toBeDisabled();
  await consent.check(); await expect(generate).toBeEnabled();
  await generate.click();
  assert.equal((await page.evaluate(() => window.calls))[0][2], true);
  await expect(page.getByRole('alert')).toContainText('历史覆盖不完整');
  await expect(generate).toBeDisabled();
  await consent.check();
  await page.evaluate(() => window.render('incomplete', 'synthetic-b'));
  await expect(consent).not.toBeChecked(); await expect(generate).toBeDisabled();
  await consent.check();
  await page.evaluate(() => window.render('syncing', 'synthetic-b'));
  await expect(generate).toBeDisabled();
  await page.evaluate(() => window.render('incomplete', 'synthetic-b'));
  await expect(consent).not.toBeChecked();
  await page.evaluate(() => window.render('complete', 'synthetic-b'));
  await expect(generate).toBeEnabled(); await expect(page.getByRole('alert')).toHaveCount(0);
  await page.evaluate(() => window.render('incomplete', 'synthetic-a', 'session-restored'));
  await expect(consent).not.toBeChecked(); await expect(page.getByRole('alert')).toContainText('历史覆盖不完整');
});

test('连续修改使用本次确认，不能继承旧轮确认或在同步中生成', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { AssistantContinuationControls } from './src/renderer/AssistantContinuationControls';
    const root = createRoot(document.getElementById('root')); window.calls = [];
    window.render = (phase = 'incomplete') => root.render(<AssistantContinuationControls historyCoverage={phase}
      replies={{ state: { contactId: 'a', phase: 'idle', exploration: { phase: 'idle' }, candidateVersions: { phase: 'ready' },
        savedSession: { phase: 'ready', sessionId: 'saved', turns: [{ state: 'completed', reply: {}, input: { allow_incomplete_history: true } }] } },
        continueSession: async (...args) => window.calls.push(args) }} />);
    window.render();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  await page.setContent('<div id="root"></div>'); await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const button = page.getByRole('button', { name: '继续修改', exact: true });
  await expect(button).toBeDisabled();
  await page.getByRole('checkbox', { name: '本次连续修改基于已同步部分继续' }).check();
  await page.getByRole('textbox', { name: '继续修改要求' }).fill('再简短一点');
  await button.click();
  assert.equal((await page.evaluate(() => window.calls))[0][2], true);
  await expect(button).toBeDisabled(); await expect(page.getByRole('alert')).toContainText('历史覆盖不完整');
  await page.evaluate(() => window.render('syncing')); await expect(button).toBeDisabled();
  await page.evaluate(() => window.render('complete')); await expect(button).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
