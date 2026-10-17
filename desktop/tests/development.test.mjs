import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const token = 'a'.repeat(64);

async function resourceBoundary(use, packaged = false) {
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-dev-resource-'));
  const requests = [];
  let handler;
  globalThis.__developmentBoundary = {
    app: { isPackaged: packaged, getAppPath: () => directory },
    net: { fetch: async (url, options) => {
      requests.push({ url, options }); return new Response('synthetic_resource');
    } },
  };
  try {
    await build({ stdin: { contents: "export { installResources } from './src/main/resources'; export { readDevelopmentServer } from './src/main/development'; export * from './src/main/backend/config';", resolveDir: process.cwd() },
      outfile: path.join(directory, 'resources.cjs'), bundle: true, platform: 'node', format: 'cjs',
      plugins: [{ name: 'electron-resource-boundary', setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'boundary' }));
        builder.onLoad({ filter: /.*/, namespace: 'boundary' }, () => ({ contents: 'export const { app, net } = globalThis.__developmentBoundary;' }));
      } }] });
    const { default: resources } = await import(path.join(directory, 'resources.cjs'));
    resources.installResources({ protocol: { handle: (_scheme, value) => { handler = value; } },
      setPermissionRequestHandler() {}, setPermissionCheckHandler() {} },
    { origin: 'http://127.0.0.1:43123', token });
    await use({ request: input => handler(new Request(input)), requests, readDevelopmentServer: resources.readDevelopmentServer,
      configuration: resources, directory });
  } finally { delete globalThis.__developmentBoundary; await rm(directory, { recursive: true, force: true }); }
}

test('开发窗口保持本地协议，资源及查询参数代理到唯一开发服务', async () => {
  await resourceBoundary(async ({ request, requests }) => {
    const response = await request('notalone://app/index.tsx?t=123');
    assert.equal(await response.text(), 'synthetic_resource');
    assert.equal(requests[0].url, 'http://127.0.0.1:43123/index.tsx?t=123');
    assert.equal(requests[0].options.headers['x-notalone-dev-token'], token);
    assert.equal(requests[0].options.redirect, 'error');
  });
});

test('正式包忽略开发服务，错误来源和写请求仍被拒绝', async () => {
  await resourceBoundary(async ({ request, requests }) => {
    await request('notalone://app/index.html');
    assert.match(requests[0].url, /^file:/);
    assert.equal((await request('notalone://other/index.html')).status, 403);
    assert.equal((await request(new Request('notalone://app/index.html', { method: 'POST' }))).status, 403);
    assert.equal(requests.length, 1);
  }, true);
});

test('只有显式源码开发启动可接受回环地址，正式包不能由环境变量打开代理', async () => {
  await resourceBoundary(async ({ readDevelopmentServer }) => {
    const valid = JSON.stringify({ origin: 'http://127.0.0.1:43123', token, projectDirectory: '/synthetic/current' });
    assert.equal(readDevelopmentServer(true, ['--notalone-dev'], valid), undefined);
    assert.equal(readDevelopmentServer(false, [], valid), undefined);
    assert.equal(readDevelopmentServer(false, ['--notalone-dev'], valid).projectDirectory, '/synthetic/current');
    for (const origin of ['https://example.org', 'http://0.0.0.0:43123', 'http://localhost:43123', 'http://127.0.0.1:43123/path', 'http://127.0.0.1:65536']) {
      assert.throws(() => readDevelopmentServer(false, ['--notalone-dev'], JSON.stringify({ origin, token, projectDirectory: '/synthetic/current' })));
    }
  });
});

