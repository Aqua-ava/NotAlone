import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

globalThis.window = { notalone: { styleSamples: {}, expressionPreferences: {} } };
const directory = await mkdtemp(path.join(tmpdir(), 'notalone-generation-guidance-'));
after(() => rm(directory, { recursive: true, force: true }));
const bundle = await build({ stdin: { contents: `
  export { hasChangedReplyInput } from './src/renderer/ReplyGenerationGuidance';
  export { ReplyCandidates } from './src/renderer/RewritePanel';
  export { createElement } from 'react';
  export { renderToStaticMarkup } from 'react-dom/server';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false,
  loader: { '.css': 'empty' },
  banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
const entry = path.join(directory, 'view.mjs');
await writeFile(entry, bundle.outputFiles[0].text);
const view = await import(pathToFileURL(entry).href);
function state() {
  const candidate = { candidateId: 'synthetic-candidate', text: '先按原想法表达。', basis: '按本人想法表达。', citationIds: [], riskNotes: [] };
  return { contactId: 'synthetic-contact', scopeRevision: 1, phase: 'ready', mode: 'rewrite_draft',
    options: { inputKind: 'workspace', workspaceAction: 'express', tone: 'original', instruction: '不增加承诺', includeRelationshipContext: true },
    skillChoices: [], exploration: { phase: 'idle', result: null }, messageNotice: { changed: false }, messages: { items: [] },
    savedSession: { phase: 'idle', sessionId: 'synthetic-session', turns: [], inputs: [] },
    result: { replyRequestId: 'synthetic-request', assistantSessionId: 'synthetic-session', contextEvidenceIds: [],
      input: { mode: 'rewrite_draft', inputKind: 'workspace', workspaceAction: 'express', draftText: '先聊近况',
        userInstruction: '不增加承诺', contactDisplayName: '合成联系人', includeRelationshipContext: true },
      candidates: [{ original: candidate, editedText: candidate.text }] } };
}

test('想法变化提示旧候选；恢复原输入或只改首尾空白不误报', () => {
  const current = state();
  assert.equal(view.hasChangedReplyInput(current, '改聊设备'), true);
  assert.equal(view.hasChangedReplyInput(current, ''), true);
  assert.equal(view.hasChangedReplyInput(current, ' 先聊近况 '), false);
  assert.equal(current.result.input.draftText, '先聊近况');
});

test('本次要求和语气按实际生成指令比较，未变更的非默认语气不误报', () => {
  const current = state();
  current.options.instruction = '简短一点';
  assert.equal(view.hasChangedReplyInput(current, '先聊近况'), true);
  current.options.instruction = '不增加承诺';
  current.options.tone = 'warm';
  assert.equal(view.hasChangedReplyInput(current, '先聊近况'), true);
  current.result.input.userInstruction = '本次语气自然温和。\n不增加承诺';
  assert.equal(view.hasChangedReplyInput(current, '先聊近况'), false);
});

test('帮我想想的问题变化也令旧建议过期，背景排除集合顺序不误报', () => {
  const current = state();
  current.options.workspaceAction = current.result.input.workspaceAction = 'suggest';
  current.options.excludedMessageIds = ['source-b', 'source-a'];
  current.result.input.excludedMessageIds = ['source-a', 'source-b'];
  assert.equal(view.hasChangedReplyInput(current, '先聊近况'), false);
  assert.equal(view.hasChangedReplyInput(current, '怎样聊设备'), true);
  current.options.contextText = '对方提到设备';
  assert.equal(view.hasChangedReplyInput(current, '先聊近况'), true);
});

test('候选公开渲染将当前想法接入旧候选提示，保持原候选和理由', () => {
  const current = state();
  const render = draft => view.renderToStaticMarkup(view.createElement(view.ReplyCandidates,
    { replies: { state: current }, currentDraft: draft }));
  const old = render('改聊设备');
  assert.match(old, /上一组候选，尚未按当前输入重新生成/);
  assert.match(old, /为什么这样建议/);
  assert.doesNotMatch(render('先聊近况'), /上一组候选，尚未按当前输入重新生成/);
});
