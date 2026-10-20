import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

test('无联系人资料页仍展示三个精简入口并可进入本人资料', async () => {
  const compiled = await build({ stdin: { contents: `
    import React from 'react';
    import { renderToStaticMarkup } from 'react-dom/server';
    import { MemoryPage } from './src/renderer/MemoryPage';
    export const html = renderToStaticMarkup(<MemoryPage session={{state: {selectedContactId: null, scopeRevision: 0, contacts: []}, error: '', selectContact: async () => {}}} navigate={() => {}} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic', loader: { '.css': 'empty' }, write: false });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const navigation = module.exports.html.match(/<nav[^>]*aria-label="记忆分类"[^>]*>(.*?)<\/nav>/)?.[1];
  assert.ok(navigation);
  assert.deepEqual([...navigation.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map(match => match[1]), ['对方', '我', '待确认']);
});
