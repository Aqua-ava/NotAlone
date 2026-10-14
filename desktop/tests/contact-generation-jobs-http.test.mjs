import assert from 'node:assert/strict';
import { test } from 'node:test';
import { budgetPublicFixture } from './fixtures/assistant-budget-public.mjs';

async function eventually(read, check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('公开状态未在限定时间到达');
}

test('A运行时B可靠准备后排队，切换编辑及新消息不改变原任务', async t => {
  const f = await budgetPublicFixture(t), a = await f.connect();
  f.contacts.setDraft({ ...a, text: '甲的原合成草稿' });
  await f.command('plan', { plan: { text: '甲的合成候选', count: 1 } });
  await f.command('hold');
  const runningA = f.bridge.generate({ ...a, newRequest: true });
  let runningB;
  try {
    await eventually(() => f.command('metrics'), value => value.model_entered);
    const b = await f.connect(f.data.contact_ids[1]);
    await f.bridge.setMode({ ...b, mode: 'initiate_conversation' });
    await f.bridge.updatePurpose({ ...b, purpose: '乙的原合成目的' });
    await f.command('plan', { plan: { text: '乙的合成候选', count: 1 } });
    runningB = f.bridge.generate({ ...b, newRequest: true });
    const queued = await eventually(() => f.bridge.getState(), state => state.generationJobs?.some(
      job => job.contactId === b.contactId && job.phase === 'queued'));
    const original = queued.generationJobs.find(job => job.contactId === b.contactId);
    assert.match(f.renderSession(queued), /排队/);
    assert.equal(queued.generationJobs.find(job => job.contactId === a.contactId).phase, 'generating');
    await f.bridge.updatePurpose({ ...b, purpose: '乙的后来编辑目的' });
    await f.command('older_messages', { contact_id: b.contactId });
    const returnedA = await f.connect(a.contactId);
    assert.equal((await f.command('metrics')).model_calls, 0);
    await f.bridge.generate({ ...returnedA, newRequest: false });
    assert.equal((await f.bridge.getState()).generationJobs.filter(job => job.contactId === a.contactId).length, 1);
    await f.command('release'); await runningA; await runningB;
    const aSaved = await f.request('/api/contacts/' + a.contactId + '/assistant-sessions/' + (await f.bridge.getState()).savedSession.sessionId);
    assert.equal(aSaved.turns[0].reply.candidates[0].text, '甲的合成候选');
    assert.equal((await f.bridge.getState()).savedSession.turns[0].reply?.candidates[0].text, '甲的合成候选');
    await f.connect(b.contactId);
    const completed = await f.bridge.getState();
    assert.equal(completed.purpose, '乙的后来编辑目的');
    const bSaved = completed.savedSession;
    assert.equal(bSaved.turns[0].requestKey, original.requestKey);
    assert.equal(bSaved.turns[0].inputVersionId, original.inputVersionId);
    assert.equal(bSaved.turns[0].reply.candidates[0].text, '乙的合成候选');
    const metrics = await f.command('metrics');
    assert.equal(metrics.model_calls, 2);
    assert.doesNotMatch(JSON.stringify(metrics.payloads[1]), /后来编辑目的|较早合成消息/);
    assert.equal(returnedA.contactId, a.contactId);
  } finally {
    await f.command('release'); await runningA; await runningB;
  }
});

test('后台失败返回后只读恢复原请求重试，另一联系人无错误污染', async t => {
  const f = await budgetPublicFixture(t), a = await f.connect();
  f.contacts.setDraft({ ...a, text: '失败后重试的合成草稿' });
  await f.command('plan', { plan: { fault: 'timeout' } });
  await f.command('hold');
  const running = f.bridge.generate({ ...a, newRequest: true });
  try {
    await eventually(() => f.command('metrics'), value => value.model_entered);
    const original = (await f.bridge.getState()).generationJobs[0];
    await f.connect(f.data.contact_ids[1]);
    await f.command('release'); await running;
    const b = await f.bridge.getState();
    assert.equal(b.errorCode, undefined); assert.equal(b.canRetry, false);
    const returned = await f.connect(a.contactId), failed = await f.bridge.getState();
    assert.equal(failed.generationJobs.find(job => job.requestKey === original.requestKey).phase, 'failed');
    assert.equal(failed.canRetry, true);
    assert.equal((await f.command('metrics')).model_calls, 1);
    await f.command('plan', { plan: { text: '原请求重试成功', count: 1 } });
    await f.bridge.generate({ ...returned, newRequest: false });
    await f.bridge.readSavedSession(returned);
    const done = await f.bridge.getState();
    assert.equal(done.savedSession.turns.length, 1);
    assert.equal(done.savedSession.turns[0].requestKey, original.requestKey);
    assert.equal(done.savedSession.turns[0].reply.candidates[0].text, '原请求重试成功');
    assert.equal((await f.command('metrics')).model_calls, 2);
  } finally { await f.command('release'); await running; }
});

