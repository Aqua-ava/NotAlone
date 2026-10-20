import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// SSR 只需要具名桥的存在；订阅与命令在浏览器效果中执行。
globalThis.window = { notalone: { styleSamples: {}, expressionPreferences: {} } };
const directory = await mkdtemp(path.join(tmpdir(), 'notalone-workspace-view-'));
after(() => rm(directory, { recursive: true, force: true }));

const bundled = await build({ stdin: { contents: `
  export { UnifiedReplyWorkspace } from './src/renderer/UnifiedReplyWorkspace';
  export { ReplyCandidates } from './src/renderer/RewritePanel';
  export { createElement } from 'react';
  export { renderToStaticMarkup } from 'react-dom/server';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  loader: { '.css': 'empty' },
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const entry = path.join(directory, 'view.mjs');
await writeFile(entry, bundled.outputFiles[0].text);
const view = await import(pathToFileURL(entry).href);
function render({ draft = '', contactId = 'synthetic-contact', ...overrides } = {}) {
  const state = { contactId, scopeRevision: 1, phase: 'idle', mode: 'rewrite_draft', options: {
    tone: 'original', instruction: '', includeRelationshipContext: true, inputKind: 'workspace',
  }, messages: { phase: 'ready', items: [], nextCursor: null }, exploration: { phase: 'idle' }, ...overrides };
  return view.renderToStaticMarkup(view.createElement(view.UnifiedReplyWorkspace, {
    contacts: { state: { selectedContactId: contactId, draft, scopeRevision: 1 } }, replies: { state },
  }));
}

test('没有思路可直接请求建议，表达动作要求输入，不出现旧场景选择', () => {
  const html = render();
  assert.match(html, /aria-label="帮我表达"[^>]*disabled/);
  assert.doesNotMatch(html, /aria-label="帮我想想"[^>]*disabled/);
  assert.match(html, /aria-label="有什么想说的"/);
  assert.doesNotMatch(html, /选择待回复消息|回应消息|主动聊聊|确认方向|表达方向/);
  assert.match(html, /暂无可用的最近聊天/);
});

test('有想法时两种动作都可用，补充聊天单独输入', () => {
  const html = render({ draft: '想关心一下最近的情况' });
  assert.doesNotMatch(html, /aria-label="帮我表达"[^>]*disabled/);
  assert.match(html, /aria-label="补充聊天上下文"/);
  assert.match(html, /想关心一下最近的情况/);
});

test('未确认联系人或生成中不可触发新请求', () => {
  for (const overrides of [{ contactId: null }, { phase: 'waiting' }, { generationBlock: 'unconfirmed' }]) {
    assert.match(render(overrides), /aria-label="帮我想想"[^>]*disabled/);
  }
});

test('最近对话显示时间与可排除材料，不要求单选待回复消息', () => {
  const html = render({ messages: { phase: 'ready', nextCursor: null, items: [{ messageId: 'synthetic-message',
    speaker: 'contact', text: '今天忙完了', occurredAt: '2026-10-19T08:00:00Z' }] } });
  assert.match(html, /今天忙完了/);
  assert.match(html, /type="checkbox"/);
  assert.doesNotMatch(html, /type="radio"/);
  assert.match(html, /最近一条/);
});

test('工作区候选直接展示理由，版本未核验前不开放编辑', () => {
  const candidate = { candidateId: 'synthetic-candidate', text: '最近怎么样？', basis: '从近况开始，方便对方接话。', citationIds: [], riskNotes: [] };
  const state = { contactId: 'synthetic-contact', scopeRevision: 1, phase: 'ready', mode: 'rewrite_draft',
    options: { inputKind: 'workspace', workspaceAction: 'suggest', includeRelationshipContext: true },
    skillChoices: [], exploration: { phase: 'idle', result: null }, messageNotice: { changed: false }, messages: { items: [] },
    savedSession: { phase: 'idle', sessionId: 'synthetic-session', turns: [], inputs: [] },
    result: { replyRequestId: 'synthetic-request', assistantSessionId: 'synthetic-session', contextEvidenceIds: [],
      input: { mode: 'rewrite_draft', inputKind: 'workspace', workspaceAction: 'suggest', draftText: '',
        contactDisplayName: '合成联系人', includeRelationshipContext: true }, candidates: [candidate, { ...candidate, candidateId: 'synthetic-second', text: '忙完了吗？' }].map(original => ({ original, editedText: original.text })) } };
  const html = view.renderToStaticMarkup(view.createElement(view.ReplyCandidates, { replies: { state } }));
  assert.equal((html.match(/>本次参考</g) ?? []).length, 1, '一轮多个候选共用一个参考入口');
  assert.doesNotMatch(html, /class="reply-references"[^>]* open/, '初始默认收起');
  assert.match(html, /为什么这样建议/);
  assert.match(html, /从近况开始，方便对方接话。/);
  assert.match(html, /正在读取本组版本/);
  assert.doesNotMatch(html, /aria-label="候选1编辑文本"/);
});
