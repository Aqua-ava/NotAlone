import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { build } from 'esbuild';

const output = await build({ stdin: { contents: `
  export { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
  export { createElement } from 'react';
  export { renderToStaticMarkup } from 'react-dom/server';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const ports = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
function render(overrides = {}) {
  const turn = { turnId: 'synthetic-turn', inputVersionId: 'synthetic-generation', state: 'completed',
    input: { content: { draft_text: '合成历史输入' } }, reply: { candidates: [{ candidateId: 'synthetic-candidate', text: '合成历史候选' }] },
    placeholder: null, interruptionReason: null };
  const state = { contactId: 'synthetic-contact', scopeRevision: 1, phase: 'ready', exploration: { phase: 'idle' },
    sessionCatalog: { phase: 'ready', items: [{ sessionId: 'synthetic-session', isCurrent: true }] },
    savedSession: { phase: 'ready', sessionId: 'synthetic-session', turns: [turn], inputs: [
      { type: 'generation', inputVersionId: turn.inputVersionId, turnId: turn.turnId },
      { type: 'purpose_exploration', inputVersionId: 'synthetic-direction', content: {
        type: 'purpose_exploration', purposeHint: '合成历史目的', confirmedIntent: '合成已确认方向', skillMode: 'auto' } },
      { type: 'candidate_carry', inputVersionId: 'synthetic-carry', content: { type: 'candidate_carry',
        messages: [{ messageId: 'synthetic-message', text: '合成携入版本' }] } },
    ] }, ...overrides };
  return ports.renderToStaticMarkup(ports.createElement(ports.AssistantSessionPanel, { replies: { state } }));
}

test('历史管理与每条旧记录默认折叠，保留可访问操作和原始内容', () => {
  const html = render();
  assert.match(html, /aria-label="助手会话"/);
  const browser = html.match(/<details[^>]*class="session-browser"[^>]*>/)?.[0];
  assert.ok(browser);
  assert.doesNotMatch(browser, /\bopen(?:=|\s|>)/);
  assert.match(html, /<summary><span>历史讨论<\/span>/);
  const records = [...html.matchAll(/<details[^>]*class="session-entry-details"[^>]*>/g)];
  assert.equal(records.length, 3);
  for (const [record] of records) assert.doesNotMatch(record, /\bopen(?:=|\s|>)/);
  for (const text of ['合成历史输入', '合成历史候选', '合成历史目的', '合成已确认方向', '合成携入版本']) assert.ok(html.includes(text));
  assert.match(html, /aria-label="查看会话 synthetic-session"[^>]*>查看讨论 1<\/button>/);
  assert.match(html, /class="session-metadata"><summary>讨论详情<\/summary>/);
  assert.match(html, /aria-label="助手会话操作"/);
  assert.match(html, /aria-label="当前讨论操作"/);
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
