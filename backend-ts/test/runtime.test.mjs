import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHost } from './support.mjs';

test('官方 profile 启动同进程业务并经真实 DSH 执行单次语义请求', { timeout: 30000 }, async (t) => {
  const host = await startHost(t);
  const health = await host.request('/health');
  assert.equal(health.pid, host.child.pid);
  const result = await host.request('/semantic', { owner_id: 'owner-a', contact_id: 'contact-1', text: '合成输入' });
  assert.deepEqual(result, { text: '合成候选', evidence: 'source-a1' });
  assert.equal(host.requests.length, 1);
});

test('有界工具循环只能检索当前范围并返回结构化候选', { timeout: 30000 }, async (t) => {
  const host = await startHost(t, (_req, res, requests, events) => {
    if (requests.length === 1) {
      events.splice(1, 3,
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'read-1', name: 'lookup_source', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
        { type: 'content_block_stop', index: 0 });
      events[4].delta.stop_reason = 'tool_use';
    }
    res.setHeader('content-type', 'text/event-stream');
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  const result = await host.request('/loop', { owner_id: 'owner-a', contact_id: 'contact-1', text: '查找合成来源' });
  assert.deepEqual(result, { text: '合成候选', evidence: 'source-a1' });
  assert.equal(host.requests.length, 2);
  assert.deepEqual(host.requests[0].body.tools.map(t => t.name), ['lookup_source']);
  assert.match(JSON.stringify(host.requests[1].body), /source-a1/);
  const health = await host.request('/health');
  assert.deepEqual(health.resources, { agents: 0, sessions: 0 });
});

test('取消单次语义请求后拒绝结果并释放活动运行', { timeout: 10000 }, async (t) => {
  let received; const dispatched = new Promise(r => { received = r; });
  const host = await startHost(t, () => received());
  const scope = { owner_id: 'owner-a', contact_id: 'contact-1' };
  const pending = host.request('/semantic', { ...scope, run_id: 'cancel-1', text: '等待取消' });
  const rejected = assert.rejects(pending, /CANCELED/);
  await dispatched;
  assert.deepEqual(await host.request('/cancel', { ...scope, run_id: 'cancel-1' }), { canceled: true });
  await rejected;
  assert.equal((await host.request('/health')).active, 0);
});

test('错误结构、跨范围引用和非正常终止均拒绝且不重试', { timeout: 10000 }, async (t) => {
  const outputs = ['{"text":"x","evidence":"source-a1","extra":1}', '{"text":2,"evidence":"source-a1"}', '{"text":"x"}', '{"text":"x","evidence":"source-b1"}', '{broken', '{"text":"x","evidence":"source-a1"}'];
  const host = await startHost(t, (_req, res, requests, events) => {
    events[2].delta.text = outputs[requests.length - 1];
    if (requests.length === 6) events[4].delta.stop_reason = 'max_tokens';
    res.setHeader('content-type', 'text/event-stream');
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  for (let i = 0; i < outputs.length; i++) await assert.rejects(host.request('/semantic', { owner_id: 'owner-a', contact_id: 'contact-1', text: '无效结构' }));
  assert.equal(host.requests.length, 6);
  assert.equal((await host.request('/health')).active, 0);
});

test('两个 owner 各两个联系人并发隔离，未知范围不出站', { timeout: 10000 }, async (t) => {
  const host = await startHost(t, (_req, res, requests, events) => {
    const source = JSON.stringify(requests.at(-1).body).match(/source-[ab][12]/)[0];
    events[2].delta.text = JSON.stringify({ text: '隔离候选', evidence: source });
    res.setHeader('content-type', 'text/event-stream');
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  const scopes = [['owner-a', 'contact-1', 'source-a1'], ['owner-a', 'contact-2', 'source-a2'], ['owner-b', 'contact-1', 'source-b1'], ['owner-b', 'contact-2', 'source-b2']];
  const results = await Promise.all(scopes.map(([owner_id, contact_id]) => host.request('/loop', { owner_id, contact_id, text: '并发合成' })));
  assert.deepEqual(results.map(r => r.evidence), scopes.map(s => s[2]));
  await assert.rejects(host.request('/loop', { owner_id: 'unknown', contact_id: 'contact-1', text: '禁止' }), /SCOPE_DENIED/);
  assert.equal(host.requests.length, 4);
  for (const request of host.requests) assert.equal(new Set(JSON.stringify(request.body).match(/source-[ab][12]/g)).size, 1);
  assert.deepEqual((await host.request('/health')).resources, { agents: 0, sessions: 0 });
});

test('模型持续调用工具最多三次请求，不能无限循环', { timeout: 10000 }, async (t) => {
  const host = await startHost(t, (_req, res, _requests, events) => {
    events.splice(1, 3,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'repeat', name: 'lookup_source', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 });
    events[4].delta.stop_reason = 'tool_use';
    res.setHeader('content-type', 'text/event-stream');
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  await assert.rejects(host.request('/loop', { owner_id: 'owner-a', contact_id: 'contact-1', text: '有界' }), /LOOP_FAILED/);
  assert.equal(host.requests.length, 3);
  assert.deepEqual((await host.request('/health')).resources, { agents: 0, sessions: 0 });
});

test('删除合成来源后在途结果失效且不能从新运行恢复', { timeout: 10000 }, async (t) => {
  let received; const dispatched = new Promise(r => { received = r; });
  const host = await startHost(t, () => received());
  const scope = { owner_id: 'owner-a', contact_id: 'contact-1' };
  const pending = assert.rejects(host.request('/loop', { ...scope, text: '删除前等待' }), /CANCELED/);
  await dispatched;
  assert.deepEqual(await host.request('/revoke', scope), { revoked: true });
  await pending;
  await assert.rejects(host.request('/semantic', { ...scope, text: '不能恢复' }), /SCOPE_DENIED/);
  assert.equal(host.requests.length, 1);
});

test('真实 provider 超时与循环取消均有界释放，不自动重试', { timeout: 10000 }, async (t) => {
  const host = await startHost(t, () => {});
  for (const path of ['/semantic', '/loop']) {
    await assert.rejects(host.request(path, { owner_id: 'owner-a', contact_id: 'contact-1', text: '不响应', deadline_ms: 100 }), /TIMED_OUT/);
    assert.deepEqual((await host.request('/health')).resources, { agents: 0, sessions: 0 });
  }
  assert.equal(host.requests.length, 2);
});

test('成功和输出拒绝后仅有临时配置及匿名ID，无正文文件或额外上报', { timeout: 10000 }, async (t) => {
  const host = await startHost(t);
  await host.request('/loop', { owner_id: 'owner-a', contact_id: 'contact-1', text: 'SENSITIVE_SYNTHETIC_SENTINEL' });
  await assert.rejects(host.request('/semantic', { owner_id: 'owner-b', contact_id: 'contact-1', text: 'SENSITIVE_SYNTHETIC_SENTINEL' }));
  const id = host.requests[0].headers['x-deepseek-harness-user-id'];
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.match(host.requests[0].headers['x-deepseek-harness-session-id'], /^[a-f0-9-]{36}$/);
  const files = await host.files();
  assert.deepEqual(Object.keys(files).sort(), ['.anonymous-user-id', 'profiles/notalone/cordis.patch.yml', 'profiles/notalone/cordis.yml', 'profiles/notalone/package.json']);
  assert.equal(files['.anonymous-user-id'].trim(), id);
  assert.doesNotMatch(JSON.stringify(files) + host.output, /SENSITIVE_SYNTHETIC_SENTINEL|合成候选|source-a1|source-b1/);
  for (const request of host.requests) {
    assert.equal(request.path, '/anthropic/v1/messages');
    assert.doesNotMatch(JSON.stringify(request), /dsh_session_log|dsh_plugin_packages|otel|compaction/);
  }
  const connections = host.output.split('\n').filter(l => l.startsWith('VALIDATION_NETWORK ')).map(l => JSON.parse(l.slice(19)));
  assert.ok(connections.length > 0);
  assert.ok(connections.every(c => c.host === '127.0.0.1'), JSON.stringify(connections));
  await host.stop();
  assert.deepEqual(await host.files(), files);
  const restarted = await startHost(t);
  await restarted.request('/semantic', { owner_id: 'owner-a', contact_id: 'contact-1', text: '重新启动' });
  assert.notEqual(restarted.requests[0].headers['x-deepseek-harness-user-id'], id);
  assert.deepEqual((await restarted.request('/health')).resources, { agents: 0, sessions: 0 });
});

test('不合作工具使 dispose 等待，官方宿主五秒边界强制结束共享进程', { timeout: 12000 }, async (t) => {
  const host = await startHost(t, (_req, res, _requests, events) => {
    events.splice(1, 3,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'stall', name: 'uncooperative_fixture', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'content_block_stop', index: 0 });
    events[4].delta.stop_reason = 'tool_use';
    res.setHeader('content-type', 'text/event-stream');
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  }, true);
  const pending = assert.rejects(host.request('/loop', { owner_id: 'owner-a', contact_id: 'contact-1', text: '不合作测试', deadline_ms: 100 }));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('工具未进入')), 2000);
    const check = () => { if (host.output.includes('VALIDATION_STALLED')) { clearTimeout(timer); host.child.stdout.off('data', check); resolve(); } };
    host.child.stdout.on('data', check); check();
  });
  const start = performance.now();
  await host.stop();
  const elapsed = performance.now() - start;
  assert.ok(elapsed >= 4500 && elapsed < 8000, `强制退出耗时 ${elapsed}`);
  await pending;
  assert.equal(host.requests.length, 1);
  assert.doesNotMatch(JSON.stringify(await host.files()), /不合作测试/);
});

test('供应商429、500和流中断明确失败，每次仅一次物理请求', { timeout: 10000 }, async (t) => {
  const host = await startHost(t, (_req, res, requests, events) => {
    if (requests.length < 3) { res.statusCode = requests.length === 1 ? 429 : 500; res.end('{"error":{"type":"synthetic"}}'); }
    else { res.setHeader('content-type', 'text/event-stream'); res.end(`event: message_start\ndata: ${JSON.stringify(events[0])}\n\n`); }
  });
  for (let i = 0; i < 3; i++) await assert.rejects(host.request('/semantic', { owner_id: 'owner-a', contact_id: 'contact-1', text: '失败' }), /MODEL_FAILED/);
  assert.equal(host.requests.length, 3);
  assert.doesNotMatch(JSON.stringify(await host.files()), /source-a1|失败/);
});

test('模型伪造owner/contact工具参数不能扩大读取范围', { timeout: 10000 }, async (t) => {
  const host = await startHost(t, (_req, res, requests, events) => {
    if (requests.length === 1) {
      events.splice(1, 3,
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'attack', name: 'lookup_source', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"owner_id":"owner-b","contact_id":"contact-2"}' } },
        { type: 'content_block_stop', index: 0 });
      events[4].delta.stop_reason = 'tool_use';
    }
    res.setHeader('content-type', 'text/event-stream');
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''));
  });
  await host.request('/loop', { owner_id: 'owner-a', contact_id: 'contact-1', text: '攻击参数' });
  const toolResult = host.requests[1].body.messages.flatMap(m => m.content).find(b => b.type === 'tool_result');
  assert.equal(toolResult.is_error, true);
  assert.doesNotMatch(JSON.stringify(toolResult), /source-b2/);
});

