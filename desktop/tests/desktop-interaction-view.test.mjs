import { selectContact } from './contact-picker-actions.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

async function mount(page, contents) {
  const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true,
    platform: 'browser', format: 'iife', write: false, loader: { '.css': 'empty' } });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
}

test('联系人鼠标聚焦保留原生默认行为，重新展开后仍能键入和退格', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await mount(page, `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { ContactPicker } from './src/renderer/ContactPicker';
    const session = { state: { directoryPhase: 'ready', selectedContactId: 'synthetic-a', scopeRevision: 1,
      contacts: [{ contactId: 'synthetic-a', displayName: 'Synthetic Alpha' },
        { contactId: 'synthetic-b', displayName: 'Synthetic Beta' }] }, selectContact: async () => {} };
    createRoot(document.getElementById('root')).render(<><ContactPicker session={session}/><button>外部按钮</button></>);
    // DOM focus 不能证明原生窗口已接收键盘；同时锁定鼠标默认聚焦路径未被取消。
    document.addEventListener('pointerdown', event => {
      if (event.target.matches('input')) window.pointerDefaultPrevented = event.defaultPrevented;
    });
  `);
  const picker = page.getByRole('combobox', { name: '本次联系人', exact: true });
  for (const closeWith of ['Escape', 'outside']) {
    await picker.click();
    assert.equal(await page.evaluate(() => window.pointerDefaultPrevented), false, '输入框不能取消原生鼠标聚焦');
    await expect(picker).toBeFocused();
    await page.keyboard.press('Backspace');
    await expect(picker).toHaveValue('');
    await page.keyboard.type('Beta');
    await expect(picker).toHaveValue('Beta');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Backspace');
    await expect(picker).toHaveValue('Bet');
    await expect(picker).toHaveAttribute('data-contact-id', 'synthetic-a');
    if (closeWith === 'Escape') await page.keyboard.press('Escape');
    else await page.getByRole('button', { name: '外部按钮', exact: true }).click();
    await expect(picker).toHaveValue('Synthetic Alpha');
    await expect(picker).toHaveAttribute('aria-expanded', 'false');
  }
  await picker.click();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Backspace');
  await expect(picker).toHaveValue('Synthetic Alph');
});

test('顶部联系人原位输入并全选当前名称，搜索只筛选且确认才切换', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await mount(page, `
    import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
    import { ContactPicker } from './src/renderer/contact-session';
    function View() {
      const [selectedContactId, selectContact] = useState('synthetic-a');
      const session = { state: { directoryPhase: 'ready', selectedContactId,
        contacts: [{contactId: 'synthetic-a', displayName: '合成甲'}, {contactId: 'synthetic-b', displayName: '合成乙'}] },
        selectContact: async id => selectContact(id) };
      return <><ContactPicker session={session}/><output aria-label="已选择联系人">{selectedContactId}</output></>;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `);
  const search = page.getByRole('combobox', { name: '本次联系人', exact: true });
  await expect(search).toHaveValue('合成甲');
  await search.click();
  await expect(search).toBeFocused();
  assert.equal(await search.evaluate(input => input.value.slice(input.selectionStart, input.selectionEnd)), '合成甲');
  await expect(page.getByRole('searchbox')).toHaveCount(0);
  await expect(page.getByRole('option')).toHaveCount(2);
  await page.keyboard.insertText('乙');
  await expect(search).toHaveValue('乙');
  await expect(page.getByLabel('已选择联系人')).toHaveText('synthetic-a');
  await expect(page.getByRole('option')).toHaveCount(1);
  await search.press('Enter');
  await expect(page.getByLabel('已选择联系人')).toHaveText('synthetic-b');
  await expect(search).toHaveValue('合成乙');
  await expect(search).toHaveAttribute('aria-expanded', 'false');
  await search.click();
  await search.fill('不存在的合成联系人');
  await expect(page.getByText('未找到联系人', { exact: true })).toBeVisible();
  await search.press('Enter');
  await expect(page.getByLabel('已选择联系人')).toHaveText('synthetic-b');
  await expect(page.getByRole('option')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '创建联系人', exact: true })).toHaveCount(0);
  await search.press('Escape');
  await expect(search).toHaveValue('合成乙');
});

