import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { BackendHost } from '../src/main/backend/host';
import { JsonClient, BackendRequestFailure, type JsonRequest } from '../src/main/backend/json-client';
import { captureDisplayedCandidateGroup, continueAssistantSession, readAssistantContinuationClarification,
  requirementChangeFromClarification } from '../src/main/reply/assistant-continuation';

const sessionId = 'c0829558-79b9-467c-80f8-648cf6cf4f27';
const groupId = '3ef53d1b-4241-442c-b8a7-2cb09b1eff04';
const firstId = '54777a4a-890a-4744-9a70-184c9bd92803';
const secondId = 'd46c5d39-bf42-412c-8fa9-2f688a408c13';
const secondVersionId = 'adbd025e-2a39-4b7f-a693-80e2c8e0c5bb';

test('实际展示身份保留候选编号与选定旧版本，捕获后不可被界面编辑改写', () => {
  const shown = [{ number: 1, candidateId: firstId, versionId: firstId },
    { number: 2, candidateId: secondId, versionId: secondVersionId }];
  const frame = captureDisplayedCandidateGroup(sessionId, groupId, shown);
  shown[1].versionId = secondId;
  assert.deepEqual(frame, { sessionId, candidateGroupId: groupId, candidates: [
    { number: 1, candidateId: firstId, versionId: firstId },
    { number: 2, candidateId: secondId, versionId: secondVersionId },
  ] });
  assert.equal(Object.isFrozen(frame.candidates[1]), true);
});

const contactId = 'e7cf446b-263a-4b23-9e4e-656d608ab23a';
const requestKey = '99f374b4-0f41-450c-941a-8fb129846fd8';
const inputVersionId = '44a55899-a444-4e7f-a17e-ed438946984d';
const continuePath = `/api/contacts/${contactId}/assistant-sessions/${sessionId}/continue`;
const clarificationResponse = {
  error: 'assistant_continuation_clarification_required',
  clarification: {
    reason: 'requirements_need_confirmation',
    requirements: ['保留末尾的祝福', '保留开头的问候'],
    requirement_actions: ['keep', 'replace', 'remove', 'add'],
    requirement_options: [
      { requirement: '保留末尾的祝福', origin: 'existing', actions: ['keep', 'replace', 'remove'] },
      { requirement: '保留开头的问候', origin: 'new', actions: ['add'] },
    ],
  },
};

