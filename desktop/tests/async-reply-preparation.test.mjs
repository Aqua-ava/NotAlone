import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundle = await build({ stdin: { contents:
  "export { JsonClient, BackendRequestFailure } from './src/main/backend/json-client';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false });
const { JsonClient, BackendRequestFailure } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const contactId = randomUUID(), sessionId = randomUUID(), requestKey = randomUUID(), taskId = randomUUID();
const path = `/api/contacts/${contactId}/assistant-sessions/${sessionId}/replies/prepare`;
const pending = { preparation_id: taskId, state: 'preparing' };
const receipt = { session_id: sessionId, request_key: requestKey, turn_id: randomUUID(), input_version_id: randomUUID(), state: 'running' };
async function fixture(t, respond) {
  const requests = [];
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* 只排空合成正文。 */ }
    requests.push({ method: req.method, path: req.url, headers: req.headers });
    const result = respond(req);
    res.writeHead(result.status ?? 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result.data));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new JsonClient({ port: server.address().port, token: 'synthetic-preparation-token', pid: process.pid });
  t.after(async () => { client.cancelPending(); await new Promise((resolve) => server.close(resolve)); });
  return { client, requests };
}
const request = { method: 'POST', path, body: { idempotency_key: requestKey }, asyncPreparation: true,
  acceptAssistantNoGenerationProof: true, manualContactId: contactId };

test('准备超过八秒时仍等候同一任务，短网络请求不重复提交正文', { timeout: 12_000 }, async (t) => {
  const readyAt = performance.now() + 8100;
  const f = await fixture(t, (req) => req.method === 'POST' || performance.now() < readyAt
    ? { status: 202, data: pending } : { data: receipt });
  const result = await f.client.perform({ ...request, timeoutMs: 150 });
  assert.deepEqual(result.data, receipt);
  assert.equal(f.requests.filter((item) => item.method === 'POST').length, 1);
  assert.equal(f.requests[0].headers.prefer, 'respond-async');
  assert(f.requests.slice(1).every((item) => item.method === 'GET' && item.path === `${path}/status/${taskId}`
    && item.headers['x-notalone-manual-contact'] === contactId));
});

test('查询失败按原准备提交校验未领取证明，错键不释放身份', async (t) => {
  const proof = { contact_id: contactId, session_id: sessionId, request_key: requestKey, state: 'not_reserved' };
  let actualProof = proof;
  const f = await fixture(t, (req) => req.method === 'POST' ? { status: 202, data: pending }
    : { status: 409, data: { error: 'assistant_session_rejected', reason: 'source_deleted', no_generation: actualProof } });
  await assert.rejects(f.client.perform(request), (error) => error instanceof BackendRequestFailure
    && error.noGeneration?.requestKey === requestKey && error.reason === 'source_deleted');
  actualProof = { ...proof, request_key: randomUUID() };
  await assert.rejects(f.client.perform(request), (error) => error instanceof BackendRequestFailure && error.noGeneration === undefined);
});

test('取消查询及时返回并向原任务表达取消意图，不提交生成', async (t) => {
  let accepted;
  const started = new Promise((resolve) => { accepted = resolve; });
  let cancelled;
  const deleted = new Promise((resolve) => { cancelled = resolve; });
  const f = await fixture(t, (req) => {
    if (req.method === 'POST') { accepted(); return { status: 202, data: pending }; }
    if (req.method === 'DELETE') { cancelled(); return { data: { state: 'cancelling' } }; }
    return { status: 202, data: pending };
  });
  const controller = new AbortController();
  const result = f.client.perform({ ...request, signal: controller.signal });
  await started;
  // 等首个状态查询，确保task_id已由客户端实际核验。
  const untilQuery = setInterval(() => {
    if (f.requests.some((item) => item.method === 'GET')) { clearInterval(untilQuery); controller.abort(); }
  }, 5);
  t.after(() => clearInterval(untilQuery));
  await assert.rejects(result, (error) => error instanceof BackendRequestFailure && error.kind === 'cancelled');
  await deleted;
  assert.equal(f.requests.filter((item) => item.method === 'POST').length, 1);
  assert.equal(f.requests.at(-1).path, `${path}/status/${taskId}`);
});

test('cancelPending覆盖查询间隔，客户端不会遗留下一轮请求', async (t) => {
  let queried;
  const read = new Promise((resolve) => { queried = resolve; });
  const f = await fixture(t, (req) => {
    if (req.method === 'GET') queried();
    return req.method === 'DELETE' ? { data: { state: 'cancelling' } } : { status: 202, data: pending };
  });
  const result = f.client.perform(request);
  await read;
  f.client.cancelPending();
  await assert.rejects(result, (error) => error instanceof BackendRequestFailure && error.kind === 'cancelled');
});

test('任务身份变化及多余正文拒绝继续查询，旧同步回执仍兼容', async (t) => {
  let reply = receipt;
  const f = await fixture(t, (req) => req.method === 'POST' ? { status: 202, data: pending }
    : { status: reply === receipt ? 200 : 202, data: reply });
  assert.deepEqual((await f.client.perform(request)).data, receipt);
  for (const invalid of [{ ...pending, preparation_id: randomUUID() }, { ...pending, private_text: '不得采纳的合成正文' }]) {
    reply = invalid;
    await assert.rejects(f.client.perform(request), (error) => error instanceof BackendRequestFailure && error.kind === 'response');
  }
  const sync = await fixture(t, () => ({ data: receipt }));
  assert.deepEqual((await sync.client.perform(request)).data, receipt);
  assert.equal(sync.requests.length, 1);
});

test('202 回执允许附加非敏感扩展字段，仍等候同一任务', { timeout: 12_000 }, async (t) => {
  const extended = { ...pending, retry_after: 1, expires_at: '2026-01-01T00:00:00+08:00' };
  let polls = 0;
  const f = await fixture(t, (req) => {
    if (req.method === 'POST') return { status: 202, data: extended };
    polls += 1;
    return polls < 2 ? { status: 202, data: pending } : { data: receipt };
  });
  assert.deepEqual((await f.client.perform(request)).data, receipt);
  assert.equal(f.requests.filter((item) => item.method === 'DELETE').length, 0);
});

test('202 体校验失败但含合法准备标识时仍取消服务端任务', { timeout: 12_000 }, async (t) => {
  for (const invalid of [{ ...pending, state: 'unexpected' }, { ...pending, retry_after: 0 },
    { ...pending, private_text: '不得出现在回执里的合成正文' }]) {
    const f = await fixture(t, (req) => req.method === 'DELETE'
      ? { data: { state: 'cancelling' } }
      : { status: 202, data: invalid });
    await assert.rejects(f.client.perform(request), (error) => error instanceof BackendRequestFailure && error.kind === 'response');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const deleted = f.requests.filter((item) => item.method === 'DELETE');
    assert.equal(deleted.length, 1, '202 体非法但已取得合法 preparation_id 时必须回收服务端准备任务');
    assert.equal(deleted[0].path, `${path}/status/${taskId}`);
    assert.equal(f.requests.filter((item) => item.method === 'GET').length, 0, '非法回执不得继续查询');
  }
});

test('202 前取消返回取消错误，不遗留后续查询或可误认的删除', { timeout: 12_000 }, async (t) => {
  const requests = [];
  let releaseStart;
  const started = new Promise((resolve) => { releaseStart = resolve; });
  const server = createServer(async (req, res) => {
    for await (const _chunk of req) { /* 只排空合成正文。 */ }
    requests.push({ method: req.method, path: req.url });
    if (req.method === 'POST') { releaseStart(); return; } // 保持 202 在途，首帧标识未知。
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const client = new JsonClient({ port: server.address().port, token: 'synthetic-preparation-token', pid: process.pid });
  t.after(async () => { client.cancelPending(); await new Promise((resolve) => server.close(resolve)); });
  const controller = new AbortController();
  const result = client.perform({ ...request, signal: controller.signal });
  await started;
  controller.abort();
  await assert.rejects(result, (error) => error instanceof BackendRequestFailure && error.kind === 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(requests.filter((item) => item.method === 'POST').length, 1);
  assert.equal(requests.filter((item) => item.method === 'DELETE').length, 0, '未取得准备标识时不得伪造删除');
  assert.equal(requests.filter((item) => item.method === 'GET').length, 0);
});
