import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium, expect } from '@playwright/test';

const bundle = await build({ stdin: { contents: `
  import React, { useState } from 'react';
  import { createRoot } from 'react-dom/client';
  import { UnifiedReplyWorkspace } from './src/renderer/UnifiedReplyWorkspace';
  import { SqliteReplyCandidatesPanel } from './src/renderer/SqliteReplyCandidatesPanel';
  const listeners=new Set();
  window.fixture={pendingDraft:'',commands:[],sourceUnavailable:false,sourceFailure:false,panelDraft:''};
  const requestId='11111111-1111-4111-8111-111111111111';
  const candidate={candidateId:'22222222-2222-4222-8222-222222222222',versionNo:1,origin:'model',parentVersionNo:null,
    parts:['合成候选'],basis:[{itemNo:1,kind:'message',text:'合成依据',verification:'actual_input'}]};
  const bridge={onInvalidated:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
    candidates:{execute:async request=>{window.fixture.commands.push(request.action);if(window.fixture.sourceFailure)throw new Error('参考资料已失效，请重新读取。');return {coverage:{phase:'complete'},
      requests:[{requestId,coverageWarning:null,sourceState:window.fixture.sourceUnavailable?'unavailable':'available',
        candidates:window.fixture.sourceUnavailable?[]:[candidate],selections:[],loadedSkills:[]}]};}}};
  function View(){
    const [sqlite,setSqlite]=useState(false),[draft,setDraft]=useState('');
    const contacts={state:{selectedContactId:'contact-a',scopeRevision:1,draft},
      setDraft:async value=>{window.fixture.pendingDraft=value;}};
    const replies={state:{contactId:'contact-a',scopeRevision:1,phase:'idle',mode:'rewrite_draft',generationBlock:null,
      options:{tone:'original',instruction:'',includeRelationshipContext:true},
      savedSession:{phase:'loading',sessionId:'session-a'},messages:{phase:'ready',items:[]},result:null}};
    return <><button onClick={()=>setSqlite(true)}>完成SQLite讨论读取</button>
      <button onClick={()=>setDraft(window.fixture.pendingDraft)}>回显加载时的草稿</button>
      <button onClick={()=>{for(const listener of listeners)listener({revision:2,contactId:'contact-a',scopeRevision:1});}}>撤销来源</button>
      <button onClick={()=>{window.fixture.sourceUnavailable=true;}}>模拟来源读取失效</button>
      <button onClick={()=>{window.fixture.sourceFailure=true;}}>模拟来源资格拒绝</button>
      {sqlite?<SqliteReplyCandidatesPanel bridge={bridge} contactId="contact-a" scopeRevision={1} sessionId="session-a"
        initialDraft={draft} onDraftChange={text=>{window.fixture.panelDraft=text;}}/>
        :<UnifiedReplyWorkspace contacts={contacts} replies={replies}/>}</>;
  }
  createRoot(document.getElementById('root')).render(<View/>);
`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });

async function handoff(t) {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const draft = page.getByRole('textbox', { name: '有什么想说的', exact: true });
  await draft.fill('加载期间写下的独立想法');
  await page.getByRole('button', { name: '完成SQLite讨论读取', exact: true }).click();
  await expect(draft).toBeEnabled();
  return { page, draft };
}

test('加载期间写下的独立草稿在切到SQLite工作区后仍接收晚到回显', async t => {
  const { page, draft } = await handoff(t);
  await page.getByRole('button', { name: '回显加载时的草稿', exact: true }).click();
  await expect(draft).toHaveValue('加载期间写下的独立想法');
  assert.equal((await page.evaluate(() => window.fixture.commands)).every(action => action === 'read'), true);
});

test('SQLite工作区已经写下的新想法不会被加载阶段的晚到草稿覆盖', async t => {
  const { page, draft } = await handoff(t);
  await draft.fill('进入工作区后重新写的想法');
  await page.getByRole('button', { name: '回显加载时的草稿', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(draft).toHaveValue('进入工作区后重新写的想法');
});

test('权威读取确认来源失效后不能接回晚到的旧草稿', async t => {
  const { page, draft } = await handoff(t);
  await page.getByRole('button', { name: '模拟来源读取失效', exact: true }).click();
  await page.getByRole('button', { name: '刷新候选', exact: true }).click();
  await expect(page.getByText('这次候选的来源已失效，正文与依据已撤下。', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '回显加载时的草稿', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(draft).toHaveValue('');
});

test('来源撤销或删除通知之后，晚到草稿不会重新出现', async t => {
  const { page, draft } = await handoff(t);
  await page.getByRole('button', { name: '撤销来源', exact: true }).click();
  await page.getByRole('button', { name: '回显加载时的草稿', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(draft).toHaveValue('');
});

test('来源资格被拒绝后不能用晚到草稿恢复已撤下的输入', async t => {
  const { page, draft } = await handoff(t);
  await page.getByRole('button', { name: '模拟来源资格拒绝', exact: true }).click();
  await page.getByRole('button', { name: '刷新候选', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('参考资料已失效，请重新读取。');
  await page.getByRole('button', { name: '回显加载时的草稿', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(draft).toHaveValue('');
});
