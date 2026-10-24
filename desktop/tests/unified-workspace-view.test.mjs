import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

// SSR 只需要具名桥的存在；订阅与命令在浏览器效果中执行。
globalThis.window = { notalone: { candidateProvenance: {}, expressionPreferences: {} } };
const directory = await mkdtemp(path.join(tmpdir(), 'notalone-workspace-view-'));
after(() => rm(directory, { recursive: true, force: true }));

const bundled = await build({ stdin: { contents: `
  export { historyReplyEligibility } from './src/shared/history-reply-eligibility';
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
function render({ draft = '', contactId = 'synthetic-contact', historyCoverage, ...overrides } = {}) {
  const state = { contactId, scopeRevision: 1, phase: 'idle', mode: 'rewrite_draft', options: {
    tone: 'original', instruction: '', includeRelationshipContext: true, inputKind: 'workspace',
  }, messages: { phase: 'ready', items: [], nextCursor: null }, exploration: { phase: 'idle' }, ...overrides };
  return view.renderToStaticMarkup(view.createElement(view.UnifiedReplyWorkspace, {
    contacts: { state: { selectedContactId: contactId, draft, scopeRevision: 1 } }, replies: { state }, historyCoverage,
  }));
}

function renderCandidates(usedSkill, restored = false) {
  const contactId = 'synthetic-contact', sessionId = 'synthetic-session', replyRequestId = 'synthetic-request';
  const candidate = { candidateId: 'synthetic-candidate', text: '最近怎么样？', basis: '从近况开始，方便对方接话。',
    citationIds: [], riskNotes: [] };
  const reply = { replyRequestId, assistantSessionId: sessionId, contextEvidenceIds: [], usedSkill,
    input: { mode: 'rewrite_draft', inputKind: 'workspace', workspaceAction: 'suggest', draftText: '',
      contactDisplayName: '合成联系人', includeRelationshipContext: true } };
  const currentReply = { ...reply, candidates: [{ original: candidate, editedText: candidate.text }] };
  const savedReply = { ...reply, candidates: [candidate] };
  const state = { contactId, scopeRevision: 1, phase: 'ready', mode: 'rewrite_draft',
    options: { inputKind: 'workspace', workspaceAction: 'suggest', includeRelationshipContext: true },
    skillChoices: [], exploration: { phase: 'idle', result: null }, messageNotice: { changed: false },
    messages: { phase: 'ready', items: [] }, candidateVersions: { phase: 'loading', items: [] },
    savedSession: restored ? { phase: 'ready', sessionId, currentInputVersionId: null, inputs: [], turns: [{
      turnId: 'synthetic-turn', inputVersionId: 'synthetic-input', requestKey: 'synthetic-key', state: 'completed',
      interruptionReason: null, placeholder: null, input: { content: reply.input }, reply: savedReply,
    }] } : { phase: 'idle', sessionId, turns: [], inputs: [], currentInputVersionId: null },
    result: restored ? null : currentReply };
  return view.renderToStaticMarkup(view.createElement(view.ReplyCandidates, { replies: { state } }));
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

test('当前与重开候选都直接展示实际Skill版本或通用流程', () => {
  const usedSkill = { name: '合成当前对话Skill', versionId: 'synthetic-version-id', versionNumber: 3,
    loadState: 'loaded', scope: { kind: 'contact', contact_id: 'synthetic-contact', scene: null } };
  for (const html of [renderCandidates(usedSkill), renderCandidates(usedSkill, true)]) {
    assert.match(html, /aria-label="本次回复方法"[^>]*>本次实际回复方法：合成当前对话Skill · 版本 3/);
  }
  assert.match(renderCandidates(null), /aria-label="本次回复方法"[^>]*>本次使用通用流程/);
  assert.match(renderCandidates(undefined, true), /aria-label="本次回复方法"[^>]*>本次快照未记录回复方法/);
});

test('历史同步中阻止新候选，不完整状态显示显式继续且不能静默消失', () => {
  const pending = render({ historyCoverage: 'syncing', draft: '合成想法' });
  assert.match(pending, /历史尚未追平/);
  assert.match(pending, /aria-label="帮我想想"[^>]*disabled/);
  const incomplete = render({ historyCoverage: 'incomplete', draft: '合成想法' });
  assert.match(incomplete, /历史覆盖不完整/);
  assert.match(incomplete, /基于已同步部分继续/);
  assert.match(incomplete, /aria-label="帮我想想"[^>]*disabled/);
  assert.doesNotMatch(render({ historyCoverage: 'complete' }), /历史覆盖不完整/);
});

test('状态读取失败保留原警告，明确完整才清除，旧增量不误阻', () => {
  assert.equal(view.historyReplyEligibility(null, 'a', 'incomplete'), 'incomplete');
  const row = phase => ({ contactId: 'a', phase });
  assert.equal(view.historyReplyEligibility({ historyAuthorizationState: 'declined', historyCoverages: [row('not_started')] }, 'a'), undefined);
  assert.equal(view.historyReplyEligibility({ historyAuthorizationState: 'accepted', historyCoverages: [] }, 'a'), 'not_started');
  assert.equal(view.historyReplyEligibility({ historyAuthorizationState: 'accepted', historyCoverages: undefined }, 'a'), 'not_started');
  assert.equal(view.historyReplyEligibility({ historyAuthorizationState: 'accepted', historyCoverages: [{ contactId: 'b', phase: 'complete' }] }, 'a'), 'not_started');
  assert.equal(view.historyReplyEligibility({ historyAuthorizationState: 'accepted', historyCoverages: [row('incomplete'), row('not_started')] }, 'a'), 'not_started');
  assert.equal(view.historyReplyEligibility({ historyCoverages: [row('complete')] }, 'a', 'incomplete'), 'complete');
});
