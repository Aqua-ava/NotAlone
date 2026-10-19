import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

test('工作区提交只阻止当前范围，旧范围完成不能解除新范围的提交状态', async t => {
  const { chromium, expect } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const client = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { UnifiedReplyWorkspace } from './src/renderer/UnifiedReplyWorkspace';
    const initialOptions = {inputKind:'workspace',includeRelationshipContext:true,tone:'original',instruction:''};
    window.fixture = {requests:[], releases:[], completed:[]};
    function View() {
      const [scope, setScope] = useState({contactId:'contact-a',sessionId:'session-a',scopeRevision:1,inputClearRevision:0});
      const [draft, setDraft] = useState('');
      const [options, setOptions] = useState(initialOptions);
      const contacts = {state:{selectedContactId:scope.contactId,draft,scopeRevision:scope.scopeRevision,
        draftClearRevision:scope.inputClearRevision},setDraft:async value => setDraft(value)};
      const replies = {state:{...scope,phase:'idle',mode:'rewrite_draft',options,
        savedSession:{phase:'ready',sessionId:scope.sessionId},messages:{phase:'ready',items:[]}},
        updateOptions:async value => setOptions(value),
        generateWorkspace:async action => {
          const index = window.fixture.requests.length;
          window.fixture.requests.push({contactId:scope.contactId,sessionId:scope.sessionId,draft,action});
          // 命令尚未返回、主进程状态尚未投影时，组件仍需阻止当前范围重复提交。
          await new Promise(resolve => {window.fixture.releases[index] = resolve;});
          window.fixture.completed.push(index);
        }};
      const switchScope = sameContact => {
        setDraft('');
        setScope({contactId:sameContact?'contact-a':'contact-b',sessionId:'session-b',
          scopeRevision:sameContact?1:2,inputClearRevision:1});
      };
      return <><button onClick={() => switchScope(false)}>切换联系人</button>
        <button onClick={() => switchScope(true)}>切换同联系人会话</button>
        <UnifiedReplyWorkspace contacts={contacts} replies={replies}/></>;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  for (const sameContact of [false, true]) {
    await t.test(sameContact ? '同联系人不同会话' : '不同联系人', async () => {
      const page = await browser.newPage();
      try {
        await page.setContent('<div id="root"></div>');
        await page.addScriptTag({ content: client.outputFiles[0].text });
        const draft = page.getByRole('textbox', { name: '有什么想说的', exact: true });
        const express = page.getByRole('button', { name: '帮我表达', exact: true });
        const suggest = page.getByRole('button', { name: '帮我想想', exact: true });
        await suggest.click();
        await expect(draft).toBeDisabled();
        await expect(express).toBeDisabled();
        await expect(suggest).toBeDisabled();
        await page.getByRole('button', { name: sameContact ? '切换同联系人会话' : '切换联系人', exact: true }).click();
        await expect(draft).toBeEditable();
        await expect(draft).toHaveValue('');
        await draft.fill('新范围的独立想法');
        await express.click();
        await expect(draft).toBeDisabled();
        await expect(suggest).toBeDisabled();
        assert.deepEqual(await page.evaluate(() => window.fixture.requests), [
          { contactId: 'contact-a', sessionId: 'session-a', draft: '', action: 'suggest' },
          { contactId: sameContact ? 'contact-a' : 'contact-b', sessionId: 'session-b', draft: '新范围的独立想法', action: 'express' },
        ]);
        await page.evaluate(async () => {
          window.fixture.releases[0]();
          await new Promise(requestAnimationFrame);
        });
        assert.deepEqual(await page.evaluate(() => window.fixture.completed), [0]);
        await expect(draft).toHaveValue('新范围的独立想法');
        await expect(draft).toBeDisabled();
        await expect(express).toBeDisabled();
        await expect(suggest).toBeDisabled();
        await page.evaluate(() => window.fixture.releases[1]());
        await expect(draft).toBeEditable();
        await expect(express).toBeEnabled();
        await expect(suggest).toBeEnabled();
        assert.deepEqual(await page.evaluate(() => window.fixture.completed), [0, 1]);
      } finally { await page.close(); }
    });
  }
});
