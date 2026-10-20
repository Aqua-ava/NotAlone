import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

test('本地草稿在确认进入工作区后保留，换联系人不继承旧草稿或资格', async t => {
  const { chromium, expect } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { UnifiedReplyWorkspace } from './src/renderer/UnifiedReplyWorkspace';
    window.fixture={commands:[]};
    function View() {
      const [contact,setContact]=useState('a');
      const [revision,setRevision]=useState(1);
      const [draft,setDraft]=useState('');
      const [ready,setReady]=useState(false);
      const contacts={state:{selectedContactId:contact,scopeRevision:revision,draft},setDraft:async value=>setDraft(value)};
      const replies={state:{contactId:contact,scopeRevision:revision,phase:'idle',mode:'rewrite_draft',
        options:{tone:'original',instruction:'',includeRelationshipContext:true,...(ready?{inputKind:'workspace'}:{})},
        generationBlock:ready?null:'foreground-confirmation-required',
        savedSession:{phase:ready?'ready':'failed',sessionId:ready?'session-'+contact:null},
        messages:{phase:'ready',items:[]},result:null},
        enterWorkspace:async()=>window.fixture.commands.push('enter'),
        loadMessages:async()=>window.fixture.commands.push('load'),
        generateWorkspace:async()=>window.fixture.commands.push('generate')};
      return <><button onClick={()=>setReady(true)}>模拟当前联系人确认和恢复完成</button>
        <button onClick={()=>{setContact('b');setRevision(2);setDraft('');setReady(false);}}>模拟切换联系人</button>
        <UnifiedReplyWorkspace contacts={contacts} replies={replies}/></>;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const draft = page.getByRole('textbox', { name: '有什么想说的', exact: true });
  await draft.fill('甲的独立本地想法');
  await expect(page.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '帮我想想', exact: true })).toBeDisabled();
  await page.getByText('最近聊天 · 查看／补充', { exact: true }).click();
  await expect(page.getByRole('textbox', { name: '补充聊天上下文', exact: true })).toBeDisabled();
  assert.deepEqual(await page.evaluate(() => window.fixture.commands), []);
  const originalEditor = await draft.elementHandle();
  await page.getByRole('button', { name: '模拟当前联系人确认和恢复完成', exact: true }).click();
  await expect(draft).toHaveValue('甲的独立本地想法');
  assert(await originalEditor.evaluate(element => element.isConnected), '确认不应因工作区模式变化重建草稿');
  await expect(page.getByRole('button', { name: '帮我表达', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '模拟切换联系人', exact: true }).click();
  await expect(draft).toHaveValue('');
  await draft.fill('乙的独立本地想法');
  await expect(page.getByRole('button', { name: '帮我表达', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '帮我想想', exact: true })).toBeDisabled();
  assert.deepEqual(await page.evaluate(() => window.fixture.commands), []);
});