test('顶部联系人搜索支持中文组合输入、键盘导航、关闭和同名独立选择', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await mount(page, `
    import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
    import { ContactPicker } from './src/renderer/contact-session';
    function View() {
      const [selectedContactId, selectContact] = useState('synthetic-a');
      const session = { state: { directoryPhase: 'ready', selectedContactId,
        contacts: [{ contactId: 'synthetic-a', displayName: 'Alice 合成甲', messageCount: 1 },
          { contactId: 'synthetic-b', displayName: '合成同名', messageCount: 2 },
          { contactId: 'synthetic-c', displayName: '合成同名', messageCount: 3 }] },
        selectContact: async id => selectContact(id) };
      return <><ContactPicker session={session}/><button>外部按钮</button></>;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `);
  const picker = page.getByRole('combobox', { name: '本次联系人', exact: true });
  const search = picker;
  const options = page.getByRole('listbox', { name: '联系人搜索结果', exact: true }).getByRole('option');
  await picker.click();
  await search.fill('  ALICE  ');
  await expect(options).toHaveCount(1);
  await expect(options.first()).toContainText('Alice 合成甲');
  await search.fill('合成');
  await search.press('ArrowDown');
  await search.dispatchEvent('compositionstart');
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(picker).toHaveAttribute('data-contact-id', 'synthetic-a');
  await expect(search).toBeVisible();
  await search.dispatchEvent('compositionend');
  await search.fill('同名');
  await expect(options).toHaveCount(2);
  await search.press('ArrowDown');
  await expect(picker).toHaveAttribute('data-contact-id', 'synthetic-a');
  await search.press('Enter');
  await expect(picker).toHaveAttribute('data-contact-id', 'synthetic-c');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(picker).toBeFocused();
  await selectContact(picker, 'synthetic-b');
  await expect(picker).toHaveAttribute('data-contact-id', 'synthetic-b');
  await picker.press('ArrowUp');
  await expect(search).toBeFocused();
  await search.fill('同名');
  await search.press('Escape');
  await expect(search).toHaveValue('合成同名');
  await expect(picker).toBeFocused();
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(picker).toHaveAttribute('data-contact-id', 'synthetic-b');
  await picker.click();
  await expect(search).toHaveValue('合成同名');
  await expect(options).toHaveCount(3);
  await search.fill('未提交搜索');
  await page.getByRole('button', { name: '外部按钮', exact: true }).click();
  await expect(search).toHaveValue('合成同名');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await picker.click();
  await search.press('Tab');
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: '外部按钮', exact: true })).toBeFocused();
});

test('顶部联系人目录失效或切换范围时关闭搜索，空目录禁止展开', async t => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await mount(page, `
    import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
    import { ContactPicker } from './src/renderer/contact-session';
    function View() {
      const [state, setState] = useState({ scopeRevision: 1, directoryPhase: 'ready', selectedContactId: 'synthetic-a',
        contacts: [{ contactId: 'synthetic-a', displayName: '合成甲' }, { contactId: 'synthetic-b', displayName: '合成乙' }] });
      window.fixtureUpdate = update => setState(previous => ({ ...previous, ...update }));
      return <ContactPicker session={{ state, selectContact: async () => {} }}/>;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `);
  const picker = page.getByRole('combobox', { name: '本次联系人', exact: true });
  const search = picker;
  await picker.click();
  await search.fill('甲');
  await page.evaluate(() => window.fixtureUpdate({ scopeRevision: 2, selectedContactId: 'synthetic-b' }));
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(picker).toHaveAttribute('data-contact-id', 'synthetic-b');
  await picker.click();
  await page.evaluate(() => window.fixtureUpdate({ directoryPhase: 'unavailable' }));
  await expect(picker).toHaveAttribute('aria-expanded', 'false');
  await expect(picker).toBeDisabled();
  await page.evaluate(() => window.fixtureUpdate({ directoryPhase: 'ready', selectedContactId: null, contacts: [] }));
  await expect(picker).toBeDisabled();
  await expect(picker).toHaveAttribute('data-contact-id', '');
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