async function clarificationBackend(t: TestContext, response: unknown, status = 409) {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('合成HTTP监听未建立。');
  const client = new JsonClient({ address: `127.0.0.1:${address.port}`, port: address.port,
    pid: process.pid, token: 'synthetic-continuation-client-token' });
  t.after(async () => {
    client.cancelPending();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const backend = { getConnectionGeneration: () => 7,
    requestJson: async (options: JsonRequest) => ({ generation: 7, data: (await client.perform(options)).data }) };
  return { client, backend: backend as BackendHost };
}

function continuationCommand() {
  return { requestKey, expectedInputVersionId: inputVersionId, instruction: '保留开头的问候',
    displayedGroup: captureDisplayedCandidateGroup(sessionId, groupId, [
      { number: 1, candidateId: firstId, versionId: firstId },
    ]) };
}

test('实际准备HTTP发出时报告准备阶段，合法澄清不伪造领取或执行回执', async (t) => {
  const { backend } = await clarificationBackend(t, clarificationResponse);
  const requests: string[] = [], phases: string[] = [];
  const requestJson = backend.requestJson.bind(backend);
  backend.requestJson = async (options) => { requests.push(options.path); return requestJson(options); };
  const result = await continueAssistantSession(backend, contactId, sessionId, continuationCommand(),
    new AbortController().signal, () => phases.push('prepared'), () => phases.push('requested'), () => {
      assert.deepEqual(requests, [continuePath + '/prepare']);
      phases.push('preparing');
    });
  assert.equal(result.phase, 'clarification');
  assert.deepEqual(phases, ['preparing']);
});

test('真实JsonClient将当前continue的有限澄清交给业务客户端并保留新增动作', async (t) => {
  const { backend } = await clarificationBackend(t, clarificationResponse);
  const result = await continueAssistantSession(backend, contactId, sessionId, continuationCommand(), new AbortController().signal);
  assert.equal(result.phase, 'clarification');
  assert.deepEqual((result as unknown as { clarification: unknown }).clarification, clarificationResponse.clarification);
  if (result.phase !== 'clarification') throw new Error('本轮需要澄清。');
  assert.equal(result.generation, 7);
  assert.equal(result.contactId, contactId);
  assert.equal(result.assistantSessionId, sessionId);
  assert.equal(result.expectedInputVersionId, inputVersionId);
  assert.equal(result.requestKey, requestKey);
  assert.equal(Object.isFrozen(result.clarification.requirement_options[1].actions), true);
});


test('分类型澄清构造可提交动作，新要求不能回声为旧previous', () => {
  const clarification = readAssistantContinuationClarification(clarificationResponse);
  assert.ok(clarification);
  const [existing, proposed] = clarification.requirement_options;
  assert.deepEqual(requirementChangeFromClarification(proposed, 'add'), { action: 'add', replacement: '保留开头的问候' });
  assert.throws(() => requirementChangeFromClarification(proposed, 'keep'));
  assert.throws(() => requirementChangeFromClarification(proposed, 'remove'));
  assert.throws(() => requirementChangeFromClarification(proposed, 'replace', '改后的要求'));
  assert.throws(() => requirementChangeFromClarification(existing, 'add'));
  assert.deepEqual(requirementChangeFromClarification(existing, 'keep'), { action: 'keep', previous: '保留末尾的祝福' });
  assert.deepEqual(requirementChangeFromClarification(existing, 'remove'), { action: 'remove', previous: '保留末尾的祝福' });
  assert.deepEqual(requirementChangeFromClarification(existing, 'replace', '  保留一句祝福  '),
    { action: 'replace', previous: '保留末尾的祝福', replacement: '保留一句祝福' });
  assert.throws(() => requirementChangeFromClarification(existing, 'replace'));
  assert.throws(() => requirementChangeFromClarification(existing, 'replace', ' '));
  assert.throws(() => requirementChangeFromClarification(existing, 'replace', '长'.repeat(4097)));
});

test('候选指代澄清保留原因，不制造要求或要求动作', () => {
  assert.deepEqual(readAssistantContinuationClarification({ error: 'assistant_continuation_clarification_required',
    clarification: { reason: 'candidate_number_missing', requirements: [], requirement_options: [], requirement_actions: [] } }),
  { reason: 'candidate_number_missing', requirements: [], requirement_options: [], requirement_actions: [] });
});

test('真实JsonClient只放行显式当前continue的合法有限澄清，其他错误不携正文', async (t) => {
  const oversized = '合成正文'.repeat(100_000);
  const many = Array.from({ length: 20_000 }, (_, index) => `合成要求${index}`);
  const bodyWithOptions = (requirements: string[], options: unknown[], actions = ['add']) => ({
    error: clarificationResponse.error, clarification: { reason: 'requirements_need_confirmation',
      requirements, requirement_options: options, requirement_actions: actions },
  });
  const cases = [
    { name: '未显式启用', body: clarificationResponse, accept: false },
    { name: '其他业务路径', body: clarificationResponse, path: '/api/reply/generate' },
    { name: '路径附带查询', body: clarificationResponse, path: continuePath + '?page=1' },
    { name: '准备路径附带查询', body: clarificationResponse, path: continuePath + '/prepare?page=1' },
    { name: '准备路径附带额外段', body: clarificationResponse, path: continuePath + '/prepare/extra' },
    { name: '无效联系人身份', body: clarificationResponse, path: continuePath.replace(contactId, 'invalid') },
    { name: '其他方法', body: clarificationResponse, method: 'GET' as const },
    { name: '其他状态', body: clarificationResponse, status: 400 },
    { name: '其他错误码', body: { ...clarificationResponse, error: 'assistant_session_input_conflict' } },
    { name: '额外响应正文', body: { ...clarificationResponse, raw_body: '合成正文不进入错误' } },
    { name: '额外澄清正文', body: { ...clarificationResponse,
      clarification: { ...clarificationResponse.clarification, raw_payload: '合成正文不进入错误' } } },
    { name: '新要求非法keep', body: bodyWithOptions(['保留祝福'], [{ requirement: '保留祝福', origin: 'new', actions: ['keep'] }], ['keep']) },
    { name: '新要求非法remove', body: bodyWithOptions(['保留祝福'], [{ requirement: '保留祝福', origin: 'new', actions: ['remove'] }], ['remove']) },
    { name: '旧要求非法add', body: bodyWithOptions(['保留祝福'], [{ requirement: '保留祝福', origin: 'existing', actions: ['add'] }]) },
    { name: '完整响应超过continue传输预算', body: bodyWithOptions(many, many.map((requirement) => ({ requirement, origin: 'new', actions: ['add'] }))) },
    { name: '单条要求使完整响应超出continue传输预算', body: bodyWithOptions([oversized], [{ requirement: oversized, origin: 'new', actions: ['add'] }]) },
    { name: '要求与选项错配', body: bodyWithOptions(['保留祝福'], [{ requirement: '合成不同要求', origin: 'new', actions: ['add'] }]) },
    { name: '重复要求', body: bodyWithOptions(['保留祝福', '保留祝福'], [
      { requirement: '保留祝福', origin: 'new', actions: ['add'] }, { requirement: '保留祝福', origin: 'new', actions: ['add'] },
    ]) },
    { name: '未知澄清原因', body: { ...clarificationResponse, clarification: { ...clarificationResponse.clarification, reason: '合成未知原因' } } },
    { name: '动作总表不匹配', body: { ...clarificationResponse, clarification: { ...clarificationResponse.clarification, requirement_actions: ['keep'] } } },
  ];
  for (const item of cases) await t.test(item.name, async (caseContext) => {
    const { client } = await clarificationBackend(caseContext, item.body, item.status);
    const options = { method: item.method ?? 'POST' as const, path: item.path ?? continuePath,
      ...(item.accept === false ? {} : { acceptAssistantContinuationClarification: true as const }) };
    await assert.rejects(client.perform(options), (error: unknown) => {
      assert.ok(error instanceof BackendRequestFailure);
      assert.equal(error.message, '本机业务请求未完成');
      assert.equal(JSON.stringify(error).includes('祝福'), false);
      assert.equal(JSON.stringify(error).includes('合成正文'), false);
      assert.equal(Object.hasOwn(error, 'body'), false);
      assert.equal(Object.hasOwn(error, 'data'), false);
      return true;
    });
  });
});


test('正式4096输入的33及2048条旧要求全部经过真实JsonClient交付，不误用变更数量上限', async (t) => {
  for (const requirements of [Array.from({ length: 33 }, (_, index) => `合成约定${index}`),
    Array.from({ length: 2048 }, (_, index) => String.fromCharCode(0x4E00 + index))]) {
    await t.test(`${requirements.length}条合法旧要求`, async (caseContext) => {
      assert.ok(requirements.join('；').length <= 4096);
      const body = { error: clarificationResponse.error, clarification: {
        reason: 'requirements_need_confirmation', requirements,
        requirement_options: requirements.map((requirement) => ({ requirement, origin: 'existing', actions: ['keep', 'replace', 'remove'] })),
        requirement_actions: ['keep', 'replace', 'remove'],
      } };
      const { backend } = await clarificationBackend(caseContext, body);
      const result = await continueAssistantSession(backend, contactId, sessionId, continuationCommand(), new AbortController().signal);
      assert.equal(result.phase, 'clarification');
      if (result.phase !== 'clarification') throw new Error('本轮需要澄清。');
      assert.deepEqual(result.clarification.requirements, requirements);
      assert.equal(result.clarification.requirement_options.length, requirements.length);
    });
  }
});
