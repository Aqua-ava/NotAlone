import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';
import { replyInputFixture } from './fixtures/reply-input-stream.mjs';

async function mount(page, contents) {
  const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true,
    platform: 'browser', format: 'iife', write: false, loader: { '.css': 'empty' } });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
}

test('真实React输入后立即生成使用最新文字，切换与迟到事件不串联系人', async t => {
  const f = await replyInputFixture(100);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const deliveries = [];
  f.setForward((channel, state) => { deliveries.push(page.evaluate(({ channel, state }) => window.pageEvent?.(channel, state), { channel, state })); });
  f.contacts.onStateChanged(state => { deliveries.push(page.evaluate(state => window.pageEvent?.('contacts:state-changed', state), state)); });
  await page.exposeFunction('invoke', async (channel, ...args) => {
    if (channel === 'contacts:get-state') return f.contacts.getState();
    if (channel === 'contacts:set-draft') return f.contacts.setDraft(args[0]);
    if (channel === 'contacts:select') return f.contacts.selectContact(args[0]);
    return f.handlers.get(channel)(...args);
  });
  await mount(page, `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { createReplyBridge } from './src/preload/reply';
    import { createContactSessionBridge } from './src/preload/contact-session';
    import { useContactSession } from './src/renderer/contact-session';
    import { useReplySession, RewriteInput } from './src/renderer/RewritePanel';
    const listeners = new Map();
    window.pageEvent = (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(undefined, state); };
    const transport = { invoke: (...args) => window.invoke(...args), on: (channel, listener) => {
      const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set);
    }, removeListener: (channel, listener) => listeners.get(channel)?.delete(listener) };
    window.notalone = { replies: createReplyBridge(transport), contacts: createContactSessionBridge(transport) };
    function View() {
      const contacts = useContactSession(), replies = useReplySession();
      return <><RewriteInput contacts={contacts} replies={replies}/>
        <output aria-label="当前范围">{replies.state.contactId}</output>
        <button onClick={() => contacts.selectContact('${f.otherContactId}')}>选择合成乙</button>
        <button onClick={() => contacts.selectContact('${f.scope().contactId}')}>选择合成甲</button></>;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `);
  await expect(page.getByRole('textbox', { name: '草稿', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: '草稿', exact: true }).fill('合成刚输入的最新草稿。');
  await page.getByRole('textbox', { name: '本次要求', exact: true }).fill('只说明时间，不增加承诺。');
  await page.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect.poll(() => f.calls.filter(call => call.path.endsWith('/replies/prepare')).length).toBe(1);
  const submitted = f.calls.find(call => call.path.endsWith('/replies/prepare')).body;
  assert.equal(submitted.content.draft_text, '合成刚输入的最新草稿。');
  assert.match(submitted.content.user_instruction, /只说明时间，不增加承诺。/);
  const old = await f.bridge.getState();
  await page.getByRole('button', { name: '选择合成乙', exact: true }).click();
  await expect(page.getByLabel('当前范围')).toHaveText(f.otherContactId);
  await page.getByRole('textbox', { name: '本次要求', exact: true }).fill('乙的独立新要求。');
  await page.evaluate(old => window.pageEvent('reply:state-updated', { kind: 'snapshot', state: old }), old);
  await expect(page.getByLabel('当前范围')).toHaveText(f.otherContactId);
  await expect(page.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('乙的独立新要求。');
  await page.getByRole('button', { name: '选择合成甲', exact: true }).click();
  await expect(page.getByLabel('当前范围')).toHaveText(old.contactId);
  await f.bridge.readSavedSession(f.scope());
  await expect(page.getByRole('textbox', { name: '本次要求', exact: true })).toHaveValue('只说明时间，不增加承诺。');
  await expect(page.getByRole('textbox', { name: '草稿', exact: true })).toHaveValue('合成刚输入的最新草稿。');
  f.setForward(() => {}); await Promise.allSettled(deliveries);
});

test('真实Skill页面等慢4秒GET结算再调度，隐藏暂停，恢复立即读且失败写不重放', async t => {
  const result = await build({ entryPoints: ['src/main/skill-learning/controller.ts'], bundle: true,
    platform: 'node', format: 'esm', write: false });
  const { SkillLearningController } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  const contactId = randomUUID(), requests = [], commands = [], deliveries = [];
  const contactState = { selectedContactId: contactId, scopeRevision: 1, directoryPhase: 'ready', contacts: [{ contactId }] };
  const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {}, requestJson: async request => {
    requests.push(request);
    if (request.method === 'POST') throw Error('合成失败写操作。');
    if (requests.length === 1) await new Promise(resolve => setTimeout(resolve, 4000));
    return { generation: 1, data: { enabled: true, scope_revision: 1, drafts: [], task: null, recent_outcomes: [] } };
  } };
  const controller = new SkillLearningController(backend, { getState: () => contactState, onStateChanged: () => () => {} });
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.clock.install();
  controller.onStateChanged(state => { deliveries.push(page.evaluate(state => window.learningChanged?.(state), state)); });
  await page.exposeFunction('learning', async (method, selection) => { commands.push(method); return controller[method](selection); });
  await mount(page, `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { SkillLearningPage } from './src/renderer/SkillLearningPage';
    window.notalone = { skillLearning: { getState: () => window.learning('getState'),
      onStateChanged: listener => { window.learningChanged = listener; return () => { window.learningChanged = undefined; }; },
      refresh: scope => window.learning('refresh', scope), configure: scope => window.learning('configure', scope) } };
    createRoot(document.getElementById('root')).render(<SkillLearningPage session={{ state: ${JSON.stringify(contactState)} }}/>);
  `);
  await expect.poll(() => requests.length).toBe(1);
  await page.clock.runFor(10_000);
  assert.equal(commands.filter(command => command === 'refresh').length, 1, '页面等待GET结算期间不再次调用刷新');
  assert.equal(requests[0].signal.aborted, false);
  await expect(page.getByRole('button', { name: '关闭经验整理', exact: true })).toBeEnabled({ timeout: 7000 });
  await page.clock.runFor(14_000);
  assert.equal(requests.length, 1, '空闲时延长到15秒再读');
  await page.clock.runFor(1_000);
  await expect.poll(() => requests.length).toBe(2);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  const hidden = requests.length;
  await page.clock.runFor(60_000);
  assert.equal(requests.length, hidden);
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => requests.length).toBe(hidden + 1);
  await expect(page.getByRole('button', { name: '关闭经验整理', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '关闭经验整理', exact: true }).click();
  await expect.poll(() => requests.filter(request => request.method === 'POST').length).toBe(1);
  await page.clock.runFor(45_000);
  assert.equal(requests.filter(request => request.method === 'POST').length, 1);
  await Promise.allSettled(deliveries);
});
