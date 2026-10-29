import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

test('真实记忆页面在 SQLite 模式仅挂载固定处理，资格失效撤下候选和过程正文', { timeout: 20000 }, async t => {
  const ids = {
    run: '11111111-1111-4111-8111-111111111111', task: '22222222-2222-4222-8222-222222222222',
    contact: '33333333-3333-4333-8333-333333333333', record: '44444444-4444-4444-8444-444444444444',
  };
  const run = {
    runId: ids.run, state: 'incomplete', total: 1, succeeded: 1, failed: 0, unknown: 0,
    stage: 'extraction_verification', laterStages: 'pending', inputs: [],
    tasks: [{ taskId: ids.task, scopeKind: 'contact', contactId: ids.contact, state: 'succeeded', total: 1, succeeded: 1, errorCode: null }],
    candidates: [{ id: ids.record, scopeKind: 'contact', contactId: ids.contact, body: '合成记忆页面候选', state: 'verified_pending_decision', origin: 'auto' }],
  };
  const trace = { calls: [], events: [{
    eventId: ids.record, attemptId: ids.task, kind: 'request', callId: null, inputNos: [1],
    payload: { input: '合成记忆页面输入', output: '合成记忆页面返回' }, sources: [{ contactId: ids.contact, recordId: ids.record }],
  }] };
  const compiled = await build({
    stdin: { contents: `import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {MemoryPage} from './src/renderer/MemoryPage';
      import {FixedMemoryProcessingController} from './src/main/memory/fixed-processing';
      const invalidations = new Set();
      const controller = new FixedMemoryProcessingController({
        getConnectionGeneration: () => 1,
        requestJson: async request => ({generation: 1, data: await window.requestJson(request.path)}),
      }, () => { for (const listener of invalidations) listener(); });
      window.legacyCalls = [];
      window.notalone = {
        fixedMemoryProcessing: {
          readMode: () => controller.mode(), readCurrent: () => controller.read(),
          start: request => controller.start(request), pause: request => controller.control('pause', request),
          continue: request => controller.control('continue', request), trace: request => controller.trace(request),
          release: async () => controller.release(),
          onInvalidated: listener => { invalidations.add(listener); return () => invalidations.delete(listener); },
        },
        backend: {onStateChanged: () => () => {}},
        memory: new Proxy({}, {get: (_, method) => (...args) => {
          window.legacyCalls.push(method);
          if (method.startsWith('on')) return () => {};
          return Promise.reject(new Error('SQLite 模式不得调用旧版记忆操作。'));
        }}),
      };
      window.invalidate = () => controller.synchronize();
      const session = {state: {revision: 1, scopeRevision: 1, directoryPhase: 'ready',
        contacts: [{contactId: '${ids.contact}', displayName: '合成联系人', messageCount: 1, sourceCount: 1}],
        selectedContactId: '${ids.contact}', draft: ''}, error: '', selectContact: async () => {}};
      createRoot(document.getElementById('root')).render(<MemoryPage session={session} navigate={() => {}}/>);`,
      resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, write: false, logLevel: 'silent',
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 10000 });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // 只替换网络边界；页面、控制器解析和失效发布均使用正式实现。
  await page.exposeFunction('requestJson', async path => {
    if (path === '/api/runtime/status') return { state: 'running', runtime: 'dsh', hostRuntime: 'typescript', storage: 'sqlite' };
    if (path === '/api/memory-processing/runs/current') return run;
    if (path === `/api/memory-processing/tasks/${ids.task}/events`) return trace;
    throw new Error(`未约定的合成请求：${path}`);
  });
  await page.route('http://127.0.0.1/memory-page-fixed-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://127.0.0.1/memory-page-fixed-test');
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const panel = page.getByRole('region', { name: '固定范围记忆处理' });
  await panel.getByText('合成记忆页面候选', { exact: true }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: '记忆分类' }).count(), 0);
  await panel.locator('summary').filter({ hasText: '查看本轮任务' }).click();
  await panel.getByRole('button', { name: '查看联系人 1过程', exact: true }).click();
  await panel.locator('summary').filter({ hasText: 'request' }).click();
  await panel.locator('pre').filter({ hasText: '合成记忆页面输入' }).waitFor();
  await page.evaluate(() => window.invalidate());
  await panel.getByRole('alert').filter({ hasText: '资料资格或连接已变化' }).waitFor();
  assert.equal(await panel.getByText('合成记忆页面候选', { exact: true }).count(), 0);
  assert.equal(await panel.locator('pre').count(), 0);
  assert.deepEqual(await page.evaluate(() => window.legacyCalls), [], '旧版记忆读取、刷新和订阅均未执行');
  assert.deepEqual(errors, [], '页面没有 React 或桥接异常');
});
