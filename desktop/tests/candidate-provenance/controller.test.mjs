import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents: `
  export { CandidateProvenanceController } from './src/main/candidate-provenance/controller';
  export { installCandidateProvenanceBridge } from './src/main/candidate-provenance/bridge';
  export { createCandidateProvenanceBridge } from './src/preload/candidate-provenance';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
function fixture() {
  let generation = 1;
  const contactId = randomUUID(), requestId = randomUUID(), candidateId = randomUUID(), sessionId = randomUUID();
  const contactsState = { selectedContactId: contactId, scopeRevision: 1, directoryPhase: 'ready', contacts: [{ contactId }] };
  const listeners = new Set();
  const state = { revision: 1, contactId, scopeRevision: 1, phase: 'ready',
    result: { replyRequestId: requestId, assistantSessionId: sessionId, input: { mode: 'rewrite_draft' },
      candidates: [{ original: { candidateId, text: '合成候选原文。' }, editedText: '合成候选原文。' }] },
    savedSession: { phase: 'ready', sessionId, turns: [] } };
  const backend = { getConnectionGeneration: () => generation, onStateChanged: () => {} };
  const contacts = { getState: () => contactsState, onStateChanged: () => {} };
  const replies = { getState: () => state, onStateChanged: listener => listeners.add(listener) };
  const controller = new api.CandidateProvenanceController(backend, contacts, replies);
  const selection = { contactId, scopeRevision: 1, replyRequestId: requestId, candidateId };
  return { controller, selection, state, contactsState, backend, contacts, replies,
    publish: () => { state.revision++; for (const listener of listeners) listener(); }, reconnect: () => generation++ };
}

test('候选仍可复制和编辑，独立新文字不创建长期资料', () => {
  const f = fixture(), text = f.state.result.candidates[0].editedText;
  f.controller.noteCandidateCopy({ ...f.selection, text });
  assert.doesNotThrow(() => f.controller.validateCandidatePaste({ ...f.selection, text }));
  assert.doesNotThrow(() => f.controller.validateCandidatePaste({ ...f.selection, text: '用户新写的独立说法。' }));
  assert.equal('saveCandidate' in f.controller, false);
  assert.equal('saveManual' in f.controller, false);
});

test('已明确复制的内容不能粘贴到另一联系人、候选或连接代际', () => {
  for (const kind of ['candidate', 'contact', 'connection']) {
    const f = fixture(), text = f.state.result.candidates[0].editedText;
    f.controller.noteCandidateCopy({ ...f.selection, text });
    const next = { ...f.selection };
    if (kind === 'candidate') {
      next.candidateId = randomUUID(); f.state.result.candidates[0].original.candidateId = next.candidateId;
    } else if (kind === 'contact') {
      next.contactId = randomUUID(); next.scopeRevision++;
      f.contactsState.selectedContactId = next.contactId; f.contactsState.scopeRevision = next.scopeRevision;
      f.contactsState.contacts.push({ contactId: next.contactId });
      f.state.contactId = next.contactId; f.state.scopeRevision = next.scopeRevision;
    } else f.reconnect();
    f.publish();
    assert.throws(() => f.controller.validateCandidatePaste({ ...next, text }), /其他来源|已变化/);
  }
});

test('来源失效与已确认会话删除后不能把旧复制文本带入新候选', () => {
  for (const kind of ['source', 'session']) {
    const f = fixture(), text = f.state.result.candidates[0].editedText;
    f.controller.noteCandidateCopy({ ...f.selection, text });
    if (kind === 'source') f.controller.invalidateSource();
    else {
      f.state.confirmedSessionDeletion = { contactId: f.selection.contactId, scopeRevision: 1,
        connectionGeneration: 1, sessionId: f.state.result.assistantSessionId, revision: 2 };
      f.publish();
    }
    const next = { ...f.selection, candidateId: randomUUID(), replyRequestId: randomUUID() };
    f.state.result = { replyRequestId: next.replyRequestId, input: { mode: 'rewrite_draft' },
      candidates: [{ original: { candidateId: next.candidateId, text: '新的合成候选。' }, editedText: '新的合成候选。' }] };
    f.publish();
    assert.throws(() => f.controller.validateCandidatePaste({ ...next, text }), /来源已失效/);
    assert.doesNotThrow(() => f.controller.validateCandidatePaste({ ...next, text: '独立编辑。' }));
  }
});

test('复制校验失败仍拒绝随后粘贴，已恢复版本按受信身份校验', () => {
  const f = fixture();
  assert.throws(() => f.controller.noteCandidateCopy({ ...f.selection, text: '未核验的混合选区', invalidSelection: true }));
  assert.throws(() => f.controller.validateCandidatePaste({ ...f.selection, text: '未核验的混合选区' }));
  const sessionId = f.state.savedSession.sessionId, turnId = randomUUID(), versionId = randomUUID();
  f.state.savedSession.turns = [{ turnId, state: 'completed', reply: { replyRequestId: f.selection.replyRequestId,
    candidates: [{ candidateId: f.selection.candidateId, text: '合成候选原文。' }] } }];
  f.state.candidateVersions = { phase: 'ready', sessionId, items: [{ phase: 'ready', candidateId: f.selection.candidateId,
    displayVersionId: versionId, history: { sessionId, turnId, candidateId: f.selection.candidateId,
      candidateGroupId: f.selection.replyRequestId, versions: [{ versionId, text: '已恢复的修改版本。' }] } }] };
  f.state.result = null; f.publish();
  f.controller.noteCandidateCopy({ ...f.selection, text: '已恢复的修改版本。' });
  assert.doesNotThrow(() => f.controller.validateCandidatePaste({ ...f.selection, sessionId, versionId, text: '已恢复的修改版本。' }));
  assert.throws(() => f.controller.validateCandidatePaste({ ...f.selection, sessionId, versionId: randomUUID(), text: '独立编辑' }));
  f.state.savedSession.turns[0].state = 'redacted'; f.publish();
  assert.throws(() => f.controller.validateCandidatePaste({ ...f.selection, sessionId, versionId, text: '已恢复的修改版本。' }));
});

test('公开桥只提供复制来源登记和粘贴复验，无收藏或样本通道', async () => {
  const f = fixture(), handlers = new Map();
  api.installCandidateProvenanceBridge({ handle: (name, callback) => handlers.set(name, callback) }, f.backend, f.contacts, f.replies);
  assert.deepEqual([...handlers.keys()], ['candidate-provenance:note-copy', 'candidate-provenance:validate-paste']);
  const bridge = api.createCandidateProvenanceBridge({ invoke: (name, ...args) => Promise.resolve().then(() => handlers.get(name)(...args)) });
  await bridge.noteCandidateCopy({ ...f.selection, text: '合成候选原文。' });
  await bridge.validateCandidatePaste({ ...f.selection, text: '合成候选原文。' });
  await assert.rejects(bridge.validateCandidatePaste({ ...f.selection, sessionId: randomUUID(), text: '片段' }));
});
