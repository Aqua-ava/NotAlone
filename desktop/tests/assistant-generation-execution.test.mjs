import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
Error.stackTraceLimit = 2;
const bundled = await build({ stdin: { contents: `
  export { BackendRequestFailure } from './src/main/backend/json-client';
  export { AssistantGenerationJobs } from './src/main/reply/assistant-generation-jobs';
  export { continuationGeneration, strategyGeneration, ordinaryGeneration } from './src/main/reply/assistant-generation-adapters';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { BackendRequestFailure, AssistantGenerationJobs, continuationGeneration, strategyGeneration, ordinaryGeneration } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const owner = { connectionGeneration: 7, contactId: '38c6e784-93dc-476b-8a2c-2733523a23b9',
  sessionId: 'ad630563-b558-40ec-bdaa-c34201756c42' };
const requestKey = '69b51458-cf1d-47d2-a96c-fd465f15c353';
const command = { requestKey, expectedInputVersionId: 'a4afba16-2fa1-45d0-ac42-de8d06045bda',
  instruction: '合成要求', displayedGroup: { sessionId: owner.sessionId,
    candidateGroupId: '7a750bd7-d1b9-4b96-969c-99e5464d896a', candidates: [] } };
const clarification = { error: 'assistant_continuation_clarification_required', clarification: {
  reason: 'requirements_need_confirmation', requirements: ['合成要求'],
  requirement_actions: ['add'],
  requirement_options: [{ requirement: '合成要求', origin: 'new', actions: ['add'] }],
} };
test('受管继续准备澄清在消费窗口保持可发布，消费失败仍结算明确未生成身份', async () => {
  const jobs = new AssistantGenerationJobs(), requests = [];
  const backend = { getConnectionGeneration: () => 7, requestJson: async (request) => {
    requests.push(request.path); return { generation: 7, data: clarification };
  } };
  let job;
  await assert.rejects(jobs.execute({ identity: { ...owner, requestKey },
    adapter: continuationGeneration(backend, owner, command),
    registered: (registered) => { job = registered; },
    consume: (result) => {
      assert.equal(result.phase, 'clarification'); assert.equal(jobs.canPublish(job, owner), true);
      throw new Error('合成展示失败');
    },
  }), /合成展示失败/);
  assert.equal(requests.length, 1, '展示错误不能触发生成失败的权威复读');
  assert.deepEqual(jobs.pendingReceipts(), []);
  await jobs.beginClosing(() => { throw new Error('澄清不应中断生成'); });
});

test('受管方向准备明确暂停后不派发执行，也不保留未知准备退出身份', async () => {
  const jobs = new AssistantGenerationJobs(), requests = [];
  const backend = { getConnectionGeneration: () => 7, requestJson: async (request) => {
    requests.push(request.path); return { generation: 7, data: { kind: 'paused',
      exploration_id: command.displayedGroup.candidateGroupId, input_version_id: command.expectedInputVersionId } };
  } };
  const request = { contactId: owner.contactId, sessionId: owner.sessionId, taskId: command.displayedGroup.candidateGroupId,
    inputVersion: command.expectedInputVersionId, action: 'confirm', directIntent: '合成意愿', generate: true };
  await jobs.execute({ identity: owner, preparationCommand: { taskId: request.taskId,
    inputVersionId: request.inputVersion, action: 'confirm', suggestionId: null, operationKey: requestKey },
    adapter: strategyGeneration(backend, owner, request), consume: (result) => assert.equal(result.kind, 'paused') });
  assert.equal(requests.length, 1);
  await jobs.beginClosing(() => { throw new Error('明确暂停不能中断生成'); });
});

const turnId = '868bd7c5-d71c-435e-9ab1-10ff304b67a9';
const receipt = { session_id: owner.sessionId, request_key: requestKey, turn_id: turnId,
  input_version_id: command.expectedInputVersionId, state: 'running' };
const completed = { ...receipt, state: 'completed', reply_request_id: requestKey,
  context_receipt: { evidence_ids: [] }, candidates: [{ candidate_id: requestKey, text: '合成候选',
    basis: '合成依据', citation_ids: [], risk_notes: [] }] };
const attempt = { requestKey, input: { mode: 'rewrite_draft', contactId: owner.contactId,
  contactDisplayName: '合成联系人', draftText: '合成草稿', userInstruction: null, includeRelationshipContext: false } };
test('受管普通生成完成后展示抛错仍完成，且不复读失败或留下退出身份', async () => {
  const jobs = new AssistantGenerationJobs(), requests = [];
  const backend = { getConnectionGeneration: () => 7, requestJson: async (request) => {
    requests.push(request.path); return { generation: 7, data: request.path.endsWith('/prepare') ? receipt : completed };
  } };
  let job;
  await assert.rejects(jobs.execute({ identity: { ...owner, requestKey },
    adapter: ordinaryGeneration(backend, owner, attempt), registered: (registered) => { job = registered; },
    consume: () => { assert.equal(jobs.canPublish(job, owner), true); throw new Error('合成版本读取失败'); },
  }), /合成版本读取失败/);
  assert.equal(requests.length, 2);
  assert.equal(jobs.states(7)[0].phase, 'completed');
  assert.deepEqual(jobs.pendingReceipts(), []);
  await jobs.beginClosing(() => { throw new Error('已完成生成不能再中断'); });
});

function failedSession(generationActive) {
  return { session_id: owner.sessionId, current_input_version_id: command.expectedInputVersionId,
    turns: [{ ...receipt, state: 'failed', input: { scene: null, content: { type: 'rewrite_draft', draft_text: '合成草稿' } },
      reply: null, interruption_reason: null, placeholder: null,
      ...(generationActive === undefined ? {} : { generation_active: generationActive }) }],
    inputs: [{ input_version_id: command.expectedInputVersionId, type: 'generation', conversation_binding_id: owner.contactId,
      turn_id: turnId, state: 'active', content: null, placeholder: null }] };
}
for (const active of [true, undefined, false]) test('失败租约证据 ' + String(active) + ' 仅明确 false 结算身份', async () => {
  const jobs = new AssistantGenerationJobs(), calls = [];
  const backend = { getConnectionGeneration: () => 7, requestJson: async (request) => {
    calls.push(request);
    if (request.path.endsWith('/prepare')) return { generation: 7, data: receipt };
    if (request.method === 'GET') return { generation: 7, data: failedSession(active) };
    throw new BackendRequestFailure('response', 503, 'reply_timeout');
  } };
  await assert.rejects(jobs.execute({ identity: { ...owner, requestKey }, adapter: ordinaryGeneration(backend, owner, attempt),
    consume: () => assert.fail('失败不能消费候选') }), BackendRequestFailure);
  assert.equal(calls.filter((request) => request.method === 'GET').length, 1);
  assert.equal(jobs.states(7)[0].phase, 'failed');
  assert.equal(jobs.pendingReceipts().length, active === false ? 0 : 1);
});
test('网络结束释放本地执行许可但保留原未确认身份，下一请求能执行', async () => {
  const jobs = new AssistantGenerationJobs();
  const secondKey = '530f7eb1-dfd5-4ebe-b373-dd6241529178';
  let executions = 0;
  const backend = { getConnectionGeneration: () => 7, requestJson: async (request) => {
    const key = request.body.idempotency_key;
    if (request.path.endsWith('/prepare')) return { generation: 7, data: { ...receipt, request_key: key } };
    executions++;
    if (key === requestKey) throw new BackendRequestFailure('connection');
    return { generation: 7, data: { ...completed, request_key: key } };
  } };
  await assert.rejects(jobs.execute({ identity: { ...owner, requestKey }, adapter: ordinaryGeneration(backend, owner, attempt),
    consume: () => assert.fail('未知响应不能消费') }), BackendRequestFailure);
  await jobs.execute({ identity: { ...owner, requestKey: secondKey }, adapter: ordinaryGeneration(backend, owner,
    { ...attempt, requestKey: secondKey }), consume: () => {} });
  assert.equal(executions, 2);
  assert.deepEqual(jobs.pendingReceipts().map((item) => item.requestKey), [requestKey]);
  assert.equal(jobs.states(7).find((item) => item.requestKey === requestKey).phase, 'unconfirmed');
});
test('受管未确认作业重载配置仍经捕获的原停止句柄并携带 configuration_reload', async () => {
  const jobs = new AssistantGenerationJobs(), interruptions = [];
  const backend = { getConnectionGeneration: () => 7, requestJson: async (request) => {
    if (request.path.endsWith('/prepare')) return { generation: 7, data: receipt };
    throw new BackendRequestFailure('connection');
  } };
  await assert.rejects(jobs.execute({ identity: { ...owner, requestKey },
    stopping: { recover: () => assert.fail('已有回执不应恢复'),
      interrupt: async (actual, reason) => { interruptions.push({ actual, reason }); } },
    adapter: ordinaryGeneration(backend, owner, attempt), consume: () => {} }), BackendRequestFailure);
  await jobs.prepareConnectionChange();
  assert.equal(interruptions.length, 1); assert.equal(interruptions[0].reason, 'configuration_reload');
  assert.equal(interruptions[0].actual.connectionGeneration, 7);
  assert.equal(interruptions[0].actual.requestKey, requestKey);
  assert.deepEqual(jobs.pendingReceipts(), []);
});
test('跨连接保留32个未知准备后拒绝第33个，不能丢弃未知身份腾容量', async () => {
  const jobs = new AssistantGenerationJobs(); let requests = 0;
  for (let generation = 0; generation < 33; generation++) {
    const backend = { getConnectionGeneration: () => generation, requestJson: async () => {
      requests++; throw new BackendRequestFailure('connection');
    } };
    const actualOwner = { ...owner, connectionGeneration: generation };
    await assert.rejects(jobs.execute({ identity: { ...actualOwner, requestKey },
      adapter: ordinaryGeneration(backend, actualOwner, attempt), consume: () => {} }),
      generation < 32 ? BackendRequestFailure : /待处理任务已满/);
  }
  assert.equal(requests, 32); assert.equal(jobs.recoveryPending(undefined), 32);
});

test('实际生成完成后消费仍悬挂时释放本地许可，保留原展示窗口并允许下一生成', async () => {
  const jobs = new AssistantGenerationJobs();
  let release, entered;
  const consuming = new Promise((resolve) => { entered = resolve; });
  const consumed = new Promise((resolve) => { release = resolve; });
  const nextKey = '530f7eb1-dfd5-4ebe-b373-dd6241529178';
  const backend = { getConnectionGeneration: () => 7, requestJson: async (request) => ({ generation: 7,
    data: { ...(request.path.endsWith('/prepare') ? receipt : completed), request_key: request.body.idempotency_key } }) };
  let firstJob;
  const first = jobs.execute({ identity: { ...owner, requestKey }, adapter: ordinaryGeneration(backend, owner, attempt),
    registered: (registered) => { firstJob = registered; }, consume: async () => { entered(); await consumed; } });
  await consuming;
  const next = jobs.execute({ identity: { ...owner, requestKey: nextKey },
    adapter: ordinaryGeneration(backend, owner, { ...attempt, requestKey: nextKey }), consume: () => {} });
  try {
    assert.equal(await Promise.race([next.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 100))]), true);
    assert.equal(jobs.canPublish(firstJob, owner), true, '释放许可不能提前移除原展示身份');
  } finally { release(); await first; await next; }
});