test('其他联系人不能取消本次运行，合法取消后无正文残留', { timeout: 10000 }, async (t) => {
  let received; const dispatched = new Promise(r => { received = r; });
  const host = await startHost(t, () => received());
  const pending = assert.rejects(host.request('/loop', { owner_id: 'owner-a', contact_id: 'contact-1', run_id: 'owned', text: 'CANCEL_SENTINEL' }), /CANCELED/);
  await dispatched;
  assert.deepEqual(await host.request('/cancel', { owner_id: 'owner-b', contact_id: 'contact-1', run_id: 'owned' }), { canceled: false });
  assert.equal((await host.request('/health')).active, 1);
  await host.request('/cancel', { owner_id: 'owner-a', contact_id: 'contact-1', run_id: 'owned' });
  await pending;
  assert.deepEqual((await host.request('/health')).resources, { agents: 0, sessions: 0 });
  assert.doesNotMatch(JSON.stringify(await host.files()) + host.output, /CANCEL_SENTINEL/);
});

test('异常终止不保存运行正文，重新启动没有旧会话', { timeout: 10000 }, async (t) => {
  const host = await startHost(t);
  await host.request('/loop', { owner_id: 'owner-a', contact_id: 'contact-1', text: 'CRASH_SENTINEL' });
  const [, signal] = await host.stop('SIGKILL');
  assert.equal(signal, 'SIGKILL');
  assert.doesNotMatch(JSON.stringify(await host.files()), /CRASH_SENTINEL|合成候选/);
  const restarted = await startHost(t);
  assert.deepEqual((await restarted.request('/health')).resources, { agents: 0, sessions: 0 });
});
