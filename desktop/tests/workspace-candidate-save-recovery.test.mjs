import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';

// 真实版本编辑器经历公开主进程的空历史加载状态；只替代版本命令传输。
test('保存失败跨过历史重读仍可重试，并复用同次编辑身份', async t => {
  const { chromium, expect } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { CandidateVersionEditor } from './src/renderer/CandidateVersionEditor';
    const original = {versionId:'v0',versionNumber:0,messages:[{messageId:'m',text:'合成原文'}],requirements:null};
    window.fixture = {requests:[]};
    function View() {
      const [phase,setPhase] = useState('ready');
      const [versions,setVersions] = useState([original]);
      const [display,setDisplay] = useState('v0');
      const history = {sessionId:'s',candidateId:'c',versions};
      const replies = {state:{phase:'ready',contactId:'contact',scopeRevision:1,
        candidateVersions:{phase},savedSession:{phase:'ready',sessionId:'s'}},
        updateCandidateVersionDraft:async () => {},
        readCandidateVersions:async () => {
          setPhase('loading');
          await new Promise(resolve => { window.fixture.finishRead=resolve; });
          setPhase('ready');
        },
        saveCandidateVersion:async request => {
          window.fixture.requests.push(structuredClone(request));
          setPhase('loading');
          if(window.fixture.requests.length===1) {
            await new Promise((resolve,reject) => { window.fixture.failSave=() => {
              setPhase('failed'); reject(Error('合成传输失败'));
            }; });
          } else {
            setVersions([...versions,{versionId:'v1',versionNumber:1,messages:request.messages,requirements:null}]);
            setDisplay('v1');setPhase('ready');
          }
        }};
      return <CandidateVersionEditor replies={replies} view={{phase,history:phase==='loading'?null:history,
        displayVersionId:phase==='loading'?null:display}} candidateId="c" replyRequestId="r"
        number={1} restored={false} noteCopy={() => {}} />;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    let number = 0;
    Object.defineProperty(crypto, 'randomUUID', { configurable: true,
      value: () => `00000000-0000-4000-8000-${String(++number).padStart(12, '0')}` });
  });
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const editor = page.getByRole('textbox');
  await editor.fill('合成待保存修改'); await editor.blur();
  await expect(editor).toHaveCount(0);
  await page.evaluate(() => window.fixture.failSave());
  await expect(editor).toHaveValue('合成待保存修改');
  await page.getByRole('button', { name: '重新读取本组版本', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await page.evaluate(() => window.fixture.finishRead());
  await expect(editor).toHaveValue('合成待保存修改');
  const retry = page.getByRole('button', { name: '重试保存修改', exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(page.getByText('修改版本 1', { exact: true })).toBeVisible();
  await expect(retry).toHaveCount(0);
  const requests = await page.evaluate(() => window.fixture.requests);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].editKey, requests[1].editKey);
  assert.equal(requests[1].parentVersionId, 'v0');
  assert.equal(requests[1].messages[0].text, '合成待保存修改');
});
