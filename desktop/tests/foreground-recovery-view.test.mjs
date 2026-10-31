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
    let contacts = { revision: 1, scopeRevision: 1, directoryPhase: 'ready', contacts: [{ contactId: 'contact-a', displayName: '合成联系人', messageCount: 0, sourceCount: 0 }], selectedContactId: 'contact-a', draft: '' };
    let foreground = { ...initialForegroundState, revision: 1, foregroundRevision: 1, phase: 'manual-required', reason: 'unmatched_requires_selection', recognizedName: '合成联系人', recognitionConfidence: .98, observedAt: new Date().toISOString(), wechatInFront: true };
    const contactListeners = new Set(), foregroundListeners = new Set();
    window.publishForeground = update => { foreground = { ...foreground, ...update, revision: foreground.revision + 1, foregroundRevision: foreground.foregroundRevision + 1 }; for (const fn of foregroundListeners) fn(foreground); };
    window.publishScope = (selectedContactId = contacts.selectedContactId) => { contacts = { ...contacts, selectedContactId, revision: contacts.revision + 1, scopeRevision: contacts.scopeRevision + 1 }; for (const fn of contactListeners) fn(contacts); };
    window.manualSelections = [];
    window.errorCode = 'foreground_confirmation_stale'; window.deferConfirmation = false;
    window.notalone = {
      contacts: { getState: async () => contacts, onStateChanged: fn => { contactListeners.add(fn); return () => contactListeners.delete(fn); },
        confirmManualContact: async selection => { window.manualSelections.push(selection); window.publishScope(selection.contactId); window.publishForeground({ manualInput: true, confirmation: 'manual-confirmed', generationBlock: null }); return contacts; } },
      foreground: { getState: async () => foreground, onStateChanged: fn => { foregroundListeners.add(fn); return () => foregroundListeners.delete(fn); },
        confirm: async () => { if (window.deferConfirmation) await new Promise(resolve => window.finishConfirmation = resolve); throw new Error(window.errorCode); } },
    };
    function App() { const session = useContactSession(); const { state } = useForegroundState(window.notalone.foreground, true); return <><HelperContactPicker session={session} foreground={state} /><ForegroundPanel state={state} session={session} /><button onClick={() => session.confirmContact(contacts.selectedContactId, state.foregroundRevision)}>测试旧观察确认</button><output aria-label="确认错误">{session.error}</output></>; }
    createRoot(document.getElementById('root')).render(<App />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await expect(page.getByRole('button', { name: '确认本次联系人', exact: true })).toBeVisible();
  return page;
}

test('新观察清除旧确认错误，不要求重开小窗', async t => {
  const page = await fixture(t);
  await page.getByRole('button', { name: '测试旧观察确认', exact: true }).click();
  await expect(page.getByLabel('确认错误')).toContainText('已过期');
  const staleMessage = await page.getByLabel('确认错误').textContent();
  await page.evaluate(() => window.publishForeground({ phase: 'confirmed', reason: 'confirmed_active_binding', confirmation: 'verified-binding', generationBlock: null, confirmedContactId: 'contact-a' }));
  await expect(page.getByLabel('确认错误')).toBeEmpty();
  await expect(page.getByRole('status').first()).toContainText('已识别');
  assert.doesNotMatch(staleMessage, /重新打开小窗/);
});

test('旧确认的迟到失败不覆盖更新的观察或联系人范围', async t => {
  const page = await fixture(t);
  await page.evaluate(() => { window.deferConfirmation = true; });
  await page.getByRole('button', { name: '测试旧观察确认', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.finishConfirmation)).toBe('function');
  await page.evaluate(() => { window.publishForeground({ phase: 'confirmed', reason: 'confirmed_active_binding', generationBlock: null }); window.finishConfirmation(); });
  await expect(page.getByLabel('确认错误')).toBeEmpty();
  await page.evaluate(() => window.publishForeground({ phase: 'manual-required', reason: 'unmatched_requires_selection', generationBlock: 'foreground-confirmation-required' }));
  await page.getByRole('button', { name: '测试旧观察确认', exact: true }).click();
  await page.evaluate(() => { window.publishScope(); window.finishConfirmation(); });
  await expect(page.getByLabel('确认错误')).toBeEmpty();
});

test('历史群聊锁保留但不遮盖当前名称质量失败', async t => {
  const page = await fixture(t);
  await page.evaluate(() => window.publishForeground({ phase: 'manual-required', reason: 'quality_unverified', unsupportedConversation: true, recognizedName: null }));
  await expect(page.getByRole('status').first()).toContainText('名称识别质量未通过');
  await expect(page.getByRole('status').first()).not.toContainText('正在重新识别');
  await expect(page.getByRole('button', { name: '确认本次联系人', exact: true })).toHaveCount(0);
});

test('未取得确认凭据说明当前证据不足，不误报已过期', async t => {
  const page = await fixture(t);
  await page.evaluate(() => { window.errorCode = 'foreground_confirmation_unavailable'; });
  await page.getByRole('button', { name: '测试旧观察确认', exact: true }).click();
  await expect(page.getByLabel('确认错误')).toContainText('尚未取得可确认的微信会话');
  assert.doesNotMatch(await page.getByLabel('确认错误').textContent(), /已过期|重新打开小窗/);
});

test('匹配不唯一时可直接手选已有联系人，不依赖旧读取授权或桌面回执', async t => {
  const page = await fixture(t);
  await page.evaluate(() => { window.publishScope(null); window.publishForeground({ reason: 'ambiguous_requires_selection' }); });
  await expect(page.getByRole('status').first()).toContainText('选择');
  await page.getByRole('combobox', { name: '本次联系人' }).click();
  await page.getByRole('option', { name: '合成联系人', exact: true }).click();
  await expect(page.getByRole('status').first()).toContainText('本次联系人已由你确认');
  assert.deepEqual(await page.evaluate(() => window.manualSelections), [{ contactId: 'contact-a', scopeRevision: 2 }]);
  await expect(page.getByLabel('确认错误')).toBeEmpty();
});
