import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

async function mount(t, contents) {
  const bundle = await build({ stdin: { contents, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true,
    platform: 'browser', format: 'iife', write: false, loader: { '.css': 'empty' }, logLevel: 'silent' });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  await page.clock.install();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  return page;
}
const entry = "import React from 'react';import {createRoot} from 'react-dom/client';";

test('微信连接正常时自动读取，来源待确认期间保留人工勾选，只有读取失败才显示重试', async t => {
  const page = await mount(t, `${entry}
    import {WechatSetupPanel} from './src/renderer/WechatSetupPanel';
    let state={phase:'connected',accountId:'synthetic-account',failureCode:null,revision:1};
    const listeners=new Set();window.calls=[];window.failRead=false;
    window.update=value=>{state={...state,...value,revision:state.revision+1};for(const fn of listeners)fn(state);};
    const bridge={getState:async()=>state,onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
      refresh:async()=>{window.calls.push('read');window.update(window.failRead?{phase:'failed',failureCode:'status_unavailable'}:{phase:'connected',failureCode:null});},
      detect:async()=>window.calls.push('detect'),confirm:async()=>window.calls.push('confirm'),retryRestart:async()=>window.calls.push('restart')};
    createRoot(document.getElementById('root')).render(<WechatSetupPanel bridge={bridge}/>);`);
  await expect(page.getByRole('heading', { name: '微信账号已连接' })).toBeVisible();
  await expect(page.getByRole('button', { name: /刷新微信连接状态|重试读取微信连接状态/ })).toHaveCount(0);
  const count = await page.evaluate(() => window.calls.length);
  await page.clock.runFor(5100);
  assert.equal(await page.evaluate(() => window.calls.length), count + 1);
  await page.evaluate(() => window.update({ phase: 'ready', sourceReconfirmationRequired: true }));
  const confirm = page.getByRole('checkbox', { name: '我已核对当前微信账号，重新关联当前本机资料' });
  await confirm.check();
  const held = await page.evaluate(() => window.calls.length);
  await page.clock.runFor(10100);
  await expect(confirm).toBeChecked();
  assert.equal(await page.evaluate(() => window.calls.length), held);
  await page.evaluate(() => { window.failRead = true; window.update({ phase: 'connected', sourceReconfirmationRequired: false }); });
  await expect(page.getByRole('heading', { name: '微信账号已连接' })).toBeVisible();
  await page.clock.runFor(5100);
  await expect(page.getByRole('button', { name: '重试读取微信连接状态' })).toBeVisible();
  await page.evaluate(() => { window.failRead = false; });
  await page.getByRole('button', { name: '重试读取微信连接状态' }).click();
  await expect(page.getByRole('heading', { name: '微信账号已连接' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试读取微信连接状态' })).toHaveCount(0);
  assert.ok((await page.evaluate(() => window.calls)).every(call => call === 'read'));
});

test('联系人保存授权自动更新，选择会话期间暂停查询，失败后重试只读取已保存授权', async t => {
  const page = await mount(t, `${entry}
    import {ContactSyncSettings} from './src/renderer/ContactSyncSettings';
    let state={revision:1,scopeRevision:1,phase:'ready',sessions:[],bindings:[],knownBindings:[],syncEnabled:false,sessionIssue:'not-requested',busy:null,errorCode:null,notice:null};
    const listeners=new Set();window.calls=[];window.failRead=false;
    const publish=next=>{state={...state,...next,revision:state.revision+1};for(const fn of listeners)fn(state);};
    window.notalone={bindings:{getState:async()=>state,onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
      refreshSaved:async()=>{window.calls.push('saved');publish({phase:window.failRead?'failed':'ready'});},refresh:async()=>window.calls.push('list')},
      syncControl:{getState:async()=>({revision:1,scopeRevision:1,phase:'ready',report:null,busy:null,errorCode:null}),onStateChanged:()=>()=>{},refresh:async()=>window.calls.push('sync')}};
    const session={state:{contacts:[{contactId:'synthetic-contact',displayName:'合成联系人'}],selectedContactId:'synthetic-contact'}};
    createRoot(document.getElementById('root')).render(<ContactSyncSettings session={session} navigate={()=>{}}/>);`);
  await expect(page.getByRole('button', { name: '关联微信并开启同步' })).toBeVisible();
  await expect(page.getByRole('button', { name: /刷新联系人同步状态|重试加载同步状态/ })).toHaveCount(0);
  const count = await page.evaluate(() => window.calls.filter(call => call === 'saved').length);
  await page.clock.runFor(5100);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call === 'saved').length), count + 1);
  await page.getByRole('button', { name: '关联微信并开启同步' }).click();
  await expect(page.getByRole('button', { name: '刷新微信会话', exact: true })).toBeVisible();
  const selectedCount = await page.evaluate(() => window.calls.length);
  await page.clock.runFor(10100);
  assert.equal(await page.evaluate(() => window.calls.length), selectedCount);
  await page.getByRole('button', { name: '返回同步设置' }).click();
  await page.evaluate(() => { window.failRead = true; });
  await page.clock.runFor(5100);
  await expect(page.getByRole('button', { name: '重试加载同步状态' })).toBeVisible();
  await page.evaluate(() => { window.failRead = false; });
  await page.getByRole('button', { name: '重试加载同步状态' }).click();
  await expect(page.getByRole('button', { name: '重试加载同步状态' })).toHaveCount(0);
  assert.ok(!(await page.evaluate(() => window.calls)).includes('list'));
});

test('同步关闭时也自动更新总开关，查询失败才提供只读重试，不重放开关操作', async t => {
  const page = await mount(t, `${entry}
    import {SyncControlPanel} from './src/renderer/SyncControlPanel';
    const report={enabled:false,selectionOnly:true,bodyAvailable:false,confirmedBindingCount:0,backgroundPhase:'disabled',historyCoverages:[],backfill:{phase:'complete'}};
    let state={revision:1,scopeRevision:1,phase:'ready',report,busy:null,errorCode:null};
    const listeners=new Set();window.calls=[];window.failRead=false;
    const publish=next=>{state={...state,...next,revision:state.revision+1};for(const fn of listeners)fn(state);};
    window.update=publish;
    const bridge={getState:async()=>{window.calls.push('state');return state;},onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
      refresh:async()=>{window.calls.push('read');publish(window.failRead?{phase:'failed',report:null,errorCode:'status-unconfirmed'}:{phase:'ready',report,errorCode:null});},
      enable:async()=>window.calls.push('enable'),disable:async()=>window.calls.push('disable')};
    createRoot(document.getElementById('root')).render(<SyncControlPanel bridge={bridge}/>);`);
  await expect(page.getByText('后台正文同步已关闭', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /刷新同步状态|重试读取同步状态/ })).toHaveCount(0);
  const count = await page.evaluate(() => window.calls.filter(call => call === 'read').length);
  await page.clock.runFor(5100);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call === 'read').length), count + 1);
  await page.evaluate(() => { window.failRead = true; });
  await page.clock.runFor(5100);
  await expect(page.getByRole('button', { name: '重试读取同步状态' })).toBeVisible();
  await page.evaluate(() => { window.failRead = false; });
  await page.getByRole('button', { name: '重试读取同步状态' }).click();
  await expect(page.getByText('后台正文同步已关闭', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '重试读取同步状态' })).toHaveCount(0);
  assert.ok((await page.evaluate(() => window.calls)).every(call => ['state', 'read'].includes(call)));
});

