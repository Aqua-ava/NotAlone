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

test('候选手动编辑只保留正文与保存复制入口，不要求重复填写修改说明', () => {
  const html = renderToStaticMarkup(React.createElement(CandidateMessageGroup, {
    identity: 'synthetic', number: 1, messages: [{ messageId: 'message', text: '合成编辑后的回复。' }],
    controls: null, disabled: false, dirty: true, canCopy: false,
    restored: false, edit() {}, save: async () => {}, copy: async () => {}, noteTextCopy() {}, validatePaste: async () => {},
  }));
  assert.doesNotMatch(html, /本组修改要求|说法1修改要求/);
  assert.match(html, /候选1编辑文本/);
  assert.match(html, /保存本组修改/);
  assert.match(html, /disabled=""[^>]*>复制第1条/);
  assert.match(html, /保存修改后，再选择当前版本并逐条复制/);
});
