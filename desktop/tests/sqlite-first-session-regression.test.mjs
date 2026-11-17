import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { build } from 'esbuild';
import { sqliteAssistantFixture } from './fixtures/sqlite-assistant-session.mjs';

function generationCalls(calls) {
  return calls.filter(call => call.method === 'POST' && /\/(?:replies|discussions|reply-candidates)(?:\/|$)/.test(call.path));
}

test('空目录只读打开不创建讨论、不读取退役回复端口', async t => {
  const f = await sqliteAssistantFixture(t, { empty: true });
  assert.equal(f.replies.getState().savedSession.sessionId, null);
  assert.equal(f.calls.every(call => call.method === 'GET'), true);
  assert.equal(f.calls.some(call => /\/(?:selections|replies|generation-receipt)(?:\/|$)/.test(call.path)), false);
});

test('首次明确开始SQLite讨论保留独立想法，不隐式生成', async t => {
  const f = await sqliteAssistantFixture(t, { empty: true });
  f.contacts.setDraft({ ...f.scope(), text: '合成的首次表达想法' });
  await f.bridge.newSavedSession(f.scope());
  assert.equal(f.contacts.getState().draft, '合成的首次表达想法');
  assert.equal(f.replies.getState().savedSession.phase, 'ready');
  assert.deepEqual(f.replies.getState().savedSession.discussionEntries, []);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(generationCalls(f.calls).length, 0);
});

test('空目录页面提供明确开始入口并保留当前草稿', async t => {
  const f = await sqliteAssistantFixture(t, { empty: true });
  f.contacts.setDraft({ ...f.scope(), text: '首次的合成想法' });
  const output = await build({ stdin: { contents: `export { AssistantWorkspaceDraft } from './src/renderer/AssistantWorkspaceDraft'; export { AssistantSessionPanel } from './src/renderer/AssistantSessionPanel';
    export { createElement } from 'react'; export { renderToStaticMarkup } from 'react-dom/server';`, resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'esm', write: false,
    banner: { js: `import { createRequire } from 'node:module'; const require = createRequire(${JSON.stringify(path.join(process.cwd(), 'package.json'))});` } });
  const ports = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
  const contacts = { state: f.contacts.getState() };
  const replies = { state: f.replies.getState() };
  assert.deepEqual(replies.state.savedSession, { phase: 'ready', sessionId: null, discussionEntries: [], runtimeRecovery: 'none' });
  const markup = ports.renderToStaticMarkup(ports.createElement('div', null,
    ports.createElement(ports.AssistantWorkspaceDraft, { contacts, replies }),
    ports.createElement(ports.AssistantSessionPanel, { replies })));
  assert.match(markup, /开始新讨论/); assert.match(markup, /首次的合成想法/);
  assert.doesNotMatch(markup, />帮我表达<|>帮我想想</);
});

test('历史读取失败后明确新开讨论保留独立草稿，只清空原讨论', async t => {
  const f = await sqliteAssistantFixture(t); f.control.failSession = f.sessionId;
  await f.bridge.readSavedSession(f.scope()); assert.equal(f.replies.getState().savedSession.phase, 'failed');
  f.contacts.setDraft({ ...f.scope(), text: '读取失败时新写下的合成想法' });
  await f.bridge.newSavedSession(f.scope()); const state = f.replies.getState();
  assert.notEqual(state.savedSession.sessionId, f.sessionId); assert.equal(state.savedSession.phase, 'ready');
  assert.deepEqual(state.savedSession.discussionEntries, []);
  assert.equal(f.contacts.getState().draft, '读取失败时新写下的合成想法');
  assert.equal(generationCalls(f.calls).length, 0);
});

test('等待讨论读取时编辑的独立想法不会被迟到恢复覆盖', async t => {
  const f = await sqliteAssistantFixture(t), gate = { entered: Promise.withResolvers(), release: Promise.withResolvers() };
  t.after(() => gate.release.resolve()); f.control.readGate = gate;
  f.contacts.setDraft({ ...f.scope(), text: '缓存中的合成旧想法' });
  const reading = f.bridge.readSavedSession(f.scope()); await gate.entered.promise;
  f.contacts.setDraft({ ...f.scope(), text: '等待期间新写下的合成想法' });
  gate.release.resolve(); await reading;
  assert.equal(f.replies.getState().savedSession.phase, 'ready');
  assert.equal(f.contacts.getState().draft, '等待期间新写下的合成想法');
  assert.equal(generationCalls(f.calls).length, 0);
});
