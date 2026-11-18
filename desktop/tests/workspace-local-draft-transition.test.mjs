import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { launchChromium, mountBundle } from './helpers/browser.mjs';

test('准备期联系人资格核实保留独立草稿，换联系人不继承旧草稿或资格', async t => {
  const { expect } = await import('@playwright/test');
  const browser = await launchChromium();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AssistantWorkspaceDraft } from './src/renderer/AssistantWorkspaceDraft';
    import { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
    window.fixture={commands:[]};
    function View() {
      const [contact,setContact]=useState('a');
      const [revision,setRevision]=useState(1);
      const [draft,setDraft]=useState('');
      const [ready,setReady]=useState(false);
      const contacts={state:{selectedContactId:contact,scopeRevision:revision,draft},setDraft:async value=>setDraft(value)};
      const replies={state:{contactId:contact,scopeRevision:revision,phase:'idle',mode:'rewrite_draft',
        options:{includeRelationshipContext:true,...(ready?{inputKind:'workspace'}:{})},
        generationBlock:ready?null:'foreground-confirmation-required',
        savedSession:{phase:ready?'ready':'failed',sessionId:ready?'session-'+contact:null},
        messages:{phase:'ready',items:[]},result:null},
        readSavedSession:async()=>window.fixture.commands.push('read')};
      return <><button onClick={()=>setReady(true)}>模拟当前联系人确认和恢复完成</button>
        <button onClick={()=>{setContact('b');setRevision(2);setDraft('');setReady(false);}}>模拟切换联系人</button>
        <AssistantWorkspaceDraft contacts={contacts} replies={replies}/></>;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  await mountBundle(page, bundle);
  const draft = page.getByRole('textbox', { name: '有什么想说的', exact: true });
  await draft.fill('甲的独立本地想法');
  await expect(page.getByRole('button', { name: '帮我表达', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '帮我想想', exact: true })).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.fixture.commands), []);
  const originalEditor = await draft.elementHandle();
  await page.getByRole('button', { name: '模拟当前联系人确认和恢复完成', exact: true }).click();
  await expect(draft).toHaveValue('甲的独立本地想法');
  assert(await originalEditor.evaluate(element => element.isConnected), '确认不应因工作区模式变化重建草稿');
  await expect(draft).toBeEditable();
  await page.getByRole('button', { name: '模拟切换联系人', exact: true }).click();
  await expect(draft).toHaveValue('');
  await draft.fill('乙的独立本地想法');
  await expect(page.getByRole('button', { name: '帮我表达', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '帮我想想', exact: true })).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => window.fixture.commands), []);
});

test('旧讨论加载失败后可重试或开始新讨论，期间写下的独立想法始终留在输入区', async t => {
  const { expect } = await import('@playwright/test');
  const browser = await launchChromium();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AssistantWorkspaceDraft } from './src/renderer/AssistantWorkspaceDraft';
    import { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
    function View() {
      const [phase,setPhase]=useState('loading');
      const [sessionId,setSessionId]=useState('old-discussion');
      const [draft,setDraft]=useState('');
      const contacts={state:{selectedContactId:'a',scopeRevision:1,draft},setDraft:async value=>setDraft(value)};
      const replies={state:{contactId:'a',scopeRevision:1,phase:'idle',mode:'rewrite_draft',generationBlock:null,

        savedSession:{phase,sessionId},messages:{phase:'ready',items:[]},result:null},
        viewSavedSession:async()=>setPhase('loading'),
        newSavedSession:async()=>{setSessionId('new-discussion');setPhase('loading');}};
      return <><button onClick={()=>setPhase('failed')}>模拟读取失败</button>
        <AssistantWorkspaceDraft contacts={contacts} replies={replies}/><AssistantSessionPanel replies={replies}/></>;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  await mountBundle(page, bundle);
  const draft = page.getByRole('textbox', { name: '有什么想说的', exact: true });
  const express = page.getByRole('button', { name: '帮我表达', exact: true });
  const suggest = page.getByRole('button', { name: '帮我想想', exact: true });
  await draft.fill('加载时写下的独立想法');
  const originalEditor = await draft.elementHandle();
  await expect(express).toHaveCount(0); await expect(suggest).toHaveCount(0);
  await expect(page.getByRole('status')).toHaveText('正在读取已保存讨论…');
  await page.getByRole('button', { name: '模拟读取失败', exact: true }).click();
  await expect(page.getByRole('status')).toHaveCount(0);
  await draft.fill('失败后继续写的独立想法');
  await page.getByRole('button', { name: '重新核对讨论', exact: true }).click();
  await expect(draft).toHaveValue('失败后继续写的独立想法');
  await page.getByRole('button', { name: '模拟读取失败', exact: true }).click();
  await page.getByRole('button', { name: '开始新讨论', exact: true }).click();
  await expect(draft).toHaveValue('失败后继续写的独立想法');
  assert(await originalEditor.evaluate(element => element.isConnected), '准备新讨论时不应重建独立草稿输入区');
  await expect(express).toHaveCount(0); await expect(suggest).toHaveCount(0);

});

test('讨论恢复先于草稿回显时保留新按键，明确删除和切换范围仍清除输入', async t => {
  const { expect } = await import('@playwright/test');
  const browser = await launchChromium();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { AssistantWorkspaceDraft } from './src/renderer/AssistantWorkspaceDraft';
    import { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
    function View() {
      const [contact,setContact]=useState('a');
      const [scope,setScope]=useState(1);
      const [draft,setDraft]=useState('');
      const [cleared,setCleared]=useState(0);
      const [restored,setRestored]=useState(false);
      const contacts={state:{selectedContactId:contact,scopeRevision:scope,draft,draftClearRevision:cleared},
        setDraft:async value=>{window.pendingDraft=value;}};
      const replies={state:{contactId:contact,scopeRevision:scope,phase:'idle',mode:'rewrite_draft',generationBlock:null,
        options:{includeRelationshipContext:true,...(restored?{inputKind:'workspace'}:{})},
        inputClearRevision:restored?1:0,savedSession:{phase:restored?'ready':'loading',sessionId:'session-'+contact},
        messages:{phase:'ready',items:[]},result:null}};
      return <><button onClick={()=>setRestored(true)}>完成讨论读取</button>
        <button onClick={()=>setDraft(window.pendingDraft)}>回显本地输入</button>
        <button onClick={()=>{setDraft('');setCleared(value=>value+1);}}>确认删除草稿</button>
        <button onClick={()=>{setContact('b');setScope(2);setDraft('');}}>切换到另一范围</button>
        <AssistantWorkspaceDraft contacts={contacts} replies={replies}/></>;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  await mountBundle(page, bundle);
  const draft = page.getByRole('textbox', { name: '有什么想说的', exact: true });
  await draft.fill('等待回显的新想法');
  await page.getByRole('button', { name: '完成讨论读取', exact: true }).click();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(draft).toHaveValue('等待回显的新想法');
  await page.getByRole('button', { name: '回显本地输入', exact: true }).click();
  await expect(draft).toHaveValue('等待回显的新想法');
  await draft.fill('删除前尚未回显的想法');
  await page.getByRole('button', { name: '确认删除草稿', exact: true }).click();
  await expect(draft).toHaveValue('');
  await draft.fill('切换前尚未回显的想法');
  await page.getByRole('button', { name: '切换到另一范围', exact: true }).click();
  await expect(draft).toHaveValue('');
});
