import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const output = await build({ stdin: { contents: `
  export { AssistantSessionPanel, AssistantSessionDeletionConfirmation } from './src/renderer/AssistantSessionPanel';
  export { createElement } from 'react';
  export { renderToStaticMarkup } from 'react-dom/server';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const ports = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
function render(overrides = {}) {
  globalThis.window = { notalone: { sqliteDiscussion: {} } };
  const state = { contactId: 'synthetic-contact', scopeRevision: 1, phase: 'idle',
    sessionCatalog: { phase: 'ready', currentSessionId: 'synthetic-session', items: [{ sessionId: 'synthetic-session', isCurrent: true }] },
    savedSession: { phase: 'ready', sessionId: 'synthetic-session', runtimeRecovery: 'ready', discussionEntries: [
      { entryId: 'synthetic-user', position: '1', role: 'user', text: '合成历史输入', requestId: 'synthetic-request', callId: null, contentState: 'available' },
      { entryId: 'synthetic-assistant', position: '2', role: 'assistant', text: '合成历史讨论', requestId: 'synthetic-request', callId: null, contentState: 'available' },
    ] }, ...overrides };
  return ports.renderToStaticMarkup(ports.createElement(ports.AssistantSessionPanel, { replies: { state } }));
}

test('SQLite历史管理默认折叠，保留原始发言及可访问操作', () => {
  const html = render();
  assert.match(html, /aria-label="助手会话"/);
  const browser = html.match(/<details[^>]*class="session-browser"[^>]*>/)?.[0];
  assert.ok(browser); assert.doesNotMatch(browser, /\bopen(?:=|\s|>)/);
  assert.match(html, /<summary><span>历史讨论<\/span>/);
  assert.ok(html.includes('合成历史输入')); assert.ok(html.includes('合成历史讨论'));
  assert.match(html, /aria-label="查看会话 synthetic-session"[^>]*>查看讨论 1<\/button>/);
  assert.match(html, /aria-label="助手会话操作"/);
  assert.match(html, /aria-label="正在查看的讨论操作"/);
});

test('历史讨论明确标注仅回看，当前历史与正在查看状态可区分，只有历史项提供继续', () => {
  globalThis.window = { notalone: { sqliteDiscussion: {} } };
  const currentId = 'synthetic-current', historyId = 'synthetic-history';
  const html = render({
    sessionCatalog: { phase: 'ready', currentSessionId: currentId, items: [
      { sessionId: currentId, isCurrent: true }, { sessionId: historyId, isCurrent: false },
    ] },
    savedSession: { phase: 'ready', sessionId: historyId, runtimeRecovery: 'ready', discussionEntries: [{ entryId: 'synthetic-entry', position: '1', role: 'assistant',
        text: '合成历史讨论正文', requestId: 'synthetic-request', callId: null, contentState: 'available' }] },
  });
  assert.match(html, /仅回看，不会自动加入新候选/);
  assert.match(html, /历史讨论仅回看，不会自动加入新候选；继续此讨论后才切换当前讨论/);
  const catalog = html.match(/<ul[^>]*aria-label="助手会话目录"[^>]*>[\s\S]*?<\/ul>/)?.[0];
  assert.ok(catalog);
  assert.match(catalog, /当前讨论/);
  assert.match(catalog, /历史讨论 · 仅回看/);
  assert.match(catalog, /正在回看/);
  const current = catalog.match(/<li[^>]*>[\s\S]*?synthetic-current[\s\S]*?<\/li>/)?.[0];
  const history = catalog.match(/<li[^>]*>[\s\S]*?synthetic-history[\s\S]*?<\/li>/)?.[0];
  assert.ok(current); assert.ok(history);
  assert.doesNotMatch(current, /继续此讨论/);
  assert.match(history, /继续此讨论/);
  assert.match(html, /aria-label="正在查看的讨论操作"[\s\S]*?class="button"[^>]*>继续此讨论<\/button>/);
  assert.match(html, /class="button"[^>]*>删除正在查看的讨论<\/button>/);
});

test('删除失败和读取失败提示保留在折叠历史之外，用户无需展开即可发现', () => {
  const html = render({ sessionDeletion: 'failed', savedSession: { phase: 'failed', sessionId: 'synthetic-session' } });
  const historyStart = html.indexOf('<details class="session-browser">');
  assert.ok(historyStart > 0);
  const visibleStatus = html.slice(0, historyStart);
  assert.match(visibleStatus, /role="alert">助手会话删除尚未确认完成/);
  assert.match(visibleStatus, /role="alert">已保存讨论暂不可用/);
  assert.match(visibleStatus, /重试删除会话/);
});

test('删除确认明确只删除讨论候选和运行痕迹，不删除聊天关系记忆本人记忆或联系人', () => {
  const html = ports.renderToStaticMarkup(ports.createElement(ports.AssistantSessionDeletionConfirmation,
    { busy: false, onConfirm() {}, onCancel() {} }));
  assert.match(html, /role="group" aria-label="确认删除助手讨论"/);
  assert.match(html, /删除这段助手讨论、候选版本和运行使用痕迹后无法恢复/);
  assert.match(html, /联系人、原始微信聊天、关系记忆和本人记忆不会删除/);
  assert.match(html, /class="button"[^>]*>确认删除讨论<\/button>/);
  assert.match(html, /class="button"[^>]*>取消删除<\/button>/);
});
