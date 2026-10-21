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

test('真实React双窗口共用联系人，顶部与小窗双向切换且草稿和迟到事件不串范围', async t => {
  const f = await replyInputFixture(100);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const manager = await browser.newPage(), helper = await browser.newPage();
  const pages = [manager, helper], deliveries = [];
  const publish = (channel, state) => {
    for (const page of pages) deliveries.push(page.evaluate(({ channel, state }) => window.pageEvent?.(channel, state), { channel, state }));
  };
  f.setForward(publish);
  const unsubscribe = f.contacts.onStateChanged((state, kind) => publish('contacts:state-changed', kind === 'draft' ? f.contactDraftUpdate(state) : state));
  t.after(async () => { f.setForward(() => {}); unsubscribe(); await Promise.allSettled(deliveries); });
  for (const page of pages) {
    await page.exposeFunction('invoke', async (channel, ...args) => {
      if (channel === 'contacts:get-state') return f.contacts.getState();
      if (channel === 'contacts:set-draft') return f.contacts.setDraft(args[0]);
      if (channel === 'contacts:select' || channel === 'contacts:confirm-manual') return f.contacts.selectContact(args[0]);
      return f.handlers.get(channel)(...args);
    });
    await mount(page, `
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import { createReplyBridge } from './src/preload/reply';
      import { createContactSessionBridge } from './src/preload/contact-session';
      import { useContactSession, ContactPicker, HelperContactPicker } from './src/renderer/contact-session';
      import { useReplySession, RewriteInput } from './src/renderer/RewritePanel';
      const listeners = new Map();
      window.pageEvent = (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(undefined, state); };
      const transport = { invoke: (...args) => window.invoke(...args), on: (channel, listener) => {
        const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set);
      }, removeListener: (channel, listener) => listeners.get(channel)?.delete(listener) };
      window.notalone = { replies: createReplyBridge(transport), contacts: createContactSessionBridge(transport) };
      function View() {
        const contacts = useContactSession(), replies = useReplySession();
        return <><header>${page === helper ? '<HelperContactPicker session={contacts} foreground={{ manualInput: true }} manualInput/>' : '<ContactPicker session={contacts} onSelect={contacts.confirmManualContact}/>'}</header>
          ${page === helper ? '<RewriteInput contacts={contacts} replies={replies}/>' : ''}
          <output aria-label="当前范围">{replies.state.contactId}</output></>;
      }
      createRoot(document.getElementById('root')).render(<View/>);
    `);
  }
  const current = page => page.getByRole('combobox', { name: '本次联系人', exact: true });
  const draft = helper.getByRole('textbox', { name: '草稿', exact: true });
  const instruction = helper.getByRole('textbox', { name: '本次要求', exact: true });
  const firstContactId = f.scope().contactId;
  await expect(current(manager)).toHaveCount(1);
  await expect(current(helper)).toHaveValue(firstContactId);
  await expect(draft).toBeEnabled();
  await draft.fill('合成刚输入的最新草稿。');
  await instruction.fill('只说明时间，不增加承诺。');
  await helper.getByRole('button', { name: '生成候选', exact: true }).click();
  await expect.poll(() => f.calls.filter(call => call.path.endsWith('/replies/prepare')).length).toBe(1);
  const submitted = f.calls.find(call => call.path.endsWith('/replies/prepare')).body;
  assert.equal(submitted.content.draft_text, '合成刚输入的最新草稿。');
  assert.match(submitted.content.user_instruction, /只说明时间，不增加承诺。/);
  const oldReply = await f.bridge.getState(), oldContact = f.contacts.getState();
  await current(manager).selectOption(f.otherContactId);
  for (const page of pages) {
    await expect(current(page)).toHaveValue(f.otherContactId);
    await expect(page.getByLabel('当前范围')).toHaveText(f.otherContactId);
  }
  await expect(draft).toHaveValue('');
  await expect(instruction).toHaveValue('');
  await draft.fill('乙的独立草稿。');
  await instruction.fill('乙的独立新要求。');
  for (const page of pages) await page.evaluate(({ oldReply, oldContact }) => {
    window.pageEvent('reply:state-updated', { kind: 'snapshot', state: oldReply });
    window.pageEvent('contacts:state-changed', oldContact);
  }, { oldReply, oldContact });
  for (const page of pages) {
    await expect(current(page)).toHaveValue(f.otherContactId);
    await expect(page.getByLabel('当前范围')).toHaveText(f.otherContactId);
  }
  await expect(draft).toHaveValue('乙的独立草稿。');
  await expect(instruction).toHaveValue('乙的独立新要求。');
  await current(helper).selectOption(firstContactId);
  for (const page of pages) await expect(current(page)).toHaveValue(firstContactId);
  await f.bridge.readSavedSession(f.scope());
  await expect(instruction).toHaveValue('只说明时间，不增加承诺。');
  await expect(draft).toHaveValue('合成刚输入的最新草稿。');
});

