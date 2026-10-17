import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { fixture, profilePayload } from './support.mjs';

test('当前资料面板为每段及每项分别提供总结和实际事实纠错', async () => {
  const compiled = await build({ stdin: { contents: `
    import React from 'react'; import { renderToStaticMarkup } from 'react-dom/server';
    import { LayeredMemoryPanel } from './src/renderer/LayeredMemoryPanel';
    export const render = state => renderToStaticMarkup(<LayeredMemoryPanel state={state} contactName="合成联系人" busy={false} read={async () => {}} manage={async () => {}} facts={() => {}} />);
  `, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, packages: 'external', platform: 'node', format: 'cjs', jsx: 'automatic', write: false });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const f = await fixture(async () => ({ generation: 1, data: profilePayload() }));
  await f.bridge.readLayeredMemory(f.selection());
  const html = module.exports.render((await f.bridge.getState()).layeredMemory);
  assert.equal((html.match(/>总结有误<\/button>/g) ?? []).length, 2);
  assert.equal((html.match(/>事实有误：修正此条<\/button>/g) ?? []).length, 2);
  assert.match(html, /补充背景请通过底层记忆的手动录入/);
  f.disconnect();
});
