import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

function deferred() {
  let resolve, reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

function currentView(connectionGeneration, total) {
  return { connectionGeneration, run: {
    runId: '11111111-1111-4111-8111-111111111111', state: 'incomplete', total, succeeded: total,
    failed: 0, unknown: 0, stage: 'extraction_verification', laterStages: 'pending',
    status: 'blocked', statusReason: 'later_stages_pending', sharedFaultCode: null, actions: [], controlVersion: 0, pending: 0, revoked: 0,
    calls: { prepared: 0, sending: 0, succeeded: 2, failed: 0, unknown: 0 }, tasks: [], inputs: [],
    candidates: [],
  } };
}

async function modesSettled(page, count) {
  await page.waitForFunction(value => window.modeSettled >= value, count);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function withEntry(t, command, inspect, controller = false) {
  const compiled = await build({
    stdin: {
      contents: `import React, {useEffect} from 'react';
        import {createRoot} from 'react-dom/client';
        import {MemoryProcessingEntry} from './src/renderer/MemoryProcessingEntry';
        ${controller ? "import {FixedMemoryProcessingController} from './src/main/memory/fixed-processing';" : ''}
        const listeners = new Set(), invalidations = new Set();
        window.modeSettled = 0; window.legacyMounts = 0;
        ${controller ? `const controller = new FixedMemoryProcessingController({
          getConnectionGeneration: () => 1,
          requestJson: async request => ({generation: 1, data: await window.command('requestJson', request.path)}),
        }, () => { for (const listener of invalidations) listener(); });
        listeners.add(() => controller.synchronize());
        const bridge = {
          readMode: async () => { try { return await controller.mode(); } finally { window.modeSettled++; } },
          readCurrent: request => controller.read(request),
          start: request => controller.start(request),
          pause: request => controller.control('pause', request),
          continue: request => controller.control('continue', request),
          trace: request => controller.trace(request),
          release: async () => controller.release(),
          onInvalidated: listener => { invalidations.add(listener); return () => invalidations.delete(listener); },
        };` : `const bridge = new Proxy({}, {get: (_, method) => {
          if (method === 'onInvalidated') return listener => {
            invalidations.add(listener); return () => invalidations.delete(listener);
          };
          return async (...args) => {
            try { const value = await window.command(method, ...args); return method === 'readCurrent' && value ? {...value,contactId:args[0]?.contactId} : value; }
            finally { if (method === 'readMode') window.modeSettled++; }
          };
        }});`}
        const backend = {onStateChanged: listener => {
          listeners.add(listener); return () => listeners.delete(listener);
        }};
        function LegacyBody() {
          useEffect(() => { window.legacyMounts++; }, []);
          return <section aria-label="旧版记忆正文">合成旧版记忆</section>;
        }
        const root = createRoot(document.getElementById('root'));
        let scopeKey = 'scope-a', revision = 0;
        const render = () => root.render(<MemoryProcessingEntry bridge={bridge} backend={backend} contactId="33333333-3333-4333-8333-333333333333" scopeKey={scopeKey}><LegacyBody/></MemoryProcessingEntry>);
        window.emitBackend = phase => {
          for (const listener of listeners) listener({phase, revision: ++revision, reused: false,
            canRetryConnection: false, canRetryShutdown: false, canSaveStartupPaths: false, canPrepareConfiguration: false});
        };
        window.invalidate = () => { for (const listener of invalidations) listener(); };
        window.changeScope = value => { scopeKey = value; render(); };
        window.hide = () => root.render(null);
        render();`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', write: false, logLevel: 'silent',
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 10000 });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.exposeFunction('command', command);
  await page.route('http://127.0.0.1/memory-entry-test', route => route.fulfill({
    contentType: 'text/html', body: '<div id="root"></div>',
  }));
  await page.goto('http://127.0.0.1/memory-entry-test');
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  await inspect(page);
  assert.deepEqual(errors, [], '页面没有 React 或桥接异常');
}

test('模式待核验时不挂载正文，明确 legacy 后才挂载旧版记忆', { timeout: 20000 }, async t => {
  const mode = deferred();
  await withEntry(t, async method => method === 'readMode' ? mode.promise : undefined, async page => {
    await page.getByRole('status').filter({ hasText: '正在核对记忆处理模式' }).waitFor();
    assert.equal(await page.getByRole('region', { name: '旧版记忆正文' }).count(), 0);
    assert.equal(await page.getByRole('region', { name: '固定范围记忆处理' }).count(), 0);
    assert.equal(await page.evaluate(() => window.legacyMounts), 0);
    mode.resolve({ connectionGeneration: 1, mode: 'legacy' });
    await page.getByRole('region', { name: '旧版记忆正文' }).waitFor();
    assert.equal(await page.evaluate(() => window.legacyMounts), 1);
    assert.equal(await page.getByRole('region', { name: '固定范围记忆处理' }).count(), 0);
  });
});

test('明确 sqlite 后挂载固定范围处理，正文失效由面板处理且不切回旧版', { timeout: 20000 }, async t => {
  await withEntry(t, async method => {
    if (method === 'readMode') return { connectionGeneration: 2, mode: 'sqlite' };
    if (method === 'readCurrent') return { connectionGeneration: 2, run: null };
  }, async page => {
    const panel = page.getByRole('region', { name: '固定范围记忆处理' });
    await panel.getByRole('status').filter({ hasText: '等待处理' }).waitFor();
    assert.equal(await page.getByRole('region', { name: '旧版记忆正文' }).count(), 0);
    assert.equal(await page.evaluate(() => window.legacyMounts), 0);
    await page.evaluate(() => window.invalidate());
    await panel.getByRole('alert').filter({ hasText: '资料资格或连接已变化' }).waitFor();
    assert.equal(await panel.getByRole('status').count(), 0);
  });
});

test('连接变化先撤下正文，旧连接晚到的模式不能盖过新连接核验', { timeout: 20000 }, async t => {
  const oldMode = deferred(), newMode = deferred();
  let reads = 0, generation = 1;
  await withEntry(t, async method => {
    if (method === 'readMode') {
      reads++;
      return reads === 1 ? { connectionGeneration: 1, mode: 'sqlite' } : reads === 2 ? oldMode.promise : newMode.promise;
    }
    if (method === 'readCurrent') return currentView(generation, generation === 1 ? 1 : 3);
  }, async page => {
    await page.getByText('提取与核验：已处理 1 / 1 条文字目标', { exact: true }).waitFor();
    await page.evaluate(() => window.emitBackend('disconnected'));
    await page.getByRole('status').filter({ hasText: '等待重新连接' }).waitFor();
    assert.equal(await page.getByText('提取与核验：已处理 1 / 1 条文字目标', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('region', { name: '固定范围记忆处理' }).count(), 0);
    await page.evaluate(() => window.emitBackend('connected'));
    await page.getByRole('status').filter({ hasText: '正在核对记忆处理模式' }).waitFor();
    await page.evaluate(() => window.emitBackend('stopping'));
    await page.getByRole('status').filter({ hasText: '等待重新连接' }).waitFor();
    await page.evaluate(() => window.emitBackend('connected'));
    await page.getByRole('status').filter({ hasText: '正在核对记忆处理模式' }).waitFor();
    oldMode.resolve({ connectionGeneration: 2, mode: 'legacy' });
    await modesSettled(page, 2);
    assert.equal(await page.getByRole('region', { name: '旧版记忆正文' }).count(), 0);
    assert.equal(await page.evaluate(() => window.legacyMounts), 0);
    assert.equal(await page.getByRole('region', { name: '固定范围记忆处理' }).count(), 0);
    generation = 3;
    newMode.resolve({ connectionGeneration: 3, mode: 'sqlite' });
    await page.getByText('提取与核验：已处理 3 / 3 条文字目标', { exact: true }).waitFor();
    await page.evaluate(() => window.emitBackend('connecting'));
    await page.getByRole('status').filter({ hasText: '等待重新连接' }).waitFor();
    assert.equal(await page.getByText('提取与核验：已处理 3 / 3 条文字目标', { exact: true }).count(), 0);
  });
});

test('模式读取失败撤下原页面，重试通过核验后才恢复对应入口', { timeout: 20000 }, async t => {
  const retry = deferred();
  let reads = 0;
  await withEntry(t, async method => {
    if (method === 'readMode') {
      reads++;
      if (reads === 1) return { connectionGeneration: 1, mode: 'legacy' };
      if (reads === 2) throw new Error('synthetic_mode_unavailable');
      return retry.promise;
    }
    if (method === 'readCurrent') return currentView(2, 2);
  }, async page => {
    await page.getByRole('region', { name: '旧版记忆正文' }).waitFor();
    await page.evaluate(() => window.emitBackend('connected'));
    await page.getByRole('alert').filter({ hasText: '记忆处理模式暂不可用' }).waitFor();
    assert.equal(await page.getByRole('region', { name: '旧版记忆正文' }).count(), 0);
    assert.equal(await page.getByRole('region', { name: '固定范围记忆处理' }).count(), 0);
    await page.getByRole('button', { name: '重新读取记忆模式', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '正在核对记忆处理模式' }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    assert.equal(await page.getByRole('region', { name: '旧版记忆正文' }).count(), 0);
    retry.resolve({ connectionGeneration: 2, mode: 'sqlite' });
    await page.getByText('提取与核验：已处理 2 / 2 条文字目标', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.legacyMounts), 1);
  });
});

test('范围变化撤下快照并重新核验，旧范围和卸载后的模式不能恢复页面', { timeout: 20000 }, async t => {
  const oldScope = deferred(), newScope = deferred(), afterUnmount = deferred();
  let reads = 0, total = 1;
  await withEntry(t, async method => {
    if (method === 'readMode') {
      reads++;
      return reads === 1 ? { connectionGeneration: 1, mode: 'sqlite' }
        : reads === 2 ? oldScope.promise : reads === 3 ? newScope.promise : afterUnmount.promise;
    }
    if (method === 'readCurrent') return currentView(1, total);
  }, async page => {
    await page.getByText('提取与核验：已处理 1 / 1 条文字目标', { exact: true }).waitFor();
    await page.evaluate(() => window.changeScope('scope-b'));
    await page.getByRole('status').filter({ hasText: '正在核对记忆处理模式' }).waitFor();
    assert.equal(await page.getByRole('region', { name: '固定范围记忆处理' }).count(), 0);
    await page.evaluate(() => window.changeScope('scope-c'));
    oldScope.resolve({ connectionGeneration: 1, mode: 'legacy' });
    await modesSettled(page, 2);
    assert.equal(await page.getByRole('region', { name: '旧版记忆正文' }).count(), 0);
    assert.equal(await page.evaluate(() => window.legacyMounts), 0);
    total = 3;
    newScope.resolve({ connectionGeneration: 1, mode: 'sqlite' });
    await page.getByText('提取与核验：已处理 3 / 3 条文字目标', { exact: true }).waitFor();
    assert.equal(await page.getByText('提取与核验：已处理 1 / 1 条文字目标', { exact: true }).count(), 0);
    await page.evaluate(() => window.emitBackend('connected'));
    await page.getByRole('status').filter({ hasText: '正在核对记忆处理模式' }).waitFor();
    await page.evaluate(() => window.hide());
    afterUnmount.resolve({ connectionGeneration: 1, mode: 'legacy' });
    await modesSettled(page, 4);
    assert.equal(await page.locator('#root').innerText(), '');
    assert.equal(await page.evaluate(() => window.legacyMounts), 0);
  });
});

test('真实控制器在旧面板释放后仍能完成 connected 触发的合法模式核验', { timeout: 20000 }, async t => {
  const reconnectedMode = deferred();
  let modeReads = 0;
  const status = { state: 'running', runtime: 'dsh', hostRuntime: 'typescript', storage: 'sqlite' };
  // 网络边界提供延迟合成响应；取消状态及连接代次仍由真实控制器核验。
  await withEntry(t, async (method, path) => {
    assert.equal(method, 'requestJson');
    if (path === '/api/runtime/status') {
      modeReads++;
      return modeReads === 1 ? status : reconnectedMode.promise;
    }
    if (path === '/api/memory-processing/contacts/33333333-3333-4333-8333-333333333333/current') return {contactId:'33333333-3333-4333-8333-333333333333',run:null,queue:{pending:0,nextDueAt:null,blockedContacts:0}};
    throw new Error(`未约定的合成请求：${path}`);
  }, async page => {
    const panel = page.getByRole('region', { name: '固定范围记忆处理' });
    await panel.getByRole('status').filter({ hasText: '等待处理' }).waitFor();
    await page.evaluate(() => window.emitBackend('connected'));
    await panel.waitFor({ state: 'detached' });
    await page.getByRole('status').filter({ hasText: '正在核对记忆处理模式' }).waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    reconnectedMode.resolve(status);
    await modesSettled(page, 2);
    assert.equal(await page.getByRole('alert').count(), 0, '旧面板释放不应使新连接的合法模式核验失败');
    await panel.getByRole('status').filter({ hasText: '等待处理' }).waitFor();
    assert.equal(await page.getByRole('region', { name: '旧版记忆正文' }).count(), 0);
  }, true);
});