async function queuedPair(f, configureB) {
  const a = await f.connect();
  f.contacts.setDraft({ ...a, text: '占用执行许可的合成草稿' });
  await f.command('plan', { plan: { text: '甲已完成', count: 1 } });
  await f.command('hold');
  const runningA = f.bridge.generate({ ...a, newRequest: true });
  await eventually(() => f.command('metrics'), value => value.model_entered);
  const b = await f.connect(f.data.contact_ids[1]);
  f.contacts.setDraft({ ...b, text: '等待执行的合成草稿' });
  await configureB?.(b);
  const runningB = f.bridge.generate({ ...b, newRequest: true });
  const state = await eventually(() => f.bridge.getState(), value => value.generationJobs.some(job => job.contactId === b.contactId && job.phase === 'queued'));
  return { a, b, runningA, runningB, queued: state.generationJobs.find(job => job.contactId === b.contactId) };
}

for (const invalidation of ['source', 'session', 'contact', 'skill', 'revoke', 'connection']) {
  test(`排队期间${invalidation}失效不会执行或恢复候选`, async t => {
    const f = await budgetPublicFixture(t); let skill;
    const pair = await queuedPair(f, async b => {
      if (invalidation === 'skill') {
        skill = (await f.command('strategy_skills')).skills[0];
        await f.bridge.setMode({ ...b, mode: 'initiate_conversation' });
        await f.bridge.updatePurpose({ ...b, purpose: '合成固定目的' });
        await f.bridge.updateSkill({ ...b, skill: { mode: 'user', versionId: skill.version_id } });
      }
    });
    const { b, queued } = pair;
    try {
      if (invalidation === 'source') {
        const sources = await f.request(`/api/contacts/${b.contactId}/sources`), id = sources.sources[0].source_id;
        await f.request(`/api/contacts/${b.contactId}/sources/${id}`, undefined, 'DELETE');
        await eventually(() => f.request(`/api/contacts/${b.contactId}/sources`), value => value.sources.find(item => item.source_id === id)?.status === 'deleted');
        await f.replies.revalidateDeletedSource(b.contactId);
      } else if (invalidation === 'session') {
        await f.bridge.deleteSavedSession({ ...b, sessionId: queued.sessionId, confirmed: true });
      } else if (invalidation === 'contact') {
        await f.command('delete_contact', { contact_id: b.contactId });
        await f.contacts.refreshContacts();
      } else if (invalidation === 'skill') await f.request(`/api/skills/${skill.skill_id}/disable`, {});
      else if (invalidation === 'revoke') await f.command('revoke', { contact_id: b.contactId });
      else f.disconnect();
      await f.command('release'); await pair.runningA; await pair.runningB;
      assert.equal((await f.command('metrics')).model_calls, 1);
      assert.equal((await f.bridge.getState()).result, null);
      if (!['contact', 'session', 'connection'].includes(invalidation)) {
        await f.bridge.readSavedSession(b);
        assert.ok((await f.bridge.getState()).savedSession.turns.every(turn => turn.reply === null));
      }
      if (invalidation === 'session' || invalidation === 'contact') {
        assert.ok(!(await f.bridge.getState()).generationJobs.some(job => job.sessionId === queued.sessionId));
      }
    } finally { await f.command('release'); await pair.runningA; await pair.runningB; }
  });
}

test('真正退出中断运行及排队作业，停止后续派发；重读不自动续跑', async t => {
  const f = await budgetPublicFixture(t), pair = await queuedPair(f);
  try {
    await f.replies.beginGenerationClosing(receipt => f.request(`/api/contacts/${receipt.contactId}/assistant-sessions/${receipt.sessionId}/interrupt`,
      { request_key: receipt.requestKey, input_version_id: receipt.inputVersionId }));
    await f.command('release'); await pair.runningA; await pair.runningB;
    const saved = await f.request(`/api/contacts/${pair.b.contactId}/assistant-sessions/${pair.queued.sessionId}`);
    assert.equal(saved.turns[0].state, 'failed');
    assert.equal(saved.turns[0].interruption_reason, 'app_quit');
    await f.bridge.readSavedSession(pair.b);
    // 退出可能先于合成模型返回；已进入的A可计0或1次完成，队列不能产生第二次调用。
    assert.ok((await f.command('metrics')).model_calls <= 1);
  } finally { await f.command('release'); await pair.runningA; await pair.runningB; }
});

