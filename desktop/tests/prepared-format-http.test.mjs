import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

test('旧准备明确核对后重新准备，保留当前编辑且刷新不生成', async (t) => {
  const f = await budgetPublicFixture(t);
  const scope = await f.connect(f.data.contact_ids[0]);
  f.contacts.setDraft({ ...scope, text: '合成原准备草稿' });
  let interrupted = false;
  f.delivery.after = async (options) => {
    if (options.path.endsWith('/prepare') && !interrupted) {
      interrupted = true;
      await f.command('old_prepared_format', { contact_id: scope.contactId,
        request_key: options.body.idempotency_key });
    }
  };
  await f.bridge.generate({ ...scope, newRequest: false });
  assert.equal((await f.command('metrics')).model_calls, 0);
  f.contacts.setDraft({ ...scope, text: '合成用户后来修改，必须保留' });
  await f.bridge.readSavedSession(scope);
  const saved = await f.bridge.getState();
  assert.equal(saved.savedSession.turns.length, 1);
  assert.equal(saved.savedSession.turns[0].requiresReprepare, true);
  assert.match(f.renderCandidates(saved), /重新准备/);
  assert.equal(f.contacts.getState().draft, '合成用户后来修改，必须保留');
  assert.equal((await f.command('metrics')).model_calls, 0);
  await f.command('plan', { plan: { text: '合成新候选', count: 1 } });
  await f.bridge.generate({ ...scope, newRequest: true });
  assert.equal((await f.command('metrics')).model_calls, 1);
  await f.bridge.readSavedSession(scope);
  const done = await f.bridge.getState();
  assert.equal(done.result.input.draftText, '合成用户后来修改，必须保留');
  assert.equal(done.savedSession.turns.length, 2);
  assert.equal(done.savedSession.turns[0].state, 'failed');
});
