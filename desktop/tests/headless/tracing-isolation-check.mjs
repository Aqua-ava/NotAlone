import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

if (process.env.CONDA_DEFAULT_ENV !== 'NotAlone' || !process.env.CONDA_PREFIX) throw new Error('须激活 Conda NotAlone。');
const pages = process.argv.slice(2);
assert.ok(pages.length === 0 || (pages.length === 1 && pages[0] === '--pages'), '只允许可选 --pages，限定改写页面组。');
let requests = 0;
const collector = createServer((request, response) => {
  if (request.method === 'POST') requests++;
  request.resume();
  response.writeHead(200, { 'Content-Type': 'application/json' });
  response.end('{}');
});
await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));
const address = collector.address();
const directory = await mkdtemp(path.join(tmpdir(), 'notalone-tracing-check-'));
// 不审阅或输出宿主密钥；追踪配置先剥除，再换成本轮显式合成值。
const synthetic = { LANGSMITH_TRACING: 'true', LANGSMITH_TRACING_V2: 'true', LANGCHAIN_TRACING_V2: 'true',
  LANGCHAIN_TRACING: 'true', LANGCHAIN_HANDLER: 'true', LANGSMITH_API_KEY: 'synthetic-unused-key',
  LANGCHAIN_API_KEY: 'synthetic-unused-key', LANGSMITH_ENDPOINT: `http://127.0.0.1:${address.port}`,
  LANGCHAIN_ENDPOINT: `http://127.0.0.1:${address.port}`, LANGSMITH_PROJECT: 'synthetic-isolation', LANGCHAIN_PROJECT: 'synthetic-isolation' };
const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LANGSMITH_') && !key.startsWith('LANGCHAIN_')));
Object.assign(inherited, { NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost', HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '' });
const original = process.env;
async function invoke(environment) {
  const child = spawn(path.join(process.env.CONDA_PREFIX, 'bin/python'), [path.resolve('tests/fixtures/tracing-pipeline.py')],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let diagnostic = '';
  child.stderr.on('data', (chunk) => { if (diagnostic.length < 4000) diagnostic += chunk; });
  child.stdout.on('data', (chunk) => { output += chunk; });
  const timer = setTimeout(() => child.kill('SIGTERM'), 15_000);
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, `真实合成pipeline须正常退出：${diagnostic}`);
    assert.equal(JSON.parse(output).pipeline_completed, true);
  } finally { clearTimeout(timer); }
}
try {
  const modulePath = path.join(directory, 'environment.mjs');
  await build({ entryPoints: [fileURLToPath(new URL('../isolated-environment.ts', import.meta.url))],
    outfile: modulePath, bundle: true, platform: 'node', format: 'esm' });
  const { isolatedAppEnvironment } = await import(pathToFileURL(modulePath).href);
  await invoke({ ...inherited, ...synthetic });
  assert.ok(requests > 0, '正控制须证明真实LangChain回调可到达本轮收集器。');
  const positiveRequests = requests;
  requests = 0;
  process.env = { ...inherited, ...synthetic };
  const isolated = isolatedAppEnvironment(directory);
  await invoke(isolated);
  assert.equal(requests, 0, '隔离Node→Python不应向收集器上报trace。');
  console.log(JSON.stringify({ positiveRequests, isolatedRequests: requests, pipelineCompleted: true, syntheticOnly: true }));
  if (pages.length) {
    // 经公共CLI进入真实页面与生产流水线，父环境仍是本轮的合成追踪配置。
    const child = spawn(process.execPath, [path.resolve('scripts/test-pages.mjs'), '--case', 'draft-rewrite', '--timeout-seconds', '90'],
      { env: { ...inherited, ...synthetic }, stdio: ['ignore', 'inherit', 'inherit'] });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, '恶意启用追踪的合成父环境下，真实页面组须正常退出。');
    assert.equal(requests, 0, '公共CLI→Node→Python生产流水线不应向收集器上报trace。');
    console.log(JSON.stringify({ pageGroup: 'draft-rewrite', collectorRequests: requests, syntheticOnly: true }));
  }
} finally {
  process.env = original;
  collector.closeAllConnections(); await new Promise((resolve) => collector.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