test('最多接纳八个未结算任务，满额不发送第九次准备且退出可清空队列', async t => {
  const f = await budgetPublicFixture(t), pair = await queuedPair(f), running = [pair.runningA, pair.runningB];
  try {
    for (let index = 2; index < 8; index++) {
      await f.bridge.newSavedSession(pair.b);
      f.contacts.setDraft({ ...pair.b, text: `合成排队草稿${index}` });
      running.push(f.bridge.generate({ ...pair.b, newRequest: true }));
      await eventually(() => f.bridge.getState(), value => value.generationJobs.length === index + 1);
    }
    assert.equal((await f.bridge.getState()).generationJobs.filter(job => job.phase === 'queued').length, 7);
    await f.bridge.newSavedSession(pair.b);
    f.contacts.setDraft({ ...pair.b, text: '合成超额任务' });
    await f.bridge.generate({ ...pair.b, newRequest: true });
    await f.bridge.readSavedSession(pair.b);
    assert.equal((await f.bridge.getState()).savedSession.turns.length, 0);
    assert.equal((await f.bridge.getState()).generationJobs.length, 8);
    await f.replies.beginGenerationClosing(receipt => f.request(`/api/contacts/${receipt.contactId}/assistant-sessions/${receipt.sessionId}/interrupt`,
      { request_key: receipt.requestKey, input_version_id: receipt.inputVersionId }));
    await f.command('release'); await Promise.all(running);
    // 退出可能先于合成模型返回；已进入的A可计0或1次完成，队列不能产生第二次调用。
    assert.ok((await f.command('metrics')).model_calls <= 1);
  } finally { await f.replies.beginGenerationClosing(receipt => f.request(`/api/contacts/${receipt.contactId}/assistant-sessions/${receipt.sessionId}/interrupt`,
      { request_key: receipt.requestKey, input_version_id: receipt.inputVersionId })); await f.command('release'); await Promise.all(running); }
});

test('当前和后台联系人的消息提示分别恢复，切换与新消息零生成', async t => {
  const f = await budgetPublicFixture(t), a = await f.connect();
  await f.bridge.setMode({ ...a, mode: 'reply_to_message' });
  let state = await f.bridge.getState();
  f.message({ contactId: a.contactId, messageId: state.messages.items[0].messageId });
  await eventually(() => f.bridge.getState(), value => value.messageNotice.changed);
  const b = await f.connect(f.data.contact_ids[1]);
  assert.equal((await f.bridge.getState()).messageNotice.changed, false);
  const aAgain = await f.connect(a.contactId);
  assert.equal((await f.bridge.getState()).messageNotice.changed, true);
  await f.connect(b.contactId);
  // 背景事件的标识来自实际HTTP消息，正文仍只在切回后读取。
  f.message({ contactId: a.contactId, messageId: state.messages.items[0].messageId });
  assert.equal((await f.bridge.getState()).messageNotice.changed, false);
  await f.connect(aAgain.contactId);
  assert.equal((await f.bridge.getState()).messageNotice.changed, true);
  assert.equal((await f.command('metrics')).model_calls, 0);
});

test('满额任务换连接后仍可显式生成，旧退出证据单独保留', async t => {
  const f = await budgetPublicFixture(t), pair = await queuedPair(f), running = [pair.runningA, pair.runningB];
  try {
    for (let index = 2; index < 8; index++) {
      await f.bridge.newSavedSession(pair.b); f.contacts.setDraft({ ...pair.b, text: `合成原连接任务${index}` });
      running.push(f.bridge.generate({ ...pair.b, newRequest: true }));
      await eventually(() => f.bridge.getState(), value => value.generationJobs.length === index + 1);
    }
    f.disconnect(); await f.command('release'); await Promise.all(running);
    const fresh = await f.connect(pair.b.contactId);
    await f.bridge.newSavedSession(fresh); f.contacts.setDraft({ ...fresh, text: '新连接的独立合成请求' });
    await f.command('plan', { plan: { text: '新连接候选', count: 1 } });
    await f.bridge.generate({ ...fresh, newRequest: true });
    await f.bridge.readSavedSession(fresh);
    const state = await f.bridge.getState();
    assert.equal(state.savedSession.turns[0].reply.candidates[0].text, '新连接候选');
    assert.ok(state.generationRecoveryPending > 0);
    assert.equal((await f.command('metrics')).model_calls, 2);
  } finally { await f.command('release'); await Promise.all(running); }
});

