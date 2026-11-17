import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

async function fixture(t) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const bundle = await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { ForegroundPanel, useForegroundState } from './src/renderer/ForegroundPanel';
    import { useContactSession, HelperContactPicker } from './src/renderer/contact-session';
    import { initialForegroundState } from './src/shared/foreground-bridge';
    let contacts = { revision: 1, scopeRevision: 1, directoryPhase: 'ready', contacts: [{ contactId: 'contact-a', displayName: '合成联系人', messageCount: 0, sourceCount: 0 }, { contactId: 'contact-b', displayName: '另一位合成联系人', messageCount: 0, sourceCount: 0 }], selectedContactId: 'contact-a', draft: '' };
    let foreground = { ...initialForegroundState, revision: 1, foregroundRevision: 1, phase: 'manual-required', reason: 'unmatched_requires_selection', recognizedName: '合成联系人', recognitionConfidence: .98, observedAt: new Date().toISOString(), wechatInFront: true };
    const contactListeners = new Set(), foregroundListeners = new Set();
    window.publishForeground = update => { foreground = { ...foreground, ...update, revision: foreground.revision + 1, foregroundRevision: foreground.foregroundRevision + 1 }; for (const fn of foregroundListeners) fn(foreground); };
    window.publishScope = (selectedContactId = contacts.selectedContactId) => { contacts = { ...contacts, selectedContactId, revision: contacts.revision + 1, scopeRevision: contacts.scopeRevision + 1 }; for (const fn of contactListeners) fn(contacts); };
    window.manualSelections = [];
    window.notalone = {
      contacts: { getState: async () => contacts, onStateChanged: fn => { contactListeners.add(fn); return () => contactListeners.delete(fn); },
        confirmManualContact: async selection => { window.manualSelections.push(selection); window.publishScope(selection.contactId); window.publishForeground({ phase: 'idle', reason: 'contact_selected', confirmation: 'manual-confirmed', confirmedContactId: selection.contactId, generationBlock: null }); return contacts; } },
      foreground: { getState: async () => foreground, onStateChanged: fn => { foregroundListeners.add(fn); return () => foregroundListeners.delete(fn); } },
    };
    function App() { const session = useContactSession(); const { state } = useForegroundState(window.notalone.foreground, true); return <><HelperContactPicker session={session} foreground={state} /><ForegroundPanel state={state} session={session} /><output aria-label="确认错误">{session.error}</output></>; }
    createRoot(document.getElementById('root')).render(<App />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await expect(page.getByRole('button', { name: '确认本次联系人', exact: true })).toBeVisible();
  return page;
}

test('历史群聊锁保留但不遮盖当前名称质量失败', async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.publishForeground({ phase: 'manual-required', reason: 'quality_unverified', unsupportedConversation: true, recognizedName: null }));
  await expect(page.getByRole('status').first()).toContainText('名称识别质量未通过');
  await expect(page.getByRole('status').first()).not.toContainText('正在重新识别');
  await expect(page.getByRole('button', { name: '确认本次联系人', exact: true })).toHaveCount(0);
});

test('匹配不唯一时直接选择本次联系人，保留自动跟随且无需切换模式', async t => {
  const page = await fixture(t);
  await page.evaluate(() => { window.publishScope(null); window.publishForeground({ reason: 'ambiguous_requires_selection' }); });
  await expect(page.getByRole('status').first()).toContainText('选择');
  await page.getByRole('combobox', { name: '本次联系人' }).click();
  await page.getByRole('option', { name: '合成联系人', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('本次联系人已由你选择；切回微信后自动识别当前会话');
  await expect(page.getByRole('status').first()).not.toContainText('已识别');
  await expect(page.getByRole('button', { name: '恢复微信会话识别', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '切换为手动输入', exact: true })).toHaveCount(0);
  await expect(page.getByText('手动输入模式', { exact: false })).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.manualSelections), [{ contactId: 'contact-a', scopeRevision: 2 }]);
  await expect(page.getByLabel('确认错误')).toBeEmpty();
  await page.evaluate(() => window.publishForeground({ phase: 'unavailable', reason: 'probe_timeout', recognizedName: null,
    confirmation: 'required', confirmedContactId: null, generationBlock: 'foreground-confirmation-required' }));
  await expect(page.getByText('正式探针执行超时，等待自动重试；也可在上方选择本次联系人')).toBeVisible();
  await expect(page.getByRole('combobox', { name: '本次联系人' })).toHaveValue('合成联系人');
  await expect(page.getByText('当前联系人未确认；以下保留内容属于合成联系人，请明确选择后再生成。')).toBeVisible();
  await expect(page.getByText('本次联系人已由你选择', { exact: false })).toHaveCount(0);
  await page.evaluate(() => {
    window.publishScope('contact-b');
    window.publishForeground({ phase: 'confirmed', reason: 'confirmed_active_binding_name_match', confirmation: 'verified-binding', generationBlock: null,
      confirmedContactId: 'contact-b', recognizedName: '另一位合成联系人', recognitionConfidence: .30, observedAt: new Date().toISOString() });
  });
  await expect(page.getByRole('combobox', { name: '本次联系人' })).toHaveValue('另一位合成联系人');
  await expect(page.getByRole('status').first()).toContainText('已识别');
  await expect(page.getByText('已按会话名称匹配到配置账号的已有联系人。')).toBeVisible();
  await expect(page.getByText('本次联系人已由你选择', { exact: false })).toHaveCount(0);
  assert.equal(await page.evaluate(() => window.manualSelections.length), 1, '新的可靠观察不需要再次手选或点击恢复');
});
