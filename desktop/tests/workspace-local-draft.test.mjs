import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
const bundle = await build({ stdin: { contents: `
  export { AssistantWorkspaceDraft } from './src/renderer/AssistantWorkspaceDraft';
  export { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
  export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(process.cwd() + '/package.json')});` } });
const { AssistantWorkspaceDraft, AssistantSessionPanel, createElement, renderToStaticMarkup } =
  await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function render(overrides = {}, contactOverrides = {}) {
  const contacts = { state: { selectedContactId: 'contact-b', scopeRevision: 2, draft: '乙的独立想法', ...contactOverrides } };
  const replies = { state: { contactId: 'contact-b', scopeRevision: 2, generationBlock: 'foreground-confirmation-required',
    savedSession: { phase: 'failed', sessionId: 'session-b' }, ...overrides } };
  return renderToStaticMarkup(createElement('div', null,
    createElement(AssistantWorkspaceDraft, { contacts, replies }), createElement(AssistantSessionPanel, { replies })));
}
function verify(html, editable) {
  const editor = html.match(/<textarea\b[^>]*aria-label="有什么想说的"[^>]*>/)?.[0];
  assert.ok(editor, '准备期始终显示独立想法');
  if (editable) assert.doesNotMatch(editor, /\bdisabled=/); else assert.match(editor, /\bdisabled=/);
  assert.doesNotMatch(html, /aria-label="帮我表达"|aria-label="帮我想想"/, '讨论未就绪时不开放候选生成');
}

test('待确认只阻止生成，已选联系人仍可编辑独立想法', () => {
  const html = render(); verify(html, true); assert.match(html, /乙的独立想法/);
});
for (const phase of ['loading', 'failed']) test(`当前讨论${phase}时保留独立想法，不隐式生成`, () => {
  verify(render({ generationBlock: null, savedSession: { phase, sessionId: 'session-b' } }), true);
});
test('空目录的SQLite就绪快照仍保留独立想法与明确开始入口', () => {
  const html = render({ generationBlock: null, savedSession: { phase: 'ready', sessionId: null, discussionEntries: [], runtimeRecovery: 'none' } });
  verify(html, true); assert.match(html, />开始新讨论<\/button>/);
});
test('历史讨论读取失败不消耗独立想法，恢复入口只执行明确动作', () => {
  const html = render({ generationBlock: null, savedSession: { phase: 'failed', sessionId: 'historical-session' },
    sessionCatalog: { phase: 'ready', currentSessionId: 'current-session', items: [], selectionPending: false } });
  verify(html, true); assert.match(html, /已保存讨论暂不可用/);
  for (const label of ['重新核对讨论', '开始新讨论']) {
    const button = html.match(new RegExp(`<button\\b[^>]*>${label}<\\/button>`))?.[0];
    assert.ok(button, label); assert.doesNotMatch(button, /\bdisabled=/);
  }
});
for (const overrides of [{ contactId: 'contact-a' }, { scopeRevision: 1 }, { sessionDeletion: 'deleting' }, { sessionDeletion: 'failed' }]) {
  test(`范围不符或删除待核验不开放独立草稿：${JSON.stringify(overrides)}`, () => verify(render(overrides), false));
}
for (const sourceAvailability of ['checking', 'failed']) test(`来源${sourceAvailability}不把独立想法变成来源派生资料`, () => {
  verify(render({ sourceAvailability }), true);
});
