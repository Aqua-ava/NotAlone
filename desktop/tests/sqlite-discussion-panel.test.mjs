import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const contactId = '11111111-1111-4111-8111-111111111111';
const sessionId = '33333333-3333-4333-8333-333333333333';
const nextSessionId = '44444444-4444-4444-8444-444444444444';

test('正式讨论面板从历史回看显式继续，分段回执重新读取权威讨论与目录', { timeout: 30_000 }, async t => {
  const compiled = await build({ stdin: { contents: `
    import React from 'react'; import { createRoot } from 'react-dom/client';
    import { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
    let invalidated; window.__calls = [];
    window.notalone = { sqliteDiscussion: {
      submit: request => window.__submit(request),
      onInvalidated: listener => { invalidated = listener; return () => { invalidated = undefined; }; }
    }};
    const entry = (text, role = 'assistant') => ({entryId:text,position:'1',role,text,requestId:'synthetic',callId:null,contentState:'available'});
    let state = {contactId:${JSON.stringify(contactId)}, scopeRevision:7, phase:'idle', exploration:{phase:'idle'},
      sessionDeletion:undefined, sourceAvailability:undefined, generationBlock:null, generationJobs:[],
      savedSession:{phase:'ready',sessionId:${JSON.stringify(sessionId)},turns:[],inputs:[],currentInputVersionId:null,
        discussionEntries:[entry('合成已保存助手发言')],runtimeRecovery:'ready'},
      sessionCatalog:{phase:'ready',items:[{sessionId:${JSON.stringify(sessionId)},isCurrent:false}],currentSessionId:${JSON.stringify(nextSessionId)}}};
    const root = createRoot(document.getElementById('root'));
    const render = () => root.render(React.createElement(AssistantSessionPanel, { replies: {state,
      listSavedSessions: async () => {window.__calls.push(['list']);},
      viewSavedSession: async id => {window.__calls.push(['view',id]);state={...state,savedSession:{...state.savedSession,sessionId:id,discussionEntries:[entry('按回执重新读取的讨论')]},sessionCatalog:{...state.sessionCatalog,currentSessionId:id}};render();},
      resumeSavedSession: async id => {window.__calls.push(['resume',id]);state={...state,sessionCatalog:{...state.sessionCatalog,currentSessionId:id,items:[{sessionId:id,isCurrent:true}]}};render();},
      readSavedSession: async () => {},newSavedSession:async()=>{},deleteSavedSession:async()=>{}
    }}));
    window.__patch = patch => {state={...state,...patch};render();};
    window.__savedPhase = phase => {state={...state,savedSession:{...state.savedSession,phase}};render();};
    window.__catalogPatch = patch => {state={...state,sessionCatalog:{...state.sessionCatalog,...patch}};render();};
    window.__invalidate = () => invalidated?.({revision:1,contactId:state.contactId,scopeRevision:state.scopeRevision});
    window.__legacy = () => {const {discussionEntries,runtimeRecovery,...saved}=state.savedSession;state={...state,savedSession:{...saved,inputs:[]}};render();};
    render();
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false, logLevel: 'silent' });
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  t.after(() => browser.close()); const page = await browser.newPage(); const submissions = [];
  await page.exposeFunction('__submit', async request => { submissions.push(request); return { sessionId: submissions.length === 1 ? nextSessionId : sessionId, segmented: submissions.length === 1, replayed: submissions.length > 1, requestKey: request.requestKey }; });
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.addScriptTag({ content: compiled.outputFiles[0].text });
  await expect(page.getByRole('region', { name: '助手讨论发言', exact: true })).toHaveCount(0);
  await page.locator('summary').filter({ hasText: '与助手讨论' }).click();
  await expect(page.getByRole('region', { name: '助手讨论发言', exact: true })).toContainText('合成已保存助手发言');
  await expect(page.getByText('历史讨论仅回看，不会自动加入新候选；继续此讨论后才切换当前讨论。', { exact: true })).toBeVisible();
  const input = page.getByRole('textbox', { name: '讨论内容' });
  await expect(input).toBeDisabled();
  await page.getByText('历史讨论', { exact: true }).click();
  await page.getByRole('group', { name: '正在查看的讨论操作' }).getByRole('button', { name: '继续此讨论', exact: true }).click();
  await expect(input).toBeEnabled(); assert.equal(submissions.length, 0);
  await page.evaluate(() => window.__patch({generationBlock:'foreground-confirmation-required'}));
  await expect(input).toBeEnabled();
  for (const [label, patch] of [['source-checking',{sourceAvailability:'checking'}], ['source-failed',{sourceAvailability:'failed'}], ['deleting',{sessionDeletion:'deleting'}], ['delete-failed',{sessionDeletion:'failed'}], ['waiting',{phase:'waiting'}]]) {
    await page.evaluate(patch => window.__patch(patch), patch); await expect(input, label).toBeDisabled();
    await page.evaluate(() => window.__patch({sourceAvailability:undefined,sessionDeletion:undefined,phase:'idle',generationBlock:null,exploration:{phase:'idle'}})); await expect(input, `${label} reset`).toBeEnabled();
  }
  await page.evaluate(() => window.__savedPhase('loading')); await expect(input).toBeDisabled();
  await page.evaluate(() => window.__savedPhase('ready')); await expect(input).toBeEnabled();
  await page.evaluate(() => window.__catalogPatch({selectionPending:true})); await expect(input).toBeDisabled();
  await page.evaluate(() => window.__catalogPatch({selectionPending:false})); await expect(input).toBeEnabled();
  await input.fill('本次合成讨论'); await page.getByRole('button', { name: '与此联系人讨论', exact: true }).click();
  await expect(page.getByRole('region', { name: '助手讨论发言', exact: true })).toContainText('按回执重新读取的讨论');
  await expect.poll(() => page.evaluate(() => window.__calls.filter(([method]) => method === 'list').length)).toBeGreaterThan(0);
  const calls = await page.evaluate(() => window.__calls);
  assert.deepEqual(calls.filter(([method]) => method === 'resume'), [['resume', sessionId]]);
  assert.deepEqual(calls.filter(([method]) => method === 'view'), [['view', nextSessionId]]);
  assert.equal(submissions[0].contactId, contactId); assert.equal(submissions[0].scopeRevision, 7); assert.equal(submissions[0].sessionId, sessionId);
  await input.fill('核对原请求的合成讨论'); await page.getByRole('button', { name: '与此联系人讨论', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__calls.filter(([method]) => method === 'view'))).toEqual([['view', nextSessionId], ['view', sessionId]]);
  assert.equal(submissions[1].sessionId, nextSessionId);
  assert.deepEqual((await page.evaluate(() => window.__calls)).filter(([method]) => method === 'resume'), [['resume', sessionId]]);
  await input.fill('资料失效前草稿'); await page.evaluate(() => window.__invalidate()); await expect(input).toHaveValue('');
  await page.evaluate(() => window.__legacy()); await expect(input).toHaveCount(0);
  await expect(page.getByRole('region', { name: '已保存的讨论', exact: true })).toContainText('当前会话还没有讨论');
});

test('正式preload只暴露具名讨论、候选操作和失效订阅，拒绝额外权限字段', async t => {
  const owned = await mkdtemp(join(tmpdir(), 'notalone-discussion-preload-'));
  t.after(() => rm(owned, { recursive: true, force: true }));
  const calls = [], listeners = new Map(); let bridge;
  const transport = { invoke: async (...args) => { calls.push(args); return { sessionId, requestKey: args[1]?.requestKey, segmented: false, replayed: false }; },
    on: (channel, listener) => listeners.set(channel, listener), removeListener: (channel, listener) => { if (listeners.get(channel) === listener) listeners.delete(channel); } };
  const token = `__discussionPreload${randomUUID().replaceAll('-', '')}`;
  globalThis[token] = { ipcRenderer: transport, contextBridge: { exposeInMainWorld: (name, value) => { assert.equal(name, 'notalone'); bridge = value; } } };
  t.after(() => { delete globalThis[token]; });
  const outfile = join(owned, 'preload.mjs');
  await build({ entryPoints: ['src/preload/index.ts'], outfile, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'synthetic-electron-transport', setup(plugin) {
      plugin.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'fixture' }));
      plugin.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export const {ipcRenderer,contextBridge}=globalThis[${JSON.stringify(token)}];` }));
    } }] });
  await import(pathToFileURL(outfile).href);
  assert.deepEqual(Object.keys(bridge.sqliteDiscussion).sort(), ['candidates', 'onInvalidated', 'submit']);
  assert.ok(Object.isFrozen(bridge)); assert.ok(bridge.media);
  const request = { contactId, scopeRevision: 7, sessionId, requestKey: randomUUID(), text: '合成正式入口讨论' };
  await bridge.sqliteDiscussion.submit(request);
  assert.deepEqual(calls, [['sqlite-discussion:submit', request]]);
  await assert.rejects(bridge.sqliteDiscussion.submit({ ...request, ownerId: randomUUID() }), /无效/);
  await assert.rejects(bridge.sqliteDiscussion.submit(request, { path: '/api/anything' }), /无效/); assert.equal(calls.length, 1);
  let received; const off = bridge.sqliteDiscussion.onInvalidated(event => { received = event; });
  const event = { contactId, scopeRevision: 7, revision: 1 }; listeners.get('sqlite-discussion:invalidated')({}, event);
  assert.deepEqual(received, event); off(); assert.equal(listeners.size, 0);
});

