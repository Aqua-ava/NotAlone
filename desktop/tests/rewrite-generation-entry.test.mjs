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
  stdin: { contents: "export { RewriteInput } from './src/renderer/RewritePanel';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { RewriteInput } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

for (const scenario of [
  { name: '已确认联系人', phase: 'ready', block: null, disabled: false },
  { name: '手动联系人待确认', phase: 'ready', block: 'contact_unconfirmed', disabled: true },
  { name: '生成等待中', phase: 'waiting', block: null, disabled: true },
  { name: '粘贴对方文字但尚未填写方向', phase: 'ready', block: null, disabled: true, pasted: true },
]) test(`${scenario.name}显示文字生成入口并保留原门禁`, () => {
  const contacts = { state: { selectedContactId: 'synthetic-contact', draft: '合成本次输入。', scopeRevision: 1 }, setDraft: async () => {} };
  const replies = { state: { contactId: 'synthetic-contact', scopeRevision: 1, phase: scenario.phase,
    generationBlock: scenario.block, exploration: { phase: 'idle' }, options: {
      tone: 'original', instruction: '', includeRelationshipContext: false,
      ...(scenario.pasted ? { inputKind: 'current_chat', pastedDirection: '' } : {}),
    } }, updateOptions: async () => {}, generate: async () => {} };
  const html = renderToStaticMarkup(React.createElement(RewriteInput, { contacts, replies }));
  assert.match(html, /<span>生成候选<\/span>/);
  const button = html.match(/<button[^>]*aria-label="生成候选"[^>]*>/)?.[0];
  assert.ok(button);
  assert.equal(button.includes('disabled=""'), scenario.disabled);
  assert.equal(html.includes('生成前，请先在上方确认本次联系人。'), Boolean(scenario.block));
  if (scenario.pasted) assert.match(html, /粘贴文字的表达方向/);
});
