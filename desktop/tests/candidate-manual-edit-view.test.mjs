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
    controls: null, disabled: false, dirty: true, canCopy: false,
    restored: false, edit() {}, save: async () => {}, copy: async () => {}, noteTextCopy() {}, validatePaste: async () => {},
  }));
  assert.doesNotMatch(html, /本组修改要求|说法1修改要求/);
  assert.match(html, /候选1编辑文本/);
  assert.doesNotMatch(html, /保存本组修改|重试保存修改/);
  assert.match(html, /disabled=""[^>]*>复制第1条/);
  assert.match(html, /结束编辑后自动保存，再选择当前版本即可复制/);
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
        dirty={text !== saved} canCopy={false} restored={false}
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
