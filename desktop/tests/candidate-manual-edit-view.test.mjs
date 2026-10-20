import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

const require = createRequire(path.resolve('package.json'));
const result = await build({
  stdin: { contents: "export { CandidateMessageGroup } from './src/renderer/CandidateMessageGroup';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { CandidateMessageGroup } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

test('候选手动编辑只保留正文与复制入口，不要求重复填写修改说明', () => {
  const html = renderToStaticMarkup(React.createElement(CandidateMessageGroup, {
    identity: 'synthetic', number: 1, messages: [{ messageId: 'message', text: '合成编辑后的回复。' }],
    controls: null, disabled: false, dirty: true,
    restored: false, edit() {}, save: async () => {}, copy: async () => {}, noteTextCopy() {}, validatePaste: async () => {},
  }));
  assert.doesNotMatch(html, /本组修改要求|说法1修改要求/);
  assert.match(html, /候选1编辑文本/);
  assert.doesNotMatch(html, /保存本组修改|重试保存修改/);
  assert.match(html, /aria-label="复制第1条" disabled=""/);
  assert.match(html, /结束编辑后自动保存，保存完成即可复制/);
});

test('结束正文编辑自动保存，空白不保存，失败保留文字并允许重试', async t => {
  const { chromium, expect } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { CandidateMessageGroup } from './src/renderer/CandidateMessageGroup';
    function View() {
      const [text, setText] = useState('合成原文');
      const [saved, setSaved] = useState(text);
      const [attempts, setAttempts] = useState(0);
      const [fail, setFail] = useState(false);
      return <><CandidateMessageGroup identity="synthetic" number={1}
        messages={[{messageId:'m', text}]} controls={null} disabled={false}
        dirty={text !== saved} restored={false}
        edit={(_, value) => setText(value)} save={async () => {
          setAttempts(n => n + 1); if (fail) throw Error('合成保存失败'); setSaved(text);
        }} copy={async () => {}} noteTextCopy={() => {}} validatePaste={async () => {}} />
        <button onClick={() => setFail(value => !value)}>切换失败</button>
        <output>{attempts}</output><p data-testid="saved">{saved}</p></>;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const input = page.getByRole('textbox');
  await input.fill('合成修改');
  await expect(page.locator('output')).toHaveText('0');
  await input.blur();
  await expect(page.getByTestId('saved')).toHaveText('合成修改');
  await expect(page.locator('output')).toHaveText('1');
  await input.fill(' '); await input.blur();
  await expect(page.locator('output')).toHaveText('1');
  await page.getByRole('button', {name:'切换失败'}).click();
  await input.fill('合成重试内容'); await input.blur();
  await expect(page.getByRole('alert')).toContainText('修改尚未保存');
  await expect(input).toHaveValue('合成重试内容');
  await page.getByRole('button', {name:'切换失败'}).click();
  await page.getByRole('button', {name:'重试保存修改'}).click();
  await expect(page.getByTestId('saved')).toHaveText('合成重试内容');
  await expect(page.locator('output')).toHaveText('3');
  await expect(page.getByRole('button', {name:'重试保存修改'})).toHaveCount(0);
});


test('未编辑的回复可直接复制，不要求选择版本', () => {
  const html = renderToStaticMarkup(React.createElement(CandidateMessageGroup, {
    identity: 'synthetic', number: 1, messages: [{ messageId: 'message', text: '合成回复。' }],
    controls: null, disabled: false, dirty: false, restored: false,
    edit() {}, save: async () => {}, copy: async () => {}, noteTextCopy() {}, validatePaste: async () => {},
  }));
  assert.match(html, /aria-label="复制第1条"><svg/);
  assert.doesNotMatch(html, /选择当前版本|<legend/);
  assert.doesNotMatch(html, />第1条</);
});

test('候选用前后按钮回看历史，直接复制当前展示版且不调用选择接口', async t => {
  const { chromium, expect } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { CandidateVersionEditor } from './src/renderer/CandidateVersionEditor';
    const versions = [0, 1, 2].map(n => ({versionId: 'v'+n, versionNumber:n,
      messages:[{messageId:'m', text:'合成版本'+n}], requirements:null}));
    const history = {sessionId:'s', candidateId:'c', versions};
    function View() {
      const [display, setDisplay] = useState('v2');
      const [copied, setCopied] = useState('');
      const [carried, setCarried] = useState('');
      window.notalone = { candidateCopy: {copy: async request => setCopied(request.versionId)} };
      const view = {phase:'ready', history, displayVersionId:display};
      const replies = {state: {phase:'ready', contactId:'contact', scopeRevision:1,
          candidateVersions:{phase:'ready'}, savedSession:{phase:'ready',sessionId:'s'}},
        showCandidateVersion: async request => setDisplay(request.versionId),
        newSavedSessionWithCandidate: async request => setCarried(request.versionId),
        selectCandidateVersion: () => { throw Error('不应选择版本'); }};
      return <><CandidateVersionEditor replies={replies} view={view} candidateId="c"
        replyRequestId="r" number={1} restored={false} noteCopy={() => {}} />
        <output data-testid="copied">{copied}</output><output data-testid="carried">{carried}</output></>;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await expect(page.getByRole('radio')).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('textbox')).toHaveValue('合成版本2');
  const previous = page.getByRole('button', {name:'查看说法1上一版'});
  const next = page.getByRole('button', {name:'查看说法1下一版'});
  await expect(next).toBeDisabled();
  await page.getByRole('button', {name:'复制第1条'}).click();
  await expect(page.getByTestId('copied')).toHaveText('v2');
  await previous.click(); await expect(page.getByRole('textbox')).toHaveValue('合成版本1');
  await previous.click(); await expect(page.getByRole('textbox')).toHaveValue('合成版本0');
  await expect(previous).toBeDisabled();
  await page.getByRole('button', {name:'复制第1条'}).click();
  await expect(page.getByTestId('copied')).toHaveText('v0');
  await next.click(); await expect(page.getByRole('textbox')).toHaveValue('合成版本1');
  await expect(page.getByRole('button', {name:'用这组回复新开会话'})).toHaveCount(0);
  await page.getByText('更多操作', {exact:true}).click();
  await page.getByRole('button', {name:'用这组回复新开会话'}).click();
  await expect(page.getByTestId('carried')).toHaveText('v1');
});

test('异步粘贴核验使候选失焦后，核验通过自动保存而无需再次聚焦', async t => {
  const { chromium, expect } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NOTALONE_TEST_CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const bundle = await build({ stdin: { contents: `
    import React, { useState } from 'react';
    import { createRoot } from 'react-dom/client';
    import { CandidateMessageGroup } from './src/renderer/CandidateMessageGroup';
    function View() {
      const [text, setText] = useState('合成粘贴前原文');
      const [saved, setSaved] = useState(text);
      const [attempts, setAttempts] = useState(0);
      return <><CandidateMessageGroup identity="synthetic-paste" number={1}
        messages={[{messageId:'m', text}]} controls={null} disabled={false}
        dirty={text !== saved} restored={false} edit={(_, value) => setText(value)}
        save={async () => { setAttempts(n => n + 1); setSaved(text); }}
        copy={async () => {}} noteTextCopy={() => {}}
        validatePaste={() => new Promise(resolve => { window.releasePasteValidation = resolve; })} />
        <output data-testid="attempts">{attempts}</output><p data-testid="saved">{saved}</p></>;
    }
    createRoot(document.getElementById('root')).render(<View/>);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'browser', format: 'iife', write: false });
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  const input = page.getByRole('textbox', { name: '候选1编辑文本', exact: true });
  await expect(input).toHaveValue('合成粘贴前原文');
  await input.focus();
  await input.evaluate(element => {
    element.setSelectionRange(0, element.value.length);
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', '异步核验通过的合成粘贴内容');
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  });
  await expect(page.getByRole('status').filter({ hasText: '正在核对粘贴来源' })).toHaveText('正在核对粘贴来源…');
  await expect(input).toBeDisabled();
  // 不人工触发 blur/Tab：浏览器禁用当前 fieldset 后已失焦，但可能不派发 blur 事件。
  await expect(input).not.toBeFocused();
  await expect(input).toHaveValue('合成粘贴前原文');
  await expect(page.getByTestId('attempts')).toHaveText('0');
  await page.evaluate(() => window.releasePasteValidation());
  await expect(input).toHaveValue('异步核验通过的合成粘贴内容');
  await expect(page.getByRole('status').filter({ hasText: '正在核对粘贴来源' })).toHaveCount(0);
  await expect(page.getByTestId('saved')).toHaveText('异步核验通过的合成粘贴内容');
  await expect(page.getByTestId('attempts')).toHaveText('1');
  await expect(input).not.toBeFocused();
  await expect(page.getByRole('button', { name: '复制第1条', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
