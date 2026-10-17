import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withPreferenceBackend } from './http-support.mjs';

test('当前生产控制器仅通过选中联系人的 HTTP 范围读取本人全局和该联系人正文，恢复仍保持范围', { timeout: 30000 }, async () => {
  await withPreferenceBackend(async ({ ExpressionPreferenceController, backend, contacts, selection, client, select, contactIds }) => {
    const [first, second] = contactIds;
    for (const [contactId, text] of [[null, '本人全局合成要求。'], [first, '甲联系人合成正文。'], [second, '乙联系人正文不得进入甲范围。']]) {
      await client.perform({ method: 'POST', path: '/api/expression-preferences', body: {
        operation_key: crypto.randomUUID(), text, scope: { contact_id: contactId, reply_mode: null },
        origin: { kind: 'manual' }, confirm_long_term: true,
      } });
    }
    const paths = [];
    const scoped = { ...backend, requestJson: async (options) => {
      paths.push(options.path);
      return backend.requestJson(options);
    } };
    const controller = new ExpressionPreferenceController(scoped, contacts);
    await controller.refresh(selection());
    assert.deepEqual(controller.getState().preferences.map((item) => item.text), ['本人全局合成要求。', '甲联系人合成正文。']);
    assert.equal(paths.at(-1), `/api/expression-preferences?contact_id=${first}`);
    select(second);
    const restored = new ExpressionPreferenceController(scoped, contacts);
    await restored.refresh(selection());
    assert.deepEqual(restored.getState().preferences.map((item) => item.text), ['本人全局合成要求。', '乙联系人正文不得进入甲范围。']);
    assert.equal(paths.at(-1), `/api/expression-preferences?contact_id=${second}`);
  });
});

test('当前生产控制器只在明确长期确认后保存，并从真实 HTTP 重读来历与适用范围', { timeout: 30000 }, async () => {
  await withPreferenceBackend(async ({ ExpressionPreferenceController, backend, contacts, selection, client }) => {
    const controller = new ExpressionPreferenceController(backend, contacts);
    await controller.refresh(selection());
    const command = { ...selection(), text: '平时少用感叹号。', appliesTo: 'owner', replyMode: null, confirmLongTerm: false };
    await assert.rejects(controller.save(command));
    assert.deepEqual((await client.perform({ method: 'GET', path: '/api/expression-preferences' })).data.preferences, []);
    await controller.save({ ...command, confirmLongTerm: true });
    const state = controller.getState();
    assert.equal(state.phase, 'ready');
    assert.equal(state.error, null);
    assert.equal(state.preferences.length, 1);
    assert.equal(state.preferences[0].text, '平时少用感叹号。');
    assert.deepEqual(state.preferences[0].scope, { contactId: null, replyMode: null });
    assert.deepEqual(state.preferences[0].origin, { kind: 'manual' });
    assert.equal(state.preferences[0].revision, 1);
    assert.equal(state.preferences[0].confirmedOperationKey.length, 36);
    const restored = new ExpressionPreferenceController(backend, contacts);
    await restored.refresh(selection());
    assert.deepEqual(restored.getState().preferences, state.preferences);
  });
});

test('HTTP 已提交但回执丢失时，控制器重试同一用户动作且删除不会复活', { timeout: 30000 }, async () => {
  await withPreferenceBackend(async ({ ExpressionPreferenceController, backend, contacts, selection, client }) => {
    let loseResponse = false;
    const operationKeys = [];
    const uncertain = { ...backend, requestJson: async (options) => {
      const result = await backend.requestJson(options);
      if (options.method !== 'GET') {
        operationKeys.push(options.body.operation_key);
        if (loseResponse) { loseResponse = false; throw new Error('合成网络回执丢失'); }
      }
      return result;
    } };
    const controller = new ExpressionPreferenceController(uncertain, contacts);
    await controller.refresh(selection());
    const save = { ...selection(), text: '回执丢失也只保存一次。', appliesTo: 'owner', replyMode: null, confirmLongTerm: true };
    loseResponse = true;
    await assert.rejects(controller.save(save));
    await controller.refresh(selection());
    assert.equal(controller.getState().preferences.length, 1);
    await controller.save(save);
    assert.equal(operationKeys[0], operationKeys[1]);
    assert.equal(controller.getState().preferences.length, 1);
    const preference = controller.getState().preferences[0];
    const removal = { ...selection(), preferenceId: preference.preferenceId, expectedRevision: 1 };
    loseResponse = true;
    await assert.rejects(controller.remove(removal));
    assert.deepEqual(controller.getState().preferences, []);
    await controller.remove(removal);
    assert.equal(operationKeys[2], operationKeys[3]);
    assert.deepEqual((await client.perform({ method: 'GET', path: '/api/expression-preferences' })).data.preferences, []);
    const restored = new ExpressionPreferenceController(backend, contacts);
    await restored.refresh(selection());
    assert.deepEqual(restored.getState().preferences, []);
  });
});

test('生产控制器修改联系人和输入模式范围，删除后新控制器与旧版本操作均不能恢复正文', { timeout: 30000 }, async () => {
  await withPreferenceBackend(async ({ ExpressionPreferenceController, backend, contacts, selection, client }) => {
    const controller = new ExpressionPreferenceController(backend, contacts);
    await controller.refresh(selection());
    await controller.save({ ...selection(), text: '长期保存的合成要求。', appliesTo: 'owner', replyMode: null, confirmLongTerm: true });
    const first = controller.getState().preferences[0];
    await controller.update({ ...selection(), preferenceId: first.preferenceId, expectedRevision: 1,
      text: '只对这位联系人改写时保留称呼。', appliesTo: 'contact', replyMode: 'rewrite_draft', confirmLongTerm: true });
    const changed = controller.getState().preferences[0];
    assert.equal(changed.revision, 2);
    assert.equal(changed.text, '只对这位联系人改写时保留称呼。');
    assert.deepEqual(changed.scope, { contactId: selection().contactId, replyMode: 'rewrite_draft' });
    await assert.rejects(controller.update({ ...selection(), preferenceId: first.preferenceId, expectedRevision: 1,
      text: '旧版本不能覆盖。', appliesTo: 'owner', replyMode: null, confirmLongTerm: true }));
    await controller.remove({ ...selection(), preferenceId: changed.preferenceId, expectedRevision: 2 });
    assert.deepEqual(controller.getState().preferences, []);
    const restored = new ExpressionPreferenceController(backend, contacts);
    await restored.refresh(selection());
    assert.deepEqual(restored.getState().preferences, []);
    await assert.rejects(client.perform({ method: 'GET', path: `/api/expression-preferences/${changed.preferenceId}?contact_id=${selection().contactId}` }),
      (error) => error.status === 410 && error.code === 'expression_preference_deleted');
  });
});
