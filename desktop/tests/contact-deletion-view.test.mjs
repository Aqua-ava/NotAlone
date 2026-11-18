import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { expect } from '@playwright/test';
import { launchChromium } from './helpers/browser.mjs';

async function mount(t, options = {}) {
  const browser = await launchChromium();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: options.viewport ?? { width: 1100, height: 800 } });
  const bundle = await build({ stdin: { contents: `
    import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ContactsPage} from './src/renderer/ContactsPage';
    const initialContacts=[
      {contactId:'contact-001',displayName:'王小明',messageCount:4,sourceCount:1},
      {contactId:'contact-002',displayName:'王小明',messageCount:3,sourceCount:1},
      {contactId:'contact-003',displayName:'林晓雨',messageCount:0,sourceCount:0}
    ];
    let deletionState=${JSON.stringify(options.deletionState ?? {
      revision:1,scopeRevision:7,phase:'ready',operations:[],busyId:null,error:null,
    })};
    const deletionListeners=new Set();window.calls=[];window.navigation=[];
    window.publishDeletion=patch=>{deletionState={...deletionState,...patch,revision:deletionState.revision+1};deletionListeners.forEach(listener=>listener(deletionState));};
    const noOp=async()=>{};
    window.notalone={
      contactDeletion:{getState:async()=>deletionState,refresh:noOp,delete:async request=>window.calls.push(request),retry:async request=>window.calls.push(request),
        onStateChanged:listener=>{deletionListeners.add(listener);return()=>deletionListeners.delete(listener);}},
      contactHistory:{getState:async()=>({revision:1,contactId:'contact-001',scopeRevision:7,messages:{phase:'ready',items:[],nextCursor:null},error:null}),onStateChanged:()=>()=>{},load:noOp},
      bindings:{getState:async()=>({revision:1,scopeRevision:7,phase:'ready',selectionOnly:true,knownBindings:[],bindings:[],sessions:[],busy:null}),onStateChanged:()=>()=>{},refreshSaved:noOp},
      syncControl:{getState:async()=>({revision:1,scopeRevision:7,phase:'ready',errorCode:null,report:{enabled:false,bodyAvailable:true,historyCoverages:[]}}),onStateChanged:()=>()=>{},refresh:noOp},
      historyClear:{getState:async()=>({revision:1,scopeRevision:7,contactId:'contact-001',phase:'ready',clear:null,resync:null,busy:null,error:null}),onStateChanged:()=>()=>{},clear:noOp,resync:noOp},
      media:{openHistoryImagePreview:noOp,releasePreview:noOp,onPreviewRevoking:()=>()=>{}},
      openHelper:noOp,
    };
    function App(){const [selected,setSelected]=useState(${JSON.stringify(options.selectedContactId ?? 'contact-001')});const [scope,setScope]=useState(7);const [contacts,setContacts]=useState(initialContacts);
      window.selectContact=(contactId)=>{setSelected(contactId);setScope(value=>value+1);};
      window.removeContactFromDirectory=(contactId)=>setContacts(current=>current.filter(contact=>contact.contactId!==contactId));
      const session={state:{revision:scope,scopeRevision:scope,directoryPhase:'ready',contacts,selectedContactId:selected,draft:''},refreshContacts:noOp,selectContact:async contactId=>{window.selectContact(contactId);window.selectedByList=(window.selectedByList??[]).concat(contactId);}};
      return <ContactsPage session={session} navigate={page=>window.navigation.push(page)}/>;}
    createRoot(document.getElementById('root')).render(<App/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false,
  loader: { '.css': 'css' }, jsx: 'automatic', outdir: 'contact-deletion-view-test' });
  await page.setContent(`<style>*{box-sizing:border-box}body{margin:0;padding:24px;font-family:sans-serif}:root{--panel-border:#c4d3d6;--panel-radius:12px;--panel-background:#fffdf5;--panel-heading:#354d59}</style><div id="root"></div>`);
  await page.addStyleTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.css')).text });
  await page.addScriptTag({ content: bundle.outputFiles.find(file => file.path.endsWith('.js')).text });
  return page;
}

test('删除菜单须经二次确认；同名联系人显示内部标识且仅最终确认提交', async t => {
  const page = await mount(t);
  await expect(page.getByRole('region', { name: '联系人删除任务' })).toHaveCount(0);
  const details = page.getByRole('region', { name: '联系人聊天记录' });
  await page.getByRole('button', { name: '删除联系人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认删除联系人', exact: true });
  await expect(dialog.locator('h3')).toHaveText('删除「王小明」？');
  await expect(dialog.locator('p').first()).toHaveText('将停止同步并删除此人在 NotAlone 的全部资料。无法撤销，微信好友/原聊天不变。');
  await expect(dialog.getByText('模型服务商的数据保留及删除方式以其政策为准，本机删除不会清除外部副本。', { exact: true })).toBeVisible();
  await expect(dialog).toContainText('contact-001');
  await expect(details.getByRole('heading', { name: '王小明', exact: true })).toBeVisible();
  assert.deepEqual(await page.evaluate(() => window.calls), []);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: '删除联系人', exact: true }).click();
  await page.getByRole('dialog', { name: '确认删除联系人', exact: true }).getByRole('button', { name: '删除联系人', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.calls), [{ contactId: 'contact-001', scopeRevision: 7, confirmed: true }]);
});

test('已有当前联系人位于列表末尾时，首次展示仍保持目录顺序', async t => {
  const page = await mount(t, { selectedContactId: 'contact-003' });
  const list = page.getByRole('list', { name: '联系人列表' });
  await expect(list.locator('.contact-row-name b')).toHaveText(['王小明', '王小明', '林晓雨']);
  await expect(list.getByRole('button', { name: '选择林晓雨', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('点击联系人只切换聊天内容且保持列表顺序，再点当前项不重复提交', async t => {
  const page = await mount(t);
  const list = page.getByRole('list', { name: '联系人列表' });
  const originalOrder = ['王小明', '王小明', '林晓雨'];
  await expect(list.locator('.contact-row-name b')).toHaveText(originalOrder);
  await expect(list.getByRole('button', { name: '选择林晓雨', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await list.getByRole('button', { name: '选择林晓雨', exact: true }).click();
  await expect(page.getByRole('region', { name: '联系人聊天记录' }).getByRole('heading', { name: '林晓雨' })).toBeVisible();
  await expect(list.getByRole('button', { name: '选择林晓雨', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(list.locator('.contact-row-name b')).toHaveText(originalOrder);
  await list.getByRole('button', { name: '选择林晓雨', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.selectedByList), ['contact-003']);
  await page.evaluate(() => window.selectContact('contact-002'));
  await expect(list.getByRole('button', { name: '选择王小明', exact: true }).nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(list.locator('.contact-row-name b')).toHaveText(originalOrder);
});

test('切换联系人会关闭旧确认框，之后的确认只针对当前选择', async t => {
  const page = await mount(t);
  await page.getByRole('button', { name: '删除联系人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认删除联系人', exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.selectContact('contact-002'));
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.calls), []);
  await page.getByRole('button', { name: '删除联系人', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '确认删除联系人', exact: true })).toContainText('联系人标识：contact-002');
  await page.getByRole('dialog', { name: '确认删除联系人', exact: true }).getByRole('button', { name: '删除联系人', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.calls), [{ contactId: 'contact-002', scopeRevision: 8, confirmed: true }]);
});

test('删除服务重载换代会关闭尚未确认的对话框', async t => {
  const page = await mount(t);
  await page.getByRole('button', { name: '删除联系人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认删除联系人', exact: true });
  await expect(dialog).toBeVisible();
  await page.evaluate(() => window.publishDeletion({ scopeRevision: 8 }));
  await expect(dialog).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.calls), []);
});

test('删除按钮与添加按钮同在联系人工具栏，原生确认框支持键盘关闭、焦点圈定与返回', async t => {
  const page = await mount(t);
  const toolbar = page.locator('.contacts-toolbar');
  await expect(toolbar.getByRole('button', { name: '添加微信联系人', exact: true })).toBeVisible();
  const trigger = toolbar.getByRole('button', { name: '删除联系人', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '确认删除联系人', exact: true });
  const cancel = dialog.getByRole('button', { name: '取消', exact: true });
  const confirm = dialog.getByRole('button', { name: '删除联系人', exact: true });
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(confirm).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  assert.deepEqual(await page.evaluate(() => window.calls), []);
});

test('删除状态离线或加载时禁用删除联系人', async t => {
  for (const phase of ['offline', 'loading']) {
    const page = await mount(t, { deletionState: {
      revision: 1, scopeRevision: 7, phase, busyId: null, error: null, operations: [],
    } });
      await expect(page.getByRole('button', { name: '删除联系人', exact: true })).toBeDisabled();
    await page.close();
  }
});

test('已完成的删除静默结束，不留任务面板，也不泄露姓名或联系人标识', async t => {
  const page = await mount(t, { deletionState: {
    revision: 1, scopeRevision: 7, phase: 'ready', busyId: null, error: null,
    operations: [{ id: 'delete-001', operationId: 'operation-001', contactId: null, displayName: null, phase: 'completed', errorCode: null }],
  } });
  await expect(page.getByRole('region', { name: '联系人删除任务' })).toHaveCount(0);
  await page.evaluate(() => window.removeContactFromDirectory('contact-001'));
  await expect(page.getByRole('list', { name: '联系人列表' }).getByText('王小明')).toHaveCount(1);
  await expect(page.getByText(/contact-001|operation-001|联系人删除已完成/)).toHaveCount(0);
});

test('后台推进期间不显示任务面板，需要用户处理时才出现', async t => {
  const operation = { id: 'delete-001', operationId: 'operation-001', contactId: 'contact-001', displayName: '王小明', phase: 'cleaning', errorCode: null };
  const page = await mount(t, { deletionState: {
    revision: 1, scopeRevision: 7, phase: 'ready', busyId: 'delete-001', error: null, operations: [operation],
  } });
  await expect(page.getByRole('region', { name: '联系人删除任务' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除联系人', exact: true })).toBeDisabled();
  await page.evaluate(() => window.publishDeletion({ busyId: null }));
  const status = page.getByRole('region', { name: '联系人删除任务' });
  await expect(status).toContainText('正在清理此联系人的本机资料');
  await expect(status.getByRole('button', { name: '继续删除', exact: true })).toBeVisible();
});

test('受阻任务只按删除任务标识重试，busyId期间面板隐藏且删除入口禁用', async t => {
  const operation = { id: 'delete-001', operationId: 'operation-001', contactId: 'contact-001', displayName: '王小明', phase: 'blocked', errorCode: 'cleanup_failed' };
  const page = await mount(t, { selectedContactId: 'contact-002', deletionState: {
    revision: 1, scopeRevision: 7, phase: 'ready', busyId: null, error: null, operations: [operation],
  } });
  const status = page.getByRole('region', { name: '联系人删除任务' });
  const retry = status.getByRole('button', { name: '重试删除', exact: true });
  await expect(status).toContainText('删除失败，联系人资料尚未确认清除。');
  await retry.click();
  assert.deepEqual(await page.evaluate(() => window.calls), [{ id: 'delete-001', scopeRevision: 7, confirmed: true }]);
  await page.evaluate(() => window.calls.length = 0);
  await page.evaluate(() => window.publishDeletion({ busyId: 'delete-001' }));
  await expect(status).toHaveCount(0);
  await expect(page.getByRole('button', { name: '删除联系人', exact: true })).toBeDisabled();
  assert.deepEqual(await page.evaluate(() => window.calls), []);
});

test('进程恢复的清理阶段可继续原联系人删除任务', async t => {
  const page = await mount(t, { selectedContactId: 'contact-002', deletionState: {
    revision: 1, scopeRevision: 7, phase: 'ready', busyId: null, error: null,
    operations: [{ id: 'delete-001', operationId: 'operation-001', contactId: 'contact-001', displayName: '王小明', phase: 'verifying', errorCode: null }],
  } });
  const status = page.getByRole('region', { name: '联系人删除任务' });
  await status.getByRole('button', { name: '继续删除', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.calls), [{ id: 'delete-001', scopeRevision: 7, confirmed: true }]);
});

test('删除结果未知时明确保留可重试入口', async t => {
  const page = await mount(t, { selectedContactId: 'contact-002', deletionState: {
    revision: 1, scopeRevision: 7, phase: 'ready', busyId: null, error: null,
    operations: [{ id: 'delete-001', operationId: null, contactId: 'contact-001', displayName: '王小明', phase: 'unconfirmed', errorCode: 'response_lost' }],
  } });
  const status = page.getByRole('region', { name: '联系人删除任务' });
  await expect(status).toContainText('删除结果未知，可重试。');
  await status.getByRole('button', { name: '重试删除', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.calls), [{ id: 'delete-001', scopeRevision: 7, confirmed: true }]);
});

test('窄屏下删除确认与操作按钮保持可见且页面不横向溢出', async t => {
  const page = await mount(t, { viewport: { width: 360, height: 740 } });
  await page.getByRole('button', { name: '删除联系人', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '确认删除联系人', exact: true });
  const bounds = await dialog.boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 360);
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '删除联系人', exact: true })).toBeVisible();
  if (process.env.NOTALONE_CONTACT_DELETION_SCREENSHOT) {
    await page.screenshot({ path: process.env.NOTALONE_CONTACT_DELETION_SCREENSHOT, fullPage: true });
  }
});
