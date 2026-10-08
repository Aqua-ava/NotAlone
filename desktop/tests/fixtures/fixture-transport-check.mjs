// 无桌面传输检查：自有 Node 子进程、真实管道和回环 HTTP，不加载 App/Playwright。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const current = await mkdtemp(path.join(tmpdir(), 'notalone-fixture-transport-'));
let checks = 0;
async function withChild(script, run) {
  const child = spawn(process.execPath, ['-e', script], { env: {}, stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise((resolve) => child.once('close', resolve));
  try { await run(child); }
  finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  }
  checks++;
}
try {
  const modulePath = path.join(current, 'transport.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../fixture-transport.ts', import.meta.url))],
    outfile: modulePath, bundle: true, platform: 'node', format: 'esm' });
  const { FixtureTransport, requestFixtureHttp } = await import(pathToFileURL(modulePath).href);
  await withChild(`
    process.stdout.write('{"rea');
    setTimeout(() => process.stdout.write('dy":{"label":"synthetic"}}\\n'), 10);
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line);
      setTimeout(() => process.stdout.write(JSON.stringify({id:request.id,result:{operation:request.operation}})+'\\n'),
        request.operation==='slow' ? 30 : 0);
    });
  `, async (child) => {
    const transport = new FixtureTransport(child, '导入');
    assert.deepEqual(await transport.ready, { label: 'synthetic' });
    assert.deepEqual(await Promise.all([transport.command('slow'), transport.command('fast')]),
      [{ operation: 'slow' }, { operation: 'fast' }]);
  });
  await withChild(`
    process.stdout.write('{"ready":{}}\\n');
    process.stdin.once('data', () => process.exit(3));
  `, async (child) => {
    const transport = new FixtureTransport(child, '改写');
    await transport.ready;
    await assert.rejects(transport.command('pending'), /夹具已退出/);
    await assert.rejects(transport.command('after-exit'), /夹具已退出/);
  });
  await withChild(`
    process.stdout.write('{"ready":{}}\\n');
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const request=JSON.parse(line);
      if(request.operation==='next') process.stdout.write(JSON.stringify({id:request.id,result:{next:true}})+'\\n');
    });
  `, async (child) => {
    const transport = new FixtureTransport(child, '导入', 70_000, 30);
    await transport.ready;
    await assert.rejects(transport.command('timeout'), /模型边界控制未完成/);
    assert.deepEqual(await transport.command('next'), { next: true });
  });
  await withChild(`
    process.stdout.write('invalid-frame\\n');
    process.stdin.once('data', line => {
      const request=JSON.parse(line);
      process.stdout.write(JSON.stringify({id:request.id,result:{stopped:true}})+'\\n', () => process.exit(0));
    });
  `, async (child) => {
    const transport = new FixtureTransport(child, '改写');
    await assert.rejects(transport.ready, /传输记录无效/);
    assert.deepEqual(await transport.command('stop'), { stopped: true });
  });
  await withChild(`process.stdin.resume();`, async (child) => {
    const transport = new FixtureTransport(child, '导入', 20);
    await assert.rejects(transport.ready, /夹具启动超时/);
  });

  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const content = Buffer.concat(parts).toString();
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ path: request.url, method: request.method,
      authorized: request.headers.authorization === 'Bearer synthetic-transport',
      body: content ? JSON.parse(content) : null }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const infoPath = path.join(current, 'backend.info');
    await writeFile(infoPath, `address=127.0.0.1:${server.address().port}\ntoken=synthetic-transport\n`, { mode: 0o600 });
    assert.deepEqual(await requestFixtureHttp(infoPath, '/synthetic'), { status: 200,
      data: { path: '/synthetic', method: 'GET', authorized: true, body: null } });
    assert.deepEqual(await requestFixtureHttp(infoPath, '/synthetic', { selected: 'synthetic' }), { status: 200,
      data: { path: '/synthetic', method: 'POST', authorized: true, body: { selected: 'synthetic' } } });
    await writeFile(infoPath, 'address=https://outside.invalid\ntoken=synthetic-transport\n');
    await assert.rejects(requestFixtureHttp(infoPath, '/synthetic'), /受控握手未就绪/);
    checks++;
  } finally { await new Promise((resolve) => server.close(resolve)); }
} finally { await rm(current, { recursive: true, force: true }); }
process.stdout.write(`共享夹具传输 ${checks} 项通过；自有子进程、回环 HTTP 与临时目录残留 0。\n`);
