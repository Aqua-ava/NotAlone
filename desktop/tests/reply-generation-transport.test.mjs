import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { build } from 'esbuild';

const bundled = await build({ stdin: { contents: `
  export { JsonClient } from './src/main/backend/json-client';
  export { generateReply } from './src/main/reply/client';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { JsonClient, generateReply } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const contactId = '38c6e784-93dc-476b-8a2c-2733523a23b9';
const sessionId = 'ad630563-b558-40ec-bdaa-c34201756c42';
const requestKey = '69b51458-cf1d-47d2-a96c-fd465f15c353';
const receipt = { session_id: sessionId, request_key: requestKey, turn_id: '868bd7c5-d71c-435e-9ab1-10ff304b67a9',
  input_version_id: 'a4afba16-2fa1-45d0-ac42-de8d06045bda', state: 'running' };
const completed = { ...receipt, state: 'completed', reply_request_id: requestKey,
  context_receipt: { evidence_ids: [] }, candidates: [{ candidate_id: requestKey, text: '合成候选',
    basis: '合成依据', citation_ids: [], risk_notes: [] }] };
const input = { mode: 'rewrite_draft', contactId, contactDisplayName: '合成联系人', draftText: '合成草稿',
  userInstruction: null, includeRelationshipContext: false };
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

function transportClock(t) {
  let now = 0;
  const timers = new Map(), schedule = globalThis.setTimeout, clear = globalThis.clearTimeout;
  // 只替换生产长请求计时器，避免HTTP连接池的短期收尾计时器被虚拟时间影响。
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => {
    if (delay < 8000) return schedule(callback, delay, ...args);
    const handle = {}; timers.set(handle, { at: now + delay, callback, args }); return handle;
  });
  t.mock.method(globalThis, 'clearTimeout', handle => { if (!timers.delete(handle)) clear(handle); });
  return { tick(ms) {
    now += ms;
    for (const [handle, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now && timers.delete(handle)) timer.callback(...timer.args);
    }
  } };
}
async function withGeneration(t, use) {
  const clock = transportClock(t);
  const entered = deferred();
  let executing, business = 'running', requests = 0;
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic_token');
    req.resume();
    if (req.url.endsWith('/prepare')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(receipt)); return; }
    requests++;
    executing = res;
    res.once('close', () => { if (!res.writableEnded) business = 'reply_cancelled'; });
    entered.resolve();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const client = new JsonClient({ address: `127.0.0.1:${port}`, port, token: 'synthetic_token', pid: process.pid });
  const backend = { getConnectionGeneration: () => 7,
    requestJson: async request => ({ generation: 7, data: (await client.perform(request)).data }) };
  const controller = new AbortController();
  const pending = generateReply(backend, input, requestKey, controller.signal, sessionId).then(result => ({ result }), error => ({ error }));
  try {
    await entered.promise;
    await use({ clock, client, controller, pending, executing, business: () => business, requests: () => requests });
  } finally { client.cancelPending(); executing?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}

// 仅推进生产运输计时器；HTTP、认证、prepare回执和结果归属使用真实实现。
test('模型已成功且用户未取消时，生成运输等待涵盖前后核验和可靠保存', async t => {
  await withGeneration(t, async ({ clock, controller, pending, executing, business, requests }) => {
    clock.tick(10_000); // 生成前复验。
    clock.tick(5_000); const physical = 'succeeded'; // 模型本身未触及20秒期限。
    clock.tick(11_000); // 物理成功后的来源复验和同事务保存尚未结束。
    await new Promise(setImmediate);
    executing.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(completed));
    const outcome = await pending;
    assert.equal(controller.signal.aborted, false);
    assert.equal(physical, 'succeeded');
    assert.equal(outcome.error?.kind, undefined, `无用户取消却运输失败：${outcome.error?.kind}`);
    if (outcome.error) throw new Error('合成生成尚未完成');
    assert.equal(business(), 'running');
    assert.equal(outcome.result.candidates.length, 1);
    assert.equal(requests(), 1, '运输等待不能重放生成。');
  });
});

for (const reason of ['user', 'shutdown', 'disconnect', 'deadline']) {
  test(`已接纳生成等待期间${reason}仍结束运输且不接受迟到候选或自动重放`, async t => {
    await withGeneration(t, async ({ clock, client, controller, pending, executing, requests }) => {
      clock.tick(26_000);
      if (reason === 'user') controller.abort();
      else if (reason === 'shutdown') client.cancelPending();
      else if (reason === 'disconnect') executing.destroy();
      else clock.tick(94_000);
      const outcome = await pending;
      assert.equal(outcome.error?.kind, ['user', 'shutdown'].includes(reason) ? 'cancelled' : 'connection');
      assert.equal(outcome.result, undefined);
      executing.end(JSON.stringify(completed));
      assert.equal((await pending).result, undefined, '已取消或断连不能随后交付候选。');
      assert.equal(controller.signal.aborted, reason === 'user');
      assert.equal(requests(), 1);
    });
  });
}