test('已连接账号和已保存联系人后台查询不发布加载中，也不读取名单或写入授权', async () => {
  const bundle = await build({ stdin: { contents: "export {WechatSetupController} from './src/main/setup/wechat-controller';export {BindingConsentController} from './src/main/bindings/controller';", resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  const { WechatSetupController, BindingConsentController } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  let generation;
  const listeners = new Set(), requests = [];
  const backend = { getConnectionGeneration: () => generation, onStateChanged: fn => { listeners.add(fn); return () => listeners.delete(fn); },
    requestJson: async request => {
      requests.push(request);
      return { generation, data: request.path === '/api/setup/wechat' ? { state: 'connected', account_id: 'synthetic-account', candidate_token: null, failure_code: null }
        : request.path === '/api/setup/status' ? { runtime_owner_configured: true }
        : request.path === '/api/sync/cli-bindings' ? { bindings: [], revoked_bindings: [] } : { sync_enabled: false } };
    } };
  const wechat = new WechatSetupController(backend);
  const binding = new BindingConsentController(backend, { getState: () => ({ directoryPhase: 'ready', contacts: [] }), refreshContacts: async () => {} });
  generation = 1;
  for (const listener of listeners) listener();
  await new Promise(resolve => setImmediate(resolve));
  const phases = [];
  wechat.onStateChanged(state => phases.push(state.phase));
  binding.onStateChanged(state => phases.push(state.phase));
  await wechat.refresh();
  await binding.refreshSaved();
  assert.ok(phases.includes('connected') && phases.includes('ready'));
  assert.ok(!phases.includes('loading'));
  assert.ok(requests.every(request => request.method === 'GET' && request.path !== '/api/sync/cli-sessions'));
});

async function heldContactFixture(t) {
  return mount(t, `${entry}
    import {ContactSyncSettings} from './src/renderer/ContactSyncSettings';
    let state={revision:1,scopeRevision:1,phase:'ready',sessions:[{locator:'synthetic-session',displayName:'合成会话',boundContactId:null}],bindings:[],knownBindings:[],syncEnabled:false,sessionIssue:null,busy:null,errorCode:null,notice:null};
    const listeners=new Set();window.calls=[];window.holdRead=false;
    const publish=next=>{state={...state,...next,revision:state.revision+1,sessions:state.sessions.map(row=>({...row}))};for(const fn of listeners)fn(state);};
    window.notalone={bindings:{getState:async()=>state,onStateChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
      refreshSaved:async()=>{window.calls.push('saved');if(window.holdRead)await new Promise((resolve,reject)=>{window.finishRead=failed=>{window.holdRead=false;publish({phase:failed?'failed':'ready'});failed?reject(new Error('合成读取失败')):resolve();};});else publish({phase:'ready'});},
      refresh:async()=>window.calls.push('list'),confirmSelections:async value=>window.calls.push(value)},
      syncControl:{getState:async()=>({revision:1,scopeRevision:1,phase:'ready',report:null,busy:null,errorCode:null}),onStateChanged:()=>()=>{},refresh:async()=>window.calls.push('sync')}};
    const root=createRoot(document.getElementById('root'));
    function App(){const [selectedContactId,setContact]=React.useState('synthetic-contact'),[scopeRevision,setScope]=React.useState(1);
      window.switchContact=()=>{setContact('synthetic-other');setScope(2);};
      return <ContactSyncSettings session={{state:{scopeRevision,contacts:[{contactId:'synthetic-contact',displayName:'合成联系人'},{contactId:'synthetic-other',displayName:'合成另一人'}],selectedContactId}}} navigate={()=>{}}/>;}
    window.unmount=()=>root.unmount();root.render(<App/>);`);
}

async function holdContactRead(page) {
  await expect(page.getByRole('button', { name: '关联微信并开启同步' })).toBeVisible();
  await page.evaluate(() => { window.holdRead = true; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(() => page.evaluate(() => typeof window.finishRead)).toBe('function');
  await page.getByRole('button', { name: '关联微信并开启同步' }).click();
}

test('切入联系人选择先等待已发出的保存状态查询，迟到回包不会重置随后勾选的历史授权', async t => {
  const page = await heldContactFixture(t);
  await holdContactRead(page);
  await expect(page.getByRole('region', { name: '添加微信联系人', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.finishRead(false));
  const choice = page.getByRole('checkbox', { name: '选择会话 synthetic-session', exact: true });
  await expect(choice).toBeVisible();
  await choice.check();
  const history = page.getByRole('checkbox', { name: '同时读取本次所选会话在本机可用的历史消息' });
  await history.check();
  await page.clock.runFor(10100);
  await expect(history).toBeChecked();
  await page.getByRole('button', { name: '确认并授权所选会话' }).click();
  assert.equal((await page.evaluate(() => window.calls)).find(call => typeof call === 'object').historyAuthorized, true);
});

for (const outcome of ['failure', 'scope', 'unmount']) test(`等待保存状态查询时${outcome}不进入旧联系人的选择页`, async t => {
  const page = await heldContactFixture(t);
  await holdContactRead(page);
  if (outcome === 'scope') {
    await page.evaluate(() => window.switchContact());
    await expect(page.getByText('合成另一人', { exact: true })).toBeVisible();
  }
  if (outcome === 'unmount') await page.evaluate(() => window.unmount());
  await page.evaluate(failed => window.finishRead(failed), outcome === 'failure');
  await expect(page.getByRole('region', { name: '添加微信联系人', exact: true })).toHaveCount(0);
  if (outcome === 'failure') await expect(page.getByRole('button', { name: '重试加载同步状态' })).toBeVisible();
});
