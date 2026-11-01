import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

async function mountSelection(t, sessionCount = 61, stateOverrides = {}) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const sessions = Array.from({ length: sessionCount }, (_, index) => ({
    locator: `wxid_synthetic_${String(index + 1).padStart(3, '0')}`,
    displayName: index === 0 ? '林晓雨' : index === 1 ? '王小明' : `合成联系人${String(index + 1).padStart(3, '0')}`,
    lastTimestamp: null,
    boundContactId: null,
    knownContactId: null,
  }));
  const bundle = await build({ stdin: { contents: `
    import React, {useState} from 'react';import {createRoot} from 'react-dom/client';import {BindingConsentPage} from './src/renderer/BindingConsentPage';
    const sessions=${JSON.stringify(sessions)};window.calls=[];window.routes=[];
    function App(){const [selection,setSelection]=useState({});const state={...${JSON.stringify(stateOverrides)},selectionOnly:true,revision:1,scopeRevision:1,phase:'ready',sessions,
      bindings:[],knownBindings:[],syncEnabled:false,sessionIssue:null,busy:null,errorCode:null,notice:null,...${JSON.stringify(stateOverrides)}};
      const consent={state,selection,setSelection,historyAuthorized:false,setHistoryAuthorized(){},refresh:async()=>{},
        confirm:async request=>window.calls.push({selection:{...selection},request})};
      return <BindingConsentPage contacts={{state:{contacts:[{contactId:'contact_existing',displayName:'已有联系人'}]}}} consent={consent}
        navigate={page=>window.routes.push(page)} onClose={()=>{}} startSync/>;}
    createRoot(document.getElementById('root')).render(<App/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false, loader: { '.css': 'empty' } });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  if (process.env.NOTALONE_CONTACT_SELECTION_SCREENSHOT) {
    for (const file of ['style.css', 'bindings.css']) {
      await page.addStyleTag({ content: await readFile(new URL(`../src/renderer/${file}`, import.meta.url), 'utf8') });
    }
  }
  return { page, sessions };
}

test('首次联系人选择支持跨搜索结果多选；过滤和查看已选都保留未显示的选择', async t => {
  const { page } = await mountSelection(t);
  await expect(page.getByRole('heading', { name: '选择要同步的联系人', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '选择会话 wxid_synthetic_001', exact: true })).not.toBeChecked();
  await page.getByRole('searchbox', { name: '搜索微信联系人', exact: true }).fill('林晓雨');
  await page.getByRole('checkbox', { name: '选择会话 wxid_synthetic_001', exact: true }).check();
  await page.getByRole('searchbox', { name: '搜索微信联系人', exact: true }).fill('王小明');
  await page.getByRole('checkbox', { name: '选择会话 wxid_synthetic_002', exact: true }).check();
  await expect(page.getByRole('button', { name: /查看已选（2）/ })).toBeVisible();
  await page.getByRole('button', { name: /查看已选（2）/ }).click();
  await expect(page.getByRole('checkbox', { name: '选择会话 wxid_synthetic_001', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '选择会话 wxid_synthetic_002', exact: true })).toBeChecked();
  await expect(page.getByText('已选中 2 位联系人 · 已选 2 位', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '开始同步这 2 位联系人', exact: true })).toBeEnabled();
  if (process.env.NOTALONE_CONTACT_SELECTION_SCREENSHOT) {
    await page.screenshot({ path: process.env.NOTALONE_CONTACT_SELECTION_SCREENSHOT, fullPage: true });
  }
  assert.deepEqual(await page.evaluate(() => window.calls), []);
  await page.getByRole('button', { name: '开始同步这 2 位联系人', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.calls), [{ selection: {
    wxid_synthetic_001: { displayName: '林晓雨', target: 'new' },
    wxid_synthetic_002: { displayName: '王小明', target: 'new' },
  }, request: { startSync: true } }]);
});

test('大名单分页显示有限条目，返回上一页仍保留已选状态', async t => {
  const { page, sessions } = await mountSelection(t, 126);
  await expect(page.getByRole('heading', { name: '选择要同步的联系人', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: `选择会话 ${sessions[0].locator}`, exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: `选择会话 ${sessions[50].locator}`, exact: true })).toHaveCount(0);
  await expect(page.getByText('找到 126 位联系人 · 已选 0 位', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.getByRole('checkbox', { name: `选择会话 ${sessions[50].locator}`, exact: true }).check();
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await page.getByRole('button', { name: /查看已选（1）/ }).click();
  await expect(page.getByRole('checkbox', { name: `选择会话 ${sessions[50].locator}`, exact: true })).toBeChecked();
  assert.deepEqual(await page.evaluate(() => window.calls), []);
});

test('联系人已加入但自动同步开启失败时，仍显示前往同步设置的恢复入口', async t => {
  const { page } = await mountSelection(t, 0, { phase: 'failed', notice: 'confirmed', errorCode: 'sync-start-failed' });
  await expect(page.getByRole('alert')).toContainText('联系人已添加，但同步开启尚未确认');
  const settings = page.getByRole('button', { name: '查看同步设置', exact: true });
  await expect(settings).toBeVisible();
  await settings.click();
  assert.deepEqual(await page.evaluate(() => window.routes), ['sync']);
});
