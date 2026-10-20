import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const bundle = await build({ stdin: { contents: `
  export { UnifiedReplyWorkspace } from './src/renderer/UnifiedReplyWorkspace';
  export { createElement } from 'react';
  export { renderToStaticMarkup } from 'react-dom/server';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(process.cwd() + '/package.json')});` } });
// React 的服务端入口只在编译时解析依赖，渲染不执行订阅和生成命令。
const { UnifiedReplyWorkspace, createElement, renderToStaticMarkup } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const options = { inputKind: 'workspace', tone: 'original', instruction: '', includeRelationshipContext: true };
function render(overrides = {}, contactOverrides = {}) {
  return renderToStaticMarkup(createElement(UnifiedReplyWorkspace, {
    contacts: { state: { selectedContactId: 'contact-b', scopeRevision: 2, draft: '乙的本地草稿', ...contactOverrides } },
    replies: { state: { contactId: 'contact-b', scopeRevision: 2, phase: 'idle', mode: 'rewrite_draft', options,
      generationBlock: 'foreground-confirmation-required', savedSession: { phase: 'ready', sessionId: 'session-b' },
      messages: { phase: 'idle', items: [] }, ...overrides } },
  }));
}
function verify(html, editable) {
  const editor = html.match(/<textarea\b[^>]*aria-label="有什么想说的"[^>]*>/)?.[0];
  if (editable) { assert(editor, '本地草稿应可见'); assert.doesNotMatch(editor, /\bdisabled=/); }
  else if (editor) assert.match(editor, /\bdisabled=/);
  for (const action of ['帮我表达', '帮我想想']) assert.match(html, new RegExp(`aria-label="${action}"[^>]*disabled`));
}
test('暂停或待人工确认仅阻止生成，不阻止已选联系人的本地草稿', () => {
  const html = render(); verify(html, true); assert.match(html, /乙的本地草稿/);
});
test('新联系人默认会话读取失败时允许独立本地草稿，仍禁止两个生成动作', () => {
  verify(render({ options: { ...options, inputKind: undefined }, savedSession: { phase: 'failed', sessionId: null }, result: null }), true);
});
for (const [name, overrides] of [
  ['工作区重新读取会话', { savedSession: { phase: 'loading', sessionId: 'session-b' } }],
  ['工作区正在切换目录', { sessionCatalog: { phase: 'loading' } }],
  ['工作区会话选择未完成', { sessionCatalog: { phase: 'ready', selectionPending: true } }],
]) test(`${name}时仍需等待，不能借生成资格分离开放草稿`, () => verify(render(overrides), false));
for (const [name, overrides] of [
  ['仍在读取', { savedSession: { phase: 'loading', sessionId: null } }],
  ['持有待恢复会话', { savedSession: { phase: 'failed', sessionId: 'old-session' } }],
  ['旧对方消息输入', { options: { ...options, inputKind: 'current_chat' } }],
  ['旧联系人状态', { contactId: 'contact-a' }],
  ['旧范围状态', { scopeRevision: 1 }],
  ['正在核验来源', { sourceAvailability: 'checking' }],
  ['正在删除', { sessionDeletion: 'deleting' }],
  ['仍在生成', { phase: 'waiting' }],
]) {
  test(`${name}不能借本地草稿入口跳过恢复或范围隔离`, () => verify(render({
    options: { ...options, inputKind: undefined }, savedSession: { phase: 'failed', sessionId: null }, result: null, ...overrides,
  }), false));
}