for (const kind of ['strategy', 'continuation']) {
  test(`${kind}后台失败后返回按原身份明确重试`, async t => {
    const f = await budgetPublicFixture(t), a = await f.connect();
    await f.bridge.setMode({ ...a, mode: 'initiate_conversation' });
    await f.bridge.updatePurpose({ ...a, purpose: '合成继续目的' });
    if (kind === 'strategy') {
      await f.command('plan', { plan: { explore: { question: null } } });
      await f.bridge.explore(a);
      const explored = (await f.bridge.getState()).exploration.result;
      await f.bridge.selectDirection({ ...a, suggestionId: explored.directions[0].suggestionId, inputVersion: explored.inputVersion });
    } else {
      await f.command('plan', { plan: { text: '合成初始候选', count: 1 } });
      await f.bridge.generate({ ...a, newRequest: true });
      await f.bridge.readSavedSession(a);
    }
    await f.command('plan', { plan: { fault: 'timeout' } }); await f.command('hold');
    const running = kind === 'strategy' ? f.bridge.generate({ ...a, newRequest: true })
      : f.bridge.continueSession({ ...a, sessionId: (await f.bridge.getState()).savedSession.sessionId, instruction: '更简短' });
    try {
      await eventually(() => f.bridge.getState(), value => value.generationJobs.some(job => job.phase === 'generating'));
      const original = (await f.bridge.getState()).generationJobs.find(job => job.phase === 'generating');
      await f.connect(f.data.contact_ids[1]); await f.command('release'); await running;
      const returned = await f.connect(a.contactId);
      assert.equal((await f.bridge.getState()).canRetry, true);
      await f.command('plan', { plan: { text: '后台原身份重试候选', count: 1 } });
      await f.bridge.generate({ ...returned, newRequest: false });
      assert.equal((await f.bridge.getState()).result?.candidates[0].original.text, '后台原身份重试候选');
      await f.bridge.readSavedSession(returned);
      const turn = (await f.bridge.getState()).savedSession.turns.find(item => item.requestKey === original.requestKey);
      assert.equal(turn.reply?.candidates[0].text, '后台原身份重试候选');
    } finally { await f.command('release'); await running; }
  });
}

test('会话删除已确认后释放执行许可，不被旧结果传输迟到阻塞', async t => {
  const f = await budgetPublicFixture(t), a = await f.connect();
  const sessionId = (await f.bridge.getState()).savedSession.sessionId;
  let release; const gate = new Promise(resolve => { release = resolve; }); let arrived = false;
  f.delivery.after = async options => {
    if (options.method === 'POST' && options.path === `/api/contacts/${a.contactId}/assistant-sessions/${sessionId}/replies`) {
      arrived = true; await gate;
    }
  };
  f.contacts.setDraft({ ...a, text: '删除前的合成请求' });
  await f.command('plan', { plan: { text: '即将删除的合成候选', count: 1 } });
  const runningA = f.bridge.generate({ ...a, newRequest: true }); let runningB;
  try {
    await eventually(() => arrived, Boolean);
    const b = await f.connect(f.data.contact_ids[1]);
    f.contacts.setDraft({ ...b, text: '不受旧传输影响的合成请求' });
    await f.command('plan', { plan: { text: '乙继续完成', count: 1 } });
    runningB = f.bridge.generate({ ...b, newRequest: true });
    await eventually(() => f.bridge.getState(), state => state.generationJobs.some(job => job.contactId === b.contactId && job.phase === 'queued'));
    const currentA = await f.connect(a.contactId);
    await f.bridge.deleteSavedSession({ ...currentA, sessionId, confirmed: true });
    await eventually(() => f.command('metrics'), metrics => metrics.model_calls === 2);
    await runningB;
    assert.equal((await f.bridge.getState()).result, null);
    assert.ok(!(await f.bridge.getState()).generationJobs.some(job => job.sessionId === sessionId));
  } finally { release(); await runningA; await runningB; }
});
