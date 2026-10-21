import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

// 首帧读取失败必须写入可见错误状态，且可重试恢复；清理/取消路径不经过这里。
const require = createRequire(path.resolve('package.json'));
const result = await build({
  stdin: { contents: `
    export { readInitialState, initialReadError } from './src/renderer/initial-read';
  `, resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'esm', write: false, loader: { '.css': 'empty' },
  plugins: [{ name: 'shared-react', setup(builder) {
    builder.onResolve({ filter: /^react(?:\/.*)?$/ }, args => ({ path: pathToFileURL(require.resolve(args.path)).href, external: true }));
  } }],
});
const { readInitialState, initialReadError } = await import(
  `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);

function harness(responses) {
  const calls = { read: 0, received: [], errors: [] };
  const busy = { current: false };
  let active = true;
  const read = () => {
    calls.read += 1;
    const next = responses.shift();
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  };
  const run = () => readInitialState({
    read,
    receive: (state) => calls.received.push(state),
    reportError: (message) => calls.errors.push(message),
    isActive: () => active,
    busy,
  });
  return { calls, run, setActive: (value) => { active = value; } };
}

test('首帧读取失败写入可见错误，重试成功后收到状态并清除错误', async () => {
  const f = harness([new Error('synthetic ipc failure'), { revision: 1, scopeRevision: 1 }]);
  assert.equal(await f.run(), 'failed');
  assert.deepEqual(f.calls.received, []);
  assert.deepEqual(f.calls.errors, [initialReadError]);
  assert.equal(initialReadError, '状态读取失败，请重试。');
  // 重试可恢复：同一读取入口再次调用，成功后错误清空并收到首帧状态。
  assert.equal(await f.run(), 'received');
  assert.deepEqual(f.calls.received, [{ revision: 1, scopeRevision: 1 }]);
  assert.deepEqual(f.calls.errors, [initialReadError, '']);
  assert.equal(f.calls.read, 2, '重试必须重新读取，不能吞掉失败后永久停在空状态');
});

test('同一时刻只允许一次首帧读取，重复调用不覆盖进行中的读取', async () => {
  let release;
  const f = harness([new Promise((resolve) => { release = () => resolve({ revision: 2, scopeRevision: 1 }); })]);
  const pending = f.run();
  assert.equal(await f.run(), 'busy');
  assert.equal(f.calls.read, 1);
  release();
  assert.equal(await pending, 'received');
  assert.deepEqual(f.calls.received, [{ revision: 2, scopeRevision: 1 }]);
});

test('卸载或范围切换后到达的首帧读取不再写状态，保留清理路径静默', async () => {
  let rejectRead;
  const f = harness([new Promise((_, reject) => { rejectRead = () => reject(new Error('synthetic ipc failure')); })]);
  const pending = f.run();
  f.setActive(false);
  rejectRead();
  assert.equal(await pending, 'inactive');
  assert.deepEqual(f.calls.errors, [], '失效范围的首帧失败不得写入新范围错误');
  assert.deepEqual(f.calls.received, []);
});

test('首帧成功后不再重复清空错误之外的状态，读取入口可多次恢复', async () => {
  const f = harness([{ revision: 3, scopeRevision: 1 }]);
  assert.equal(await f.run(), 'received');
  assert.deepEqual(f.calls.errors, ['']);
  assert.deepEqual(f.calls.received, [{ revision: 3, scopeRevision: 1 }]);
});