test('真实导入页面跟随顶部联系人，已确认预览和迟到预览在切换后失效', async t => {
  const bundle = await build({ stdin: { contents: `
    export { ContactSession } from './src/main/contacts/session';
    export { ImportController } from './src/main/imports/controller';
  `, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
  const { ContactSession, ImportController } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const contactIds = [randomUUID(), randomUUID()], calls = [], deliveries = [];
  let releasePreview;
  const contacts = new ContactSession(async () => ({ generation: 1, contacts: contactIds.map((contactId, index) => ({
    contactId, displayName: `合成联系人${index ? '乙' : '甲'}`, messageCount: 0, sourceCount: 0 })) }));
  contacts.setConnection(1); await contacts.refreshContacts();
  const backend = { getConnectionGeneration: () => 1, onStateChanged: () => () => {}, requestJson: async request => {
    calls.push(request);
    assert.equal(request.path, '/api/imports/preview', '切换操作不能提交导入');
    if (calls.length === 3) await new Promise(resolve => { releasePreview = resolve; });
    return { generation: 1, data: { valid: true, file_name: 'synthetic.jsonl', content_sha256: 'a'.repeat(64),
      record_count: 1, kind_counts: { text: 1 }, owner_channel_identity: { external_id: 'synthetic_owner', observed_name: '合成本人' },
      contact_channel_identity: { external_id: 'synthetic_contact', observed_name: '合成对方' } } };
  } };
  const imports = new ImportController(backend, contacts);
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const publish = (channel, state) => deliveries.push(page.evaluate(({ channel, state }) => window.pageEvent?.(channel, state), { channel, state }));
  const stopContacts = contacts.onStateChanged(state => publish('contacts', state));
  const stopImports = imports.onStateChanged(state => publish('imports', state));
  t.after(async () => { stopContacts(); stopImports(); releasePreview?.(); await Promise.allSettled(deliveries); });
  await page.exposeFunction('contactCommand', (method, argument) => contacts[method](argument));
  await page.exposeFunction('importCommand', (method, argument) => method === 'chooseFile'
    ? imports.chooseFile(async () => ({ canceled: false, filePaths: ['/tmp/synthetic.jsonl'] }))
    : imports[method](argument?.selectionRevision ?? argument));
  await mount(page, `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { useContactSession, ContactPicker } from './src/renderer/contact-session';
    import { ImportPage } from './src/renderer/ImportPage';
    const listeners = new Map();
    const subscribe = (channel, listener) => { const set = listeners.get(channel) ?? new Set(); set.add(listener); listeners.set(channel, set); return () => set.delete(listener); };
    window.pageEvent = (channel, state) => { for (const listener of listeners.get(channel) ?? []) listener(state); };
    window.notalone = {
      contacts: { getState: () => window.contactCommand('getState'), selectContact: value => window.contactCommand('selectContact', value),
        onStateChanged: listener => subscribe('contacts', listener) },
      imports: Object.fromEntries(['getState', 'chooseFile', 'setTarget', 'preview', 'confirmPreview', 'submit', 'cancelConfirmation'].map(method =>
        [method, argument => window.importCommand(method, argument)])),
      sources: { getState: async () => ({ revision: 0, contactId: null, scopeRevision: 0, phase: 'idle', sources: [] }),
        onStateChanged: () => () => {}, refresh: async () => {} }
    };
    window.notalone.imports.onStateChanged = listener => subscribe('imports', listener);
    function View() { const session = useContactSession(); return <><header><ContactPicker session={session}/></header><ImportPage session={session}/></>; }
    createRoot(document.getElementById('root')).render(<View/>);
  `);
  const picker = page.getByRole('combobox', { name: '本次联系人', exact: true });
  const choose = page.getByRole('button', { name: '选择历史文件', exact: true });
  const preview = page.getByRole('button', { name: '预览资料范围', exact: true });
  const summary = page.getByRole('region', { name: '单联系人资料预览', exact: true });
  await expect(page.getByRole('combobox')).toHaveCount(1);
  await expect(choose).toBeDisabled();
  await picker.selectOption(contactIds[0]);
  await expect.poll(() => imports.getState().target).toEqual({ kind: 'existing', contactId: contactIds[0] });
  await choose.click(); await preview.click();
  await expect(summary).toContainText('合成联系人甲');
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '确认本次预览', exact: true }).click();
  await expect(page.getByRole('button', { name: '正式导入这份资料', exact: true })).toBeVisible();
  const confirmedRevision = imports.getState().selectionRevision;
  await picker.selectOption(contactIds[1]);
  await expect.poll(() => imports.getState().target).toEqual({ kind: 'existing', contactId: contactIds[1] });
  await expect(summary).toHaveCount(0);
  await expect(page.getByRole('button', { name: '正式导入这份资料', exact: true })).toHaveCount(0);
  await expect(preview).toBeDisabled();
  assert.throws(() => imports.takeConfirmedSelection(confirmedRevision));
  await choose.click(); await preview.click();
  await expect.poll(() => typeof releasePreview).toBe('function');
  await picker.selectOption(contactIds[0]);
  await expect.poll(() => imports.getState().target).toEqual({ kind: 'existing', contactId: contactIds[0] });
  releasePreview();
  await expect.poll(() => imports.getState().phase).toBe('idle');
  await expect(summary).toHaveCount(0);
  await expect(preview).toBeDisabled();
  assert.deepEqual(calls.map(call => call.body.contact_id), [contactIds[0], contactIds[0], contactIds[1]]);
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
      poll: scope => window.learning('poll', scope), refresh: scope => window.learning('refresh', scope), configure: scope => window.learning('configure', scope) } };
    createRoot(document.getElementById('root')).render(<SkillLearningPage session={{ state: ${JSON.stringify(contactState)} }}/>);
  `);
  await page.getByRole('tab', { name: '待审核' }).click();
  await expect.poll(() => requests.length).toBe(1);
  await page.clock.runFor(10_000);
  assert.equal(commands.filter(command => command === 'poll').length, 1, '页面等待GET结算期间不再次调用刷新');
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
