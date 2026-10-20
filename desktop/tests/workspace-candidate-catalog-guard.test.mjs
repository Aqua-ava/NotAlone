import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
const require = createRequire(path.resolve('package.json'));
const bundle = await build({ stdin: { contents: `export { CandidateVersionEditor } from './src/renderer/CandidateVersionEditor';`,
  resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }] });
const { CandidateVersionEditor } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
for (const [name, catalog, blocked] of [
  ['候选已读取但会话目录仍在加载', { phase: 'loading', selectionPending: false }, true],
  ['目录已读取但会话选择仍未完成', { phase: 'ready', selectionPending: true }, true],
  ['会话选择已完成', { phase: 'ready', selectionPending: false }, false],
  ['兼容没有目录状态的旧视图', undefined, false],
]) {
  test(`${name}时编辑与携入采用相同可用边界`, () => {
    const version = { versionId: 'v0', versionNumber: 0, messages: [{ messageId: 'm', text: '合成回复。' }], requirements: null };
    const html = renderToStaticMarkup(React.createElement(CandidateVersionEditor, {
      replies: { state: { contactId: 'contact', scopeRevision: 1, phase: 'idle',
        savedSession: { phase: 'ready', sessionId: 's' }, candidateVersions: { phase: 'ready' }, sessionCatalog: catalog } },
      view: { phase: 'ready', history: { sessionId: 's', candidateId: 'c', versions: [version] }, displayVersionId: 'v0' },
      candidateId: 'c', replyRequestId: 'r', number: 1, restored: true, noteCopy() {},
    }));
    const fieldset = html.match(/<fieldset\b[^>]*>/)?.[0];
    const carry = html.match(/<button\b[^>]*>用这组回复新开会话<\/button>/)?.[0];
    assert(fieldset && carry, '已读候选仍应显示编辑组和携入入口');
    assert.equal(/\bdisabled=""/.test(fieldset), blocked, '消息组只在当前会话选择完成后开放编辑');
    assert.equal(/\bdisabled=""/.test(carry), blocked, '携入不能绕过会话选择门槛');
  });
}