test('开发模式固定当前仓库源码，同时沿用既有解释器和资料配置', async () => {
  await resourceBoundary(async ({ configuration, directory }) => {
    await writeFile(path.join(directory, 'backend-launch.json'), JSON.stringify({
      pythonExecutable: '/synthetic/python', projectDirectory: '/synthetic/old-checkout',
      envFilePath: '/synthetic/private/runtime.env', backendInfoPath: path.join(directory, 'backend.info'),
    }));
    configuration.configureDevelopmentProject('/synthetic/current-checkout');
    const selected = await configuration.loadBackendConfiguration(directory);
    assert.equal(selected.projectDirectory, '/synthetic/current-checkout');
    assert.equal(selected.pythonExecutable, '/synthetic/python');
    assert.equal(selected.envFilePath, '/synthetic/private/runtime.env');
    const saved = JSON.parse(await readFile(path.join(directory, 'backend-launch.json'), 'utf8'));
    assert.equal(saved.projectDirectory, '/synthetic/old-checkout', '开发覆盖仅在内存，不改写原本配置');
    const environment = process.env.NOTALONE_ENV_FILE;
    try {
      delete process.env.NOTALONE_ENV_FILE;
      delete saved.envFilePath;
      await writeFile(path.join(directory, 'backend-launch.json'), JSON.stringify(saved));
      assert.equal((await configuration.loadBackendConfiguration(directory)).envFilePath, '/synthetic/old-checkout/.env');
    } finally {
      if (environment === undefined) delete process.env.NOTALONE_ENV_FILE;
      else process.env.NOTALONE_ENV_FILE = environment;
    }
  });
});

test('开发命令提供受认证的本机 Vite，限制文件范围并为热更新生成 CSP nonce', async () => {
  const { createDevelopmentServer } = await import('../scripts/development-server.mjs');
  const running = await createDevelopmentServer(process.cwd());
  try {
    assert.match(running.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal((await fetch(running.origin + '/index.html')).status, 403);
    const options = { headers: { 'x-notalone-dev-token': running.token } };
    const html = await (await fetch(running.origin + '/index.html', options)).text();
    assert.match(html, /@vite\/client/);
    assert.match(html, /@react-refresh/);
    assert.match(html, /script-src 'self' 'nonce-[a-f0-9]+'/);
    assert.ok(html.includes(running.origin.replace('http:', 'ws:')));
    assert.doesNotMatch(html, /unsafe-inline|unsafe-eval/);
    assert.equal((await fetch(running.origin + '/@fs' + path.resolve('../.env'), options)).status, 403);
    const client = await (await fetch(running.origin + '/@vite/client', options)).text();
    assert.ok(client.includes(new URL(running.origin).port));
    const source = await (await fetch(running.origin + '/ContactsPage.tsx', options)).text();
    assert.match(source, /import\.meta\.hot/);
  } finally { await running.server.close(); }
});

test('保存多次只在旧进程正常退出后重启，退出未确认时保留现场', async () => {
  const { superviseDevelopmentApp } = await import('../scripts/development-app.mjs');
  const directory = await mkdtemp(path.join(tmpdir(), 'notalone-dev-process-'));
  const executable = path.join(directory, 'app.cjs');
  await writeFile(executable, `process.on('message',message=>{
if(message==='finish')process.exit(0);});process.send({type:'notalone-dev-ready'});setInterval(()=>{},1000);`);
  const children = [], messages = [];
  const running = superviseDevelopmentApp(() => {
    const child = spawn(process.execPath, [executable], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    children.push(child); return child;
  }, message => messages.push(message));
  const until = async predicate => { for (let index = 0; index < 100 && !predicate(); index++) await delay(10); assert.ok(predicate()); };
  try {
    await until(() => messages.some(message => message.includes('已就绪')));
    running.restart(); running.restart();
    await delay(75);
    assert.equal(children.length, 1, '没有正常退出证明时不能强杀或启动第二份');
    children[0].send('finish');
    await until(() => children.length === 2 && messages.filter(message => message.includes('已就绪')).length === 2);
    const stopping = running.stop();
    await delay(50);
    assert.equal(children[1].exitCode, null);
    children[1].send('finish');
    assert.equal(await stopping, 0);
    assert.equal(children.length, 2);
  } finally {
    for (const child of children) if (child.exitCode === null) child.send('finish');
    await running.stop(); await rm(directory, { recursive: true, force: true });
  }
});

test('日常开发入口解释热更新与重启，不把帮助命令变为桌面启动', () => {
  const result = spawnSync(process.execPath, ['scripts/dev.mjs', '--help'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /热更新/);
  assert.match(result.stdout, /Python/);
  assert.match(result.stdout, /--user-data-dir/);
});
