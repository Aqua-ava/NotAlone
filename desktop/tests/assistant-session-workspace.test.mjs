import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

test('SQLite会话先显示表达工作区，讨论输入与空状态收在折叠的助手讨论中', { timeout: 30000 }, async t => {
  const compiled = await build({ stdin: { contents: `
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
    import './src/renderer/helper-layout.css';
    import './src/renderer/rewrite.css';
    const sessionId = 'session';
    const state = {
      contactId: 'contact', scopeRevision: 1, phase: 'idle', generationBlock: null,
      exploration: { phase: 'idle' }, generationJobs: [], sourceAvailability: null,
      sessionDeletion: null,
      savedSession: { phase: 'ready', sessionId, discussionEntries: [], runtimeRecovery: 'none', turns: [], inputs: [] },
      sessionCatalog: { phase: 'ready', items: [], currentSessionId: sessionId, selectionPending: false },
    };
    window.notalone = { sqliteDiscussion: {
      candidates: { execute: request => window.__candidateExecute(request) },
      onInvalidated: () => () => {}, submit: async request => request,
    } };
    createRoot(document.getElementById('root')).render(React.createElement(AssistantSessionPanel, {
      replies: { state },
    }));
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife',
    outfile: 'assistant-session-workspace.js', jsx: 'automatic', write: false, logLevel: 'silent' });
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html'); res.end('<div class="ime-pane"><div id="root"></div></div>');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  t.after(() => browser.close());
  const page = await browser.newPage(); page.setDefaultTimeout(5000);
  await page.exposeFunction('__candidateExecute', async request => {
    assert.equal(request.action, 'read');
    return { requests: [] };
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const stylesheet = compiled.outputFiles.find(file => file.path.endsWith('.css'));
  assert.ok(stylesheet, 'browser fixture should load the production panel styles');
  await page.addStyleTag({ content: stylesheet.text });
  const script = compiled.outputFiles.find(file => file.path.endsWith('.js'));
  assert.ok(script, 'browser fixture should bundle the actual React component');
  await page.addScriptTag({ content: script.text });

  const workspace = page.getByRole('region', { name: '表达工作区' });
  await expect(workspace.getByRole('heading', { name: '有什么想说的？', exact: true })).toBeVisible();
  await expect(workspace.getByRole('button', { name: '帮我表达', exact: true })).toBeVisible();
  await expect(workspace.getByRole('button', { name: '帮我想想', exact: true })).toBeVisible();
  assert.equal(await workspace.getByRole('button', { name: '帮我想想', exact: true }).evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(47, 104, 140)');
  const sessionPanel = page.getByRole('region', { name: '助手会话' });
  assert.equal(await sessionPanel.evaluate(element => getComputedStyle(element).padding), '0px');
  assert.equal(await sessionPanel.evaluate(element => getComputedStyle(element).borderTopWidth), '0px');
  const discussion = page.locator('details.sqlite-discussion-details');
  await expect(discussion.locator('summary')).toHaveText('与助手讨论');
  assert.equal(await page.evaluate(() => {
    const workspace = document.querySelector('[aria-label="表达工作区"]');
    const discussion = document.querySelector('details.sqlite-discussion-details');
    return Boolean(workspace && discussion && (workspace.compareDocumentPosition(discussion) & Node.DOCUMENT_POSITION_FOLLOWING));
  }), true);
  assert.equal(await discussion.evaluate(element => element.open), false);
  await expect(page.getByText('当前会话还没有讨论。', { exact: true })).toBeHidden();
  await expect(discussion.getByRole('textbox', { name: '讨论内容', exact: true })).toBeHidden();
});
