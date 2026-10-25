import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

const contactId = '10000000-0000-4000-8000-000000000001';
const state = {
  phase: 'ready', scope: 'contact', contactId, scopeRevision: 4, hasMore: false, error: null,
  busyTaskId: null, message: null,
  tasks: [
    { taskId: '20000000-0000-4000-8000-000000000001', taskType: 'import',
      status: 'queued', phase: 'parse', messageCount: 4, retryCount: 0, errorCode: null,
      processedCount: 1, totalCount: 4, updatedAt: '2026-10-25T00:00:00Z',
      steps: [{ name: 'parse', status: 'pending', attemptCount: 0, processedCount: 1,
        totalCount: 4, errorCode: null, leaseExpiresAt: null }],
      actions: [{ kind: 'stop' }] },
    { taskId: '20000000-0000-4000-8000-000000000002', taskType: 'skill_learning',
      status: 'failed', phase: 'verify_skill_drafts', messageCount: 3, retryCount: 3,
      errorCode: 'synthetic_failed', processedCount: 3, totalCount: 3,
      updatedAt: '2026-10-25T00:00:00Z',
      steps: [{ name: 'verify_skill_drafts', status: 'failed', attemptCount: 3, processedCount: 0,
        totalCount: 3, errorCode: 'synthetic_failed', leaseExpiresAt: null }],
      actions: [{ kind: 'recover', target: 'skill_learning' }] },
  ],
};
const ownerState = {
  ...state, scope: 'owner', contactId: null,
  tasks: [{ ...state.tasks[1], taskId: '20000000-0000-4000-8000-000000000003',
    taskType: 'layered_memory', phase: 'organize_memory', actions: [] }],
};

test('后台任务面板显示真实处理量与失败原因，并只发送固定动作', { timeout: 30000 }, async t => {
  const compiled = await build({
    stdin: {
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
        import { BackgroundTasksPanel } from './src/renderer/BackgroundTasksPanel';
        createRoot(document.getElementById('root')).render(
          <BackgroundTasksPanel selection={${JSON.stringify({ scope: 'contact', contactId, scopeRevision: 4 })}} />);`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 10000 });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const calls = [];
  await page.exposeFunction('recordBackgroundTask', (kind, args) => { calls.push({ kind, args }); });
  await page.route('http://127.0.0.1/background-tasks-test', route => route.fulfill({
    contentType: 'text/html', body: '<div id="root"></div>',
  }));
  await page.goto('http://127.0.0.1/background-tasks-test');
  await page.evaluate(next => {
    window.notalone = { backgroundTasks: {
      onStateChanged: () => () => {},
      getState: async () => next,
      read: async args => window.recordBackgroundTask('read', [args]),
      cancelRead: async () => {},
      stop: async args => window.recordBackgroundTask('stop', [args]),
      recover: async args => window.recordBackgroundTask('recover', [args]),
    } };
  }, state);
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const panel = page.getByRole('region', { name: '当前联系人后台任务' });
  await panel.getByText('历史导入 · 等待执行', { exact: true }).waitFor();
  await panel.getByText('1 / 4', { exact: true }).waitFor();
  await panel.getByText('失败原因：synthetic_failed', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '停止任务', exact: true }).click();
  await panel.getByRole('button', { name: '恢复原任务', exact: true }).click();
  await page.waitForTimeout(50);
  assert.deepEqual(calls.map(call => call.kind).sort(), ['read', 'recover', 'stop']);
  assert.deepEqual(calls.find(call => call.kind === 'read').args[0], {
    scope: 'contact', contactId, scopeRevision: 4,
  });
  assert.equal(calls.find(call => call.kind === 'stop').args[0].taskId,
    '20000000-0000-4000-8000-000000000001');
});

test('本人页只读取并显示owner范围后台任务', { timeout: 30000 }, async t => {
  const compiled = await build({
    stdin: {
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client';
        import { BackgroundTasksPanel } from './src/renderer/BackgroundTasksPanel';
        createRoot(document.getElementById('root')).render(
          <BackgroundTasksPanel selection={${JSON.stringify({ scope: 'owner', scopeRevision: 4 })}} />);`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false,
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 10000 });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  const calls = [];
  await page.exposeFunction('recordBackgroundTask', (kind, args) => { calls.push({ kind, args }); });
  await page.route('http://127.0.0.1/owner-background-tasks-test', route => route.fulfill({
    contentType: 'text/html', body: '<div id="root"></div>',
  }));
  await page.goto('http://127.0.0.1/owner-background-tasks-test');
  await page.evaluate(next => {
    window.notalone = { backgroundTasks: {
      onStateChanged: () => () => {},
      getState: async () => next,
      read: async args => window.recordBackgroundTask('read', [args]),
      cancelRead: async () => {},
      stop: async () => {},
      recover: async () => {},
    } };
  }, ownerState);
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const panel = page.getByRole('region', { name: '本人后台任务' });
  await panel.getByText('主题与画像整理 · 失败', { exact: true }).waitFor();
  await page.waitForTimeout(50);
  assert.deepEqual(calls.find(call => call.kind === 'read').args[0], {
    scope: 'owner', scopeRevision: 4,
  });
});
