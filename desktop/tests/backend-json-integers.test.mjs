import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { build } from 'esbuild';

const output = await build({ stdin: { contents: `
  export { parseIntegerJson, stringifyIntegerJson } from './src/shared/integer-json';
  export { JsonClient } from './src/main/backend/json-client';
`, resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'esm', write: false });
const { parseIntegerJson, stringifyIntegerJson, JsonClient } = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

test('通用JSON保留超安全范围整数的数字wire，不把大整数转成字符串或舍入', () => {
  const wire = '{"revision":9007199254740993,"negative":-9007199254740993}';
  const parsed = parseIntegerJson(wire);
  assert.equal(parsed.revision, 9007199254740993n); assert.equal(parsed.negative, -9007199254740993n);
  assert.equal(stringifyIntegerJson(parsed), wire);
});

test('安全整数、浮点与文字保持原类型，IPC结构化克隆保留大整数', () => {
  const parsed = parseIntegerJson('{"nested":[9007199254740993,42,1.25,"9007199254740993"],"safe":9007199254740991}');
  const received = structuredClone(parsed);
  assert.deepEqual(received.nested, [9007199254740993n, 42, 1.25, '9007199254740993']);
  assert.equal(received.safe, Number.MAX_SAFE_INTEGER);
  assert.equal(stringifyIntegerJson(received), '{"nested":[9007199254740993,42,1.25,"9007199254740993"],"safe":9007199254740991}');
});

test('真实共享HTTP客户端以数字wire往返大整数，同时保持安全整数与浮点', async t => {
  let received = '';
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer synthetic_integer_token');
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = Buffer.concat(chunks).toString('utf8');
    res.setHeader('Content-Type', 'application/json'); res.end(received);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new JsonClient({ port: server.address().port, token: 'synthetic_integer_token', pid: process.pid });
  t.after(async () => { client.cancelPending(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  // 合成回环端点只验证运输层的JSON合同，不模拟任何已退役的业务路由。
  const result = await client.perform({ method: 'POST', path: '/api/synthetic/integer-echo',
    body: { revision: 9007199254740993n, safe: 42, fraction: 1.25 } });
  assert.equal(received, '{"revision":9007199254740993,"safe":42,"fraction":1.25}');
  assert.equal(result.data.revision, 9007199254740993n); assert.equal(result.data.safe, 42); assert.equal(result.data.fraction, 1.25);
});
