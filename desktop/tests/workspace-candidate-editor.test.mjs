import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const require = createRequire(path.resolve('package.json'));
const bundle = await build({ stdin: { contents: `
  export { CandidateVersionEditor } from './src/renderer/CandidateVersionEditor';
  export { StyleSamples } from './src/renderer/StyleSamples';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { CandidateVersionEditor, StyleSamples } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

test('工作区只显示版本编辑器的样本保存入口，旧改写仍保留原入口', () => {
  globalThis.window = { notalone: { styleSamples: {} } };
  const version = { versionId: 'v0', versionNumber: 0, messages: [{ messageId: 'm', text: '合成回复。' }], requirements: null };
  const history = { sessionId: 's', candidateId: 'c', versions: [version] };
  const view = { phase: 'ready', history, displayVersionId: 'v0' };
  const state = { contactId: 'contact', scopeRevision: 1, phase: 'ready',
    messages: { items: [] }, candidateVersions: { phase: 'ready' }, savedSession: { phase: 'ready', sessionId: 's' },
    result: { replyRequestId: 'r', input: { mode: 'rewrite_draft', inputKind: 'workspace' },
      candidates: [{ original: { candidateId: 'c' }, editedText: '合成回复。' }] } };
  const workspace = renderToStaticMarkup(React.createElement(React.Fragment, null,
    React.createElement(CandidateVersionEditor, { replies: { state }, view, candidateId: 'c', replyRequestId: 'r',
      number: 1, restored: false, noteCopy() {} }), React.createElement(StyleSamples, { replies: { state } })));
  assert.equal((workspace.match(/主动保存说法1为样本/g) ?? []).length, 1);
  const legacy = renderToStaticMarkup(React.createElement(StyleSamples, { replies: { state: { ...state,
    result: { ...state.result, input: { mode: 'rewrite_draft' } } } } }));
  assert.equal((legacy.match(/主动保存说法1为样本/g) ?? []).length, 1);
});

test('连续编辑保存使用新身份，失败重试复用本次身份，回看旧版再编辑不重放旧保存', async t => {
  const { chromium, expect } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const client = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { CandidateVersionEditor } from './src/renderer/CandidateVersionEditor';
    const original = {versionId:'v0', versionNumber:0, messages:[{messageId:'m',text:'合成原文'}], requirements:null};
    window.fixture = {requests:[], failNext:false};
    function View() {
      const [versions, setVersions] = useState([original]);
      const [display, setDisplay] = useState('v0');
      const history = {sessionId:'s',candidateId:'c',versions};
      const replies = {state:{phase:'ready',contactId:'contact',scopeRevision:1,
        candidateVersions:{phase:'ready'},savedSession:{phase:'ready',sessionId:'s'}},
        updateCandidateVersionDraft:async () => {},
        showCandidateVersion:async request => setDisplay(request.versionId),
        saveCandidateVersion:async request => {
          window.fixture.requests.push(structuredClone(request));
          if(window.fixture.failNext) {window.fixture.failNext=false;throw Error('合成暂时失败');}
          const number=versions.length;
          setVersions([...versions,{versionId:'v'+number,versionNumber:number,
            messages:request.messages,requirements:request.requirements}]);
          setDisplay('v'+number);
        }};
      return <CandidateVersionEditor replies={replies} view={{phase:'ready',history,displayVersionId:display}}
        candidateId="c" replyRequestId="r" number={1} restored={false} noteCopy={() => {}} />;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  await page.setContent('<div id="root"></div>');
  // setContent 的空白页未必提供 secure-context randomUUID；合成浏览器边界使用确定且唯一的 UUID。
  await page.evaluate(() => {
    let number = 0;
    Object.defineProperty(crypto, 'randomUUID', { configurable: true,
      value: () => `00000000-0000-4000-8000-${String(++number).padStart(12, '0')}` });
  });
  await page.addScriptTag({ content: client.outputFiles[0].text });
  const editor = page.getByRole('textbox');
  await editor.fill('合成第一次修改'); await editor.blur();
  await expect(page.getByText('修改版本 1', { exact: true })).toBeVisible();
  await page.evaluate(() => { window.fixture.failNext = true; });
  await editor.fill('合成第二次修改'); await editor.blur();
  await expect(page.getByRole('alert')).toContainText('修改尚未保存');
  await expect(editor).toHaveValue('合成第二次修改');
  await page.getByRole('button', { name: '重试保存修改', exact: true }).click();
  await expect(page.getByText('修改版本 2', { exact: true })).toBeVisible();
  let requests = await page.evaluate(() => window.fixture.requests);
  assert.deepEqual(requests.map(item => item.parentVersionId), ['v0', 'v1', 'v1']);
  assert.notEqual(requests[0].editKey, requests[1].editKey);
  assert.equal(requests[1].editKey, requests[2].editKey);
  await page.getByRole('button', { name: '查看说法1上一版', exact: true }).click();
  await expect(editor).toHaveValue('合成第一次修改');
  await editor.fill('回看旧版后的新修改'); await editor.blur();
  await expect(page.getByText('修改版本 3', { exact: true })).toBeVisible();
  requests = await page.evaluate(() => window.fixture.requests);
  assert.equal(requests[3].parentVersionId, 'v1');
  assert.notEqual(requests[3].editKey, requests[2].editKey);
  assert.equal(requests[3].messages[0].text, '回看旧版后的新修改');
});
