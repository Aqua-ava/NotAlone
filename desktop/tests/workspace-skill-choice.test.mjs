import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { replyWorkspaceFixture } from './fixtures/reply-workspace.mjs';

for (const action of ['express', 'suggest']) for (const mode of ['user', 'disabled']) {
  test(`工作区${action}冻结${mode}选择，失败重试、续改和中断恢复不改选`, async () => {
    const f = await replyWorkspaceFixture();
    try {
      const choice = { mode, versionId: mode === 'user' ? randomUUID() : null };
      await f.bridge.enterWorkspace(f.scope());
      f.contacts.setDraft({ ...f.scope(), text: '本次明确的合成想法。' });
      await f.bridge.updateSkill({ ...f.scope(), skill: choice });
      f.records.failExecution = true;
      await f.bridge.generate({ ...f.scope(), newRequest: true, workspaceAction: action });
      const first = f.records.calls.find(call => call.path.endsWith('/replies')).body;
      assert.equal(first.skill_version_id, choice.versionId ?? undefined);
      assert.equal(first.skill_disabled, mode === 'disabled' ? true : undefined);
      assert.equal(f.replies.getState().phase, 'failed');
      await f.bridge.generate({ ...f.scope(), newRequest: false });
      assert.equal(f.replies.getState().phase, 'ready');
      const calls = f.records.calls.filter(call => call.path.endsWith('/replies'));
      assert.deepEqual(calls[0].body, calls[1].body);
      assert.deepEqual(f.replies.getState().result.input.skillChoice, choice);
      await f.bridge.updateSkill({ ...f.scope(), skill: { mode: 'auto', versionId: null } });
      await f.bridge.readSavedSession(f.scope());
      await f.bridge.continueSession({ ...f.scope(), sessionId: f.replies.getState().savedSession.sessionId, instruction: '简短一点' });
      assert.equal(f.replies.getState().continuation.phase, 'completed');
      assert.deepEqual(f.replies.getState().result.input.skillChoice, choice);
      const entry = f.records.entries.at(-1); entry.completed = false; entry.interrupted = true;
      await f.bridge.readSavedSession(f.scope());
      await f.bridge.retryInterruptedGeneration({ ...f.scope(), sessionId: f.replies.getState().savedSession.sessionId,
        turnId: entry.turnId, inputVersionId: entry.inputId });
      assert.equal(f.replies.getState().phase, 'ready');
      assert.deepEqual(f.replies.getState().result.input.skillChoice, choice);
    } finally { await f.replies.beginGenerationClosing(() => {}); }
  });
}

test('兼容纯改写入口保持原Skill声明，工作区选择不改变旧协议', async () => {
  const f = await replyWorkspaceFixture();
  try {
    await f.bridge.setMode({ ...f.scope(), mode: 'rewrite_draft' });
    f.contacts.setDraft({ ...f.scope(), text: '旧改写的合成草稿。' });
    await f.bridge.updateSkill({ ...f.scope(), skill: { mode: 'user', versionId: randomUUID() } });
    await f.bridge.generate({ ...f.scope(), newRequest: true });
    const body = f.records.calls.find(call => call.path.endsWith('/replies')).body;
    assert.equal(body.skill_version_id, undefined);
    assert.equal(body.skill_disabled, undefined);
    assert.equal(f.replies.getState().result.input.skillChoice, undefined);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});
