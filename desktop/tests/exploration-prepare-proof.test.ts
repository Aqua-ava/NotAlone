import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { JsonClient, BackendRequestFailure } from '../src/main/backend/json-client';

const contactId = 'e7cf446b-263a-4b23-9e4e-656d608ab23a';
const sessionId = 'c0829558-79b9-467c-80f8-648cf6cf4f27';
const taskId = '3ef53d1b-4241-442c-b8a7-2cb09b1eff04';
const inputId = '44a55899-a444-4e7f-a17e-ed438946984d';
const choiceId = '54777a4a-890a-4744-9a70-184c9bd92803';
const actualKey = '99f374b4-0f41-450c-941a-8fb129846fd8';
const operationKey = 'adbd025e-2a39-4b7f-a693-80e2c8e0c5bb';
const base = `/api/contacts/${contactId}/assistant-sessions/${sessionId}/explorations/${taskId}`;

test('具名策略准备证明必须绑定原task、input、action和operation，实际键由服务端确认', async (t) => {
  let status = 409;
  const proof = { contact_id: contactId, session_id: sessionId, request_key: actualKey, state: 'not_reserved' };
  const confirmation = { input_version_id: inputId, suggestion_id: choiceId };
  const expectedBinding = { exploration_id: taskId, input_version_id: inputId, action: 'prepare-confirm', operation_key: null };
  const confirmedResponse = { error: 'assistant_session_rejected', reason: 'request_deleted',
    no_generation: proof, exploration_preparation: expectedBinding };
  let response: unknown = confirmedResponse;
  const server = createServer((req, res) => {
    req.resume(); res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('合成回环HTTP未启动。');
  const client = new JsonClient({ port: address.port, address: `127.0.0.1:${address.port}`,
    pid: process.pid, token: 'synthetic-exploration-proof-token' });
  t.after(async () => { client.cancelPending(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  await assert.rejects(client.perform({ method: 'POST', path: base + '/prepare-confirm',
    body: confirmation, acceptAssistantNoGenerationProof: true }), (error: unknown) => {
    assert(error instanceof BackendRequestFailure);
    assert.deepEqual(error.noGeneration, { contactId, sessionId, requestKey: actualKey, state: 'not_reserved' });
    return true;
  });
  const negatives = [
    { name: '普通confirm执行', path: base + '/confirm', response: confirmedResponse },
    { name: '缺提交关联', path: base + '/prepare-confirm', response: { error: 'assistant_session_rejected', reason: 'request_deleted', no_generation: proof } },
    { name: '其它task', path: base + '/prepare-confirm', response: { ...confirmedResponse, exploration_preparation: { ...expectedBinding, exploration_id: choiceId } } },
    { name: '其它input', path: base + '/prepare-confirm', response: { ...confirmedResponse, exploration_preparation: { ...expectedBinding, input_version_id: choiceId } } },
    { name: '不同action', path: base + '/prepare-confirm', response: { ...confirmedResponse, exploration_preparation: { ...expectedBinding, action: 'prepare-answer' } } },
    { name: '额外正文', path: base + '/prepare-confirm', response: { ...confirmedResponse, private_text: '不可传输合成正文' } },
    { name: '未知503', path: base + '/prepare-confirm', response: confirmedResponse, status: 503 },
  ];
  for (const item of negatives) await t.test(item.name, async () => {
    response = item.response; status = item.status ?? 409;
    await assert.rejects(client.perform({ method: 'POST', path: item.path, body: confirmation,
      acceptAssistantNoGenerationProof: true }), (error: unknown) => error instanceof BackendRequestFailure
        && error.noGeneration === undefined && !('private_text' in error));
  });
  status = 409;
  const answer = { input_version_id: inputId, question_id: choiceId, answer: '本次不见面。', operation_key: operationKey };
  response = { ...confirmedResponse, exploration_preparation: { ...expectedBinding, action: 'prepare-answer', operation_key: operationKey } };
  await assert.rejects(client.perform({ method: 'POST', path: base + '/prepare-answer', body: answer,
    acceptAssistantNoGenerationProof: true }), (error: unknown) => error instanceof BackendRequestFailure
      && error.noGeneration?.requestKey === actualKey);
  await assert.rejects(client.perform({ method: 'POST', path: base + '/prepare-answer', body: { ...answer, operation_key: taskId },
    acceptAssistantNoGenerationProof: true }), (error: unknown) => error instanceof BackendRequestFailure && error.noGeneration === undefined);
});