test('正式会话面板消费联系人初始草稿且用户编辑后不会重复注入', { timeout: 30_000 }, async t => {
  const compiled = await build({ stdin: { contents: `
    import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
    import { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
    const sessionId=${JSON.stringify(sessionId)},nextSessionId=${JSON.stringify(nextSessionId)};
    window.notalone = { sqliteDiscussion: {
      candidates: { execute: async () => ({ coverage: { phase: 'complete' }, requests: [] }) },
      submit: async () => ({}),
      onInvalidated: () => () => {}
    }};
    const methods = {listSavedSessions:async()=>{},viewSavedSession:async()=>{},resumeSavedSession:async()=>{},
      readSavedSession:async()=>{},newSavedSession:async()=>{},deleteSavedSession:async()=>{}};
    function View() {
      const [draft,setDraft]=useState('联系人初始草稿'),[session,setSession]=useState(sessionId),[taken,setTaken]=useState(0);
      window.__taken = () => taken;
      const state = {contactId:${JSON.stringify(contactId)},scopeRevision:7,phase:'idle',generationBlock:null,generationJobs:[],
        savedSession:{phase:'ready',sessionId:session,turns:[],inputs:[],currentInputVersionId:null,discussionEntries:[],runtimeRecovery:'ready'},
        sessionCatalog:{phase:'ready',items:[{sessionId:session,isCurrent:true}],currentSessionId:session}};
      return React.createElement(React.Fragment, null,
        React.createElement('button', { onClick: () => setSession(nextSessionId) }, '切换讨论'),
        React.createElement(AssistantSessionPanel, { replies: { state, ...methods }, initialDraft: draft, onDraftChange: () => {},
          onInitialDraftTaken: () => { setTaken(value => value + 1); setDraft(''); } }));
    }
    createRoot(document.getElementById('root')).render(React.createElement(View));
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false, logLevel: 'silent' });
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div>'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  t.after(() => browser.close()); const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`); await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const input = page.getByRole('textbox', { name: '有什么想说的', exact: true });
  await expect(input).toHaveValue('联系人初始草稿');
  await expect.poll(() => page.evaluate(() => window.__taken())).toBe(1);
  await input.fill('用户编辑后的新草稿');
  await expect(input).toHaveValue('用户编辑后的新草稿');
  await expect.poll(() => page.evaluate(() => window.__taken())).toBe(1);
  await page.getByRole('button', { name: '切换讨论', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect.poll(() => page.evaluate(() => window.__taken())).toBe(1);
});
