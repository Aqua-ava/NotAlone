import { test } from 'node:test';
import assert from 'node:assert/strict';
import { replyWorkspaceFixture as replySceneFixture } from '../fixtures/reply-workspace.mjs';

test('明确场景通过生产回复桥冻结进prepare与执行，同次重试沿原场景而新场景产生新输入', async () => {
  const f = await replySceneFixture();
  try {
    await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
    f.records.failExecution = true;
    await f.bridge.generate({ ...f.scope(), newRequest: false });
    assert.equal(f.replies.getState().phase, 'failed');
    await f.bridge.generate({ ...f.scope(), newRequest: false });
    const requests = f.records.calls.filter(request => request.path.endsWith('/replies'));
    assert.equal(requests[0].body.scene, '核对安排');
    assert.deepEqual(requests[0].body, requests[1].body);
    assert.equal(f.replies.getState().result.input.scene, '核对安排');
    await f.bridge.updateScene({ ...f.scope(), scene: '问候近况' });
    await f.bridge.generate({ ...f.scope(), newRequest: false });
    const latest = f.records.calls.filter(request => request.path.endsWith('/replies')).at(-1);
    assert.equal(latest.body.scene, '问候近况');
    assert.notEqual(latest.body.idempotency_key, requests[0].body.idempotency_key);
    assert.equal(f.replies.getState().result.input.scene, '问候近况');
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

for (const transition of ['编辑场景', '切换联系人', '后端重连']) {
  test(`${transition}后旧场景的迟到生成不能进入当前候选`, async () => {
    const f = await replySceneFixture();
    const barrier = Promise.withResolvers(), entered = Promise.withResolvers();
    try {
      await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
      f.records.executionBarrier = barrier; f.records.executionEntered = entered;
      const generating = f.bridge.generate({ ...f.scope(), newRequest: false });
      await entered.promise;
      if (transition === '编辑场景') await f.bridge.updateScene({ ...f.scope(), scene: '问候近况' });
      else if (transition === '切换联系人') f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.scope().scopeRevision });
      else { f.records.generation = 2; for (const listener of f.backendListeners) listener(); }
      barrier.resolve(); await generating;
      assert.equal(f.replies.getState().result, null);
      assert.equal(f.replies.getState().scene, transition === '编辑场景' ? '问候近况' : '');
    } finally { barrier.resolve(); await f.replies.beginGenerationClosing(() => {}); }
  });
}

test('自动方向讨论不沿用输入框旧场景，历史显式场景仍可读取', async () => {
  const f = await replySceneFixture();
  try {
    await f.bridge.explore(f.scope());
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().savedSession.phase, 'ready');
    await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
    await f.bridge.explore(f.scope());
    await f.bridge.readSavedSession(f.scope());
    const saved = f.replies.getState().savedSession;
    assert.equal(saved.phase, 'ready');
    assert.equal(saved.inputs.at(-1).content.skillScene, undefined);
    f.records.discussions.at(-1).content.skill_scene = '历史明确场景';
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().savedSession.inputs.at(-1).content.skillScene, '历史明确场景');
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('中断重试重建权威原场景并保留当前新输入，恢复请求不能夹带编辑场景', async () => {
  const f = await replySceneFixture();
  try {
    await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
    await f.bridge.generate({ ...f.scope(), newRequest: false });
    const original = f.records.entries[0]; original.completed = false; original.interrupted = true;
    await f.bridge.readSavedSession(f.scope());
    await f.bridge.updateScene({ ...f.scope(), scene: '问候近况' });
    await f.bridge.retryInterruptedGeneration({ ...f.scope(), sessionId: f.replies.getState().savedSession.sessionId,
      turnId: original.turnId, inputVersionId: original.inputId });
    assert.equal(f.replies.getState().phase, 'ready');
    assert.equal(f.replies.getState().result.input.scene, '核对安排');
    assert.equal(f.replies.getState().scene, '问候近况');
    const recovering = f.records.calls.filter(request => request.path.includes('/retry-interrupted'));
    assert.equal(recovering.length, 2);
    assert(recovering.every(request => !Object.hasOwn(request.body, 'scene')));
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('连续修改沿权威原场景生成并展示，当前新场景不会套到旧输入', async () => {
  const f = await replySceneFixture();
  try {
    await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
    await f.bridge.generate({ ...f.scope(), newRequest: false });
    await f.bridge.readSavedSession(f.scope());
    await f.bridge.updateScene({ ...f.scope(), scene: '问候近况' });
    await f.bridge.continueSession({ ...f.scope(), sessionId: f.replies.getState().savedSession.sessionId, instruction: '简短一点' });
    assert.equal(f.replies.getState().continuation.phase, 'completed');
    assert.equal(f.replies.getState().result.input.scene, '核对安排');
    assert.equal(f.replies.getState().scene, '问候近况');
    const continuing = f.records.calls.filter(request => request.path.includes('/continue'));
    assert.equal(continuing.length, 2);
    assert(continuing.every(request => !Object.hasOwn(request.body, 'scene')));
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('联系人往返恢复各自精确场景，后端重连先清缓存且未声明场景保持缺省行为', async () => {
  const f = await replySceneFixture();
  try {
    await f.bridge.generate({ ...f.scope(), newRequest: false });
    assert.equal(Object.hasOwn(f.records.calls.find(request => request.path.endsWith('/replies')).body, 'scene'), false);
    await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
    f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().scene, '');
    await f.bridge.updateScene({ ...f.scope(), scene: '问候近况' });
    f.contacts.selectContact({ contactId: f.contactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().scene, '核对安排');
    f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().scene, '问候近况');
    f.records.generation = 2;
    for (const listener of f.backendListeners) listener();
    assert.equal(f.replies.getState().scene, '');
    await assert.rejects(f.bridge.updateScene({ ...f.scope(), scene: '核对安排', owner_id: f.contactId }));
    await assert.rejects(f.bridge.updateScene({ ...f.scope(), scene: '长'.repeat(257) }));
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('自动方向探索不将旧输入场景当成方法权限，编辑后重新建立探索任务', async () => {
  const f = await replySceneFixture();
  try {
    await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
    await f.bridge.explore(f.scope());
    const first = f.records.calls.find(request => request.path.endsWith('/explorations'));
    assert.equal(Object.hasOwn(first.body.content, 'skill_scene'), false);
    assert.equal(first.body.content.type, 'purpose_exploration');
    assert.equal(f.replies.getState().exploration.phase, 'ready');
    await f.bridge.updateScene({ ...f.scope(), scene: '问候近况' });
    assert.equal(f.replies.getState().exploration.result, null);
    await f.bridge.explore(f.scope());
    const second = f.records.calls.filter(request => request.path.endsWith('/explorations')).at(-1);
    assert.equal(Object.hasOwn(second.body.content, 'skill_scene'), false);
    assert.notEqual(second.body.operation_key, first.body.operation_key);
    assert.equal(second.body.previous_id, null);
  } finally { await f.replies.beginGenerationClosing(() => {}); }
});

test('甲任务在乙展示时完成，往返恢复甲的原场景及权威结果且不重复生成', async () => {
  const f = await replySceneFixture(), barrier = Promise.withResolvers(), entered = Promise.withResolvers();
  try {
    await f.bridge.updateScene({ ...f.scope(), scene: '核对安排' });
    f.records.executionBarrier = barrier; f.records.executionEntered = entered;
    const generating = f.bridge.generate({ ...f.scope(), newRequest: false });
    await entered.promise;
    f.contacts.selectContact({ contactId: f.otherContactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    await f.bridge.updateScene({ ...f.scope(), scene: '问候近况' });
    barrier.resolve(); await generating;
    assert.equal(f.replies.getState().result, null);
    assert.equal(f.replies.getState().scene, '问候近况');
    f.contacts.selectContact({ contactId: f.contactId, scopeRevision: f.scope().scopeRevision });
    await f.bridge.readSavedSession(f.scope());
    assert.equal(f.replies.getState().scene, '核对安排');
    assert.equal(f.replies.getState().result.input.scene, '核对安排');
    assert.equal(f.records.calls.filter(request => request.path.endsWith('/replies/prepare')).length, 1);
    assert.equal(f.records.calls.filter(request => request.path.endsWith('/replies')).length, 1);
  } finally { barrier.resolve(); await f.replies.beginGenerationClosing(() => {}); }
});
