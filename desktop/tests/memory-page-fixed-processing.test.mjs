import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';

test('真实记忆页面在 SQLite 模式仅挂载固定处理，资格失效撤下候选和过程正文', { timeout: 20000 }, async t => {
  const ids = {
    run: '11111111-1111-4111-8111-111111111111', task: '22222222-2222-4222-8222-222222222222',
    contact: '33333333-3333-4333-8333-333333333333', record: '44444444-4444-4444-8444-444444444444',
  };
  let run = {
    runId: ids.run, state: 'incomplete', total: 1, succeeded: 1, failed: 0, unknown: 0,
    stage: 'extraction_verification', laterStages: 'pending', inputs: [],
    tasks: [{ taskId: ids.task, scopeKind: 'contact', contactId: ids.contact, state: 'succeeded', total: 1, succeeded: 1, errorCode: null }],
    candidates: [{ id: ids.record, scopeKind: 'contact', contactId: ids.contact, body: '合成记忆页面候选', state: 'verified_pending_decision', origin: 'auto' }],
  };
  const trace = { calls: [], events: [{
    eventId: ids.record, attemptId: ids.task, kind: 'request', callId: null, inputNos: [1],
    payload: { input: '合成记忆页面输入', output: '合成记忆页面返回' }, sources: [{ contactId: ids.contact, recordId: ids.record }],
  }] };
  let documents = {status:'idle',publication:null,documents:[]};
  let memoryView = {candidates:[],memories:[]};
  const compiled = await build({
    stdin: { contents: `import React from 'react';
      import {createRoot} from 'react-dom/client';
      import {MemoryPage} from './src/renderer/MemoryPage';
      import {FixedMemoryProcessingController} from './src/main/memory/fixed-processing';
      const invalidations = new Set(), memoryInvalidations = new Set();
      const controller = new FixedMemoryProcessingController({
        getConnectionGeneration: () => 1,
        requestJson: async request => ({generation: 1, data: await window.requestJson(request.path)}),
      }, () => { for (const listener of invalidations) listener(); });
      window.legacyCalls = [];
      window.notalone = {
        fixedMemoryProcessing: {
          readMode: () => controller.mode(), readCurrent: () => controller.read(),
          start: request => controller.start(request), pause: request => controller.control('pause', request),
          continue: request => controller.control('continue', request), trace: request => controller.trace(request),
          release: async () => controller.release(),
          onInvalidated: listener => { invalidations.add(listener); return () => invalidations.delete(listener); },
        },
        backend: {onStateChanged: () => () => {}},
        sqliteMemoryManagement: {
          read: async request => ({connectionGeneration:1,scope:request.scope,view:await window.readMemory()}),
          readDocuments: async request => ({connectionGeneration:1,scope:request.scope,view:await window.readDocuments()}),
          decide: async () => ({status:'unavailable'}), release: async () => {},
          onInvalidated: listener => {memoryInvalidations.add(listener);return () => memoryInvalidations.delete(listener);},
        },
        memory: new Proxy({}, {get: (_, method) => (...args) => {
          window.legacyCalls.push(method);
          if (method.startsWith('on')) return () => {};
          return Promise.reject(new Error('SQLite 模式不得调用旧版记忆操作。'));
        }}),
      };
      window.invalidate = () => {controller.synchronize();for(const listener of memoryInvalidations)listener();};
      const session = {state: {revision: 1, scopeRevision: 1, directoryPhase: 'ready',
        contacts: [{contactId: '${ids.contact}', displayName: '合成联系人', messageCount: 1, sourceCount: 1}],
        selectedContactId: '${ids.contact}', draft: ''}, error: '', selectContact: async () => {}};
      createRoot(document.getElementById('root')).render(<MemoryPage session={session} navigate={() => {}}/>);`,
      resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', loader: { '.css': 'empty' }, write: false, logLevel: 'silent',
  });
  const browser = await chromium.launch({ channel: 'chrome', headless: true, timeout: 10000 });
  t.after(() => browser.close());
  const page = await browser.newPage();
  page.setDefaultTimeout(4000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // 只替换网络边界；页面、控制器解析和失效发布均使用正式实现。
  await page.exposeFunction('requestJson', async path => {
    if (path === '/api/runtime/status') return { state: 'running', runtime: 'dsh', hostRuntime: 'typescript', storage: 'sqlite' };
    if (path === '/api/memory-processing/runs/current') return run;
    if (path === `/api/memory-processing/tasks/${ids.task}/events`) return trace;
    throw new Error(`未约定的合成请求：${path}`);
  });
  await page.exposeFunction('readDocuments', async () => documents);
  await page.exposeFunction('readMemory', async () => memoryView);
  await page.route('http://127.0.0.1/memory-page-fixed-test', route => route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' }));
  await page.goto('http://127.0.0.1/memory-page-fixed-test');
  await page.addScriptTag({ content: compiled.outputFiles[0].text });
  const panel = page.getByRole('region', { name: '固定范围记忆处理' });
  await panel.getByText('合成记忆页面候选', { exact: true }).waitFor();
  const documentPanel=page.getByRole('region',{name:'主题资料与长期概览'});
  await documentPanel.getByText('当前尚无已发布的主题资料。',{exact:true}).waitFor();
  const management=page.getByRole('region',{name:'记忆候选与版本'});
  await management.getByText('当前范围没有可展示的正式记忆。',{exact:true}).waitFor();
  const version={mergeParents:[],mergeParentCount:0,verificationState:'verified',versionNo:'1',body:'本轮新增的合成正式记忆',formationKind:'adoption',adoptionMode:'auto',previousVersionNo:null,restoredFromVersionNo:null,contentState:'present',provenanceState:'eligible',decisionId:ids.record,sources:[],contributingContactIds:[ids.contact]};
  memoryView={candidates:[],memories:[{id:ids.task,scopeKind:'contact',contactId:ids.contact,headRevision:'1',state:'active',manualProtection:false,current:version,versions:[version],decisions:[]}]};
  documents={status:'completed',publication:{id:ids.record,members:[{documentId:ids.task,versionNo:'1'}]},documents:[{id:ids.task,versionNo:'1',scopeKind:'contact',contactId:ids.contact,kind:'scene',title:'合成主题',statements:[{text:'发布后的合成主题正文',kind:'fact',basis:null,section:null,uncertainty:null,temporalStatus:null,leftClaim:null,rightClaim:null,resolutionState:null,resolutionText:null,references:[{memoryId:ids.record,versionNo:1,level:'contact',provenanceKind:'source_supported',memoryText:'已核验的合成底层记忆'}]}]}]};
  run={...run,state:'completed',stage:'completed',laterStages:'completed'};
  await panel.getByRole('button',{name:'刷新处理状态'}).click();
  await panel.getByRole('status').filter({hasText:'本轮已完成'}).waitFor();
  await documentPanel.getByText('发布后的合成主题正文',{exact:true}).waitFor();
  await management.getByText('本轮新增的合成正式记忆',{exact:true}).first().waitFor();
  assert.equal(await page.getByRole('navigation', { name: '记忆分类' }).count(), 0);
  await panel.locator('summary').filter({ hasText: '查看本轮任务' }).click();
  await panel.getByRole('button', { name: '查看联系人 1过程', exact: true }).click();
  await panel.locator('summary').filter({ hasText: 'request' }).click();
  await panel.locator('pre').filter({ hasText: '合成记忆页面输入' }).waitFor();
  await page.evaluate(() => window.invalidate());
  await panel.getByRole('alert').filter({ hasText: '资料资格或连接已变化' }).waitFor();
  assert.equal(await panel.getByText('合成记忆页面候选', { exact: true }).count(), 0);
  assert.equal(await panel.locator('pre').count(), 0);
  assert.equal(await documentPanel.getByText('发布后的合成主题正文',{exact:true}).count(),0);
  assert.equal(await management.getByText('本轮新增的合成正式记忆',{exact:true}).count(),0);
  assert.deepEqual(await page.evaluate(() => window.legacyCalls), [], '旧版记忆读取、刷新和订阅均未执行');
  assert.deepEqual(errors, [], '页面没有 React 或桥接异常');
});
