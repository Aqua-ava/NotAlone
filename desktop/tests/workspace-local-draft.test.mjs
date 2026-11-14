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
const options = { inputKind: 'workspace', includeRelationshipContext: true };
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
test('已确认联系人读取已有讨论时可以先写独立想法，生成仍等待讨论就绪', () => {
  verify(render({ generationBlock: null, options: { ...options, inputKind: undefined },
    savedSession: { phase: 'loading', sessionId: 'session-b' }, result: null }), true);
});
test('讨论读取失败后保留独立想法并提供重试或开始新讨论', () => {
  const html = render({ generationBlock: null, options: { ...options, inputKind: undefined },
    savedSession: { phase: 'failed', sessionId: 'session-b' }, result: null });
  verify(html, true);
  assert.match(html, /上次的助手讨论暂时无法加载/);
  assert.match(html, />重新读取助手会话<\/button>/);
  assert.match(html, />开始新讨论<\/button>/);
  assert.doesNotMatch(html, /正在恢复|正在加载/);
});
test('历史讨论读取失败仍可重试或明确新开，历史输入和生成继续只读', () => {
  const html = render({ generationBlock: null,
    savedSession: { phase: 'failed', sessionId: 'historical-session' },
    sessionCatalog: { phase: 'ready', currentSessionId: 'current-session', selectionPending: false } });
  verify(html, false);
  for (const label of ['重新读取助手会话', '开始新讨论']) {
    const button = html.match(new RegExp(`<button\\b[^>]*>${label}<\\/button>`))?.[0];
    assert(button, `应提供${label}入口`);
    assert.doesNotMatch(button, /\bdisabled=/, `${label}不应被历史讨论只读状态阻断`);
  }
});
for (const [name, overrides] of [
  ['仍在生成', { phase: 'waiting' }],
  ['目录正在切换', { sessionCatalog: { phase: 'loading', currentSessionId: 'current-session' } }],
  ['会话选择尚未确认', { sessionCatalog: { phase: 'ready', currentSessionId: 'current-session', selectionPending: true } }],
  ['来源正在核验', { sourceAvailability: 'checking' }],
  ['来源核验失败', { sourceAvailability: 'failed' }],
  ['正在删除', { sessionDeletion: 'deleting' }],
  ['删除尚未确认', { sessionDeletion: 'failed' }],
]) test(`${name}时历史讨论的恢复入口仍须等待`, () => {
  const html = render({ generationBlock: null,
    savedSession: { phase: 'failed', sessionId: 'historical-session' },
    sessionCatalog: { phase: 'ready', currentSessionId: 'current-session', selectionPending: false }, ...overrides });
  for (const label of ['重新读取助手会话', '开始新讨论']) {
    assert.match(html, new RegExp(`<button\\b[^>]*disabled[^>]*>${label}<\\/button>`));
  }
});
test('历史讨论失败且联系人待确认时允许重读，但不允许新开或生成', () => {
  const html = render({ savedSession: { phase: 'failed', sessionId: 'historical-session' },
    sessionCatalog: { phase: 'ready', currentSessionId: 'current-session', selectionPending: false } });
  verify(html, false);
  const reread = html.match(/<button\b[^>]*>重新读取助手会话<\/button>/)?.[0];
  assert(reread); assert.doesNotMatch(reread, /\bdisabled=/);
  assert.match(html, /<button\b[^>]*disabled[^>]*>开始新讨论<\/button>/);
});
test('只有读取中的讨论显示加载提示，输入仍可编辑', () => {
  const html = render({ savedSession: { phase: 'loading', sessionId: 'session-b' } });
  verify(html, true);
  assert.equal(html.includes('正在加载上次的助手讨论…'), true);
  assert.equal(html.includes('正在恢复'), false);
});
for (const [name, overrides] of [
  ['工作区正在切换目录', { sessionCatalog: { phase: 'loading' } }],
  ['工作区会话选择未完成', { sessionCatalog: { phase: 'ready', selectionPending: true } }],
]) test(`${name}时仍需等待，不能借生成资格分离开放草稿`, () => verify(render(overrides), false));
for (const [name, overrides] of [
  ['旧对方消息输入', { options: { ...options, inputKind: 'current_chat' } }],
  ['旧联系人状态', { contactId: 'contact-a' }],
  ['旧范围状态', { scopeRevision: 1 }],
  ['正在核验来源', { sourceAvailability: 'checking' }],
  ['正在删除', { sessionDeletion: 'deleting' }],
  ['删除尚未核验完成', { sessionDeletion: 'failed' }],
  ['仍在生成', { phase: 'waiting' }],
]) {
  test(`${name}不能借本地草稿入口跳过恢复或范围隔离`, () => verify(render({
    options: { ...options, inputKind: undefined }, savedSession: { phase: 'failed', sessionId: null }, result: null, ...overrides,
  }), false));
}
