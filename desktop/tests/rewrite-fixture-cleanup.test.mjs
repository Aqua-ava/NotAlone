import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { build } from 'esbuild';

const compiled = await build({ stdin: { contents: "export { RewriteFixture } from './tests/rewrite-backend-fixture';",
  resolveDir: process.cwd() }, bundle: true, platform: 'node', format: 'cjs', write: false });
const exported = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), exported, exported.exports);
const { RewriteFixture } = exported.exports;

async function fixture() {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null, stdin: new PassThrough(), stdout: new PassThrough(),
  });
  const value = new RewriteFixture('/synthetic-unused', '/synthetic-unused/python', child);
  child.stdout.write(JSON.stringify({ ready: { database_url: 'synthetic', owner_id: 'synthetic', contact_ids: [] } }) + '\n');
  await value.ready;
  value.command = async () => ({});
  return { value, child, end(code = 0) { child.exitCode = code; child.emit('exit', code, null); child.stdout.end(); } };
}

test('三个服务收尾超过旧十秒窗口后正常退出仍可确认', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controlled = await fixture();
  const cleanup = controlled.value.cleanup();
  await Promise.resolve();
  t.mock.timers.tick(12_000);
  controlled.end();
  await cleanup;
  assert.equal(controlled.child.listenerCount('exit'), 1, '有界等待的监听器已移除');
});

test('六十秒仍未退出拒绝确认且不杀未知进程', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controlled = await fixture();
  const cleanup = controlled.value.cleanup();
  const rejected = assert.rejects(cleanup, /60 秒内未退出/u);
  await Promise.resolve();
  t.mock.timers.tick(60_000);
  await rejected;
  assert.equal(controlled.child.listenerCount('exit'), 1);
  controlled.end();
});

test('命令失败或非零退出不能因等待成功而消失', async () => {
  for (const commandFailed of [false, true]) {
    const controlled = await fixture();
    const original = new Error('合成停止命令失败');
    if (commandFailed) controlled.value.command = async () => { throw original; };
    const cleanup = controlled.value.cleanup();
    const rejected = assert.rejects(cleanup, (error) => {
      assert.match(error.message, /未正常清理/u);
      if (commandFailed) assert.equal(error.cause, original);
      return true;
    });
    await Promise.resolve();
    controlled.end(commandFailed ? 0 : 7);
    await rejected;
  }
});
