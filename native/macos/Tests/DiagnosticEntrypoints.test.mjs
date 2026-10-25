import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const executable = fileURLToPath(new URL('.build/debug/notalone-sync-probe', root));
const cli = readFileSync(new URL('Sources/NotAloneSyncCLI/main.swift', root), 'utf8');
const legacyApp = readFileSync(new URL('Sources/NotAloneSyncApp/MenuBarProbeApp.swift', root), 'utf8');
const core = readFileSync(new URL('Sources/NotAloneSyncCore/CaptureSupport.swift', root), 'utf8');

function run(arguments_) {
  // 先核对旧捕获器已移除，避免回归测试本身恢复正文读取。
  assert.doesNotMatch(cli + legacyApp + core, /WeChatCaptureProbe|captureChatRegion/);
  return spawnSync(executable, arguments_, { encoding: 'utf8', timeout: 2000 });
}

test('默认入口和帮助只展示名称定位用法', () => {
  for (const arguments_ of [[], ['--help']]) {
    const result = run(arguments_);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /--session/);
    assert.doesNotMatch(result.stdout, /--watch|--crop|--show-text/);
    assert.equal(result.stderr, '');
  }
});

test('旧正文采集参数在启动时失败且不输出正文', () => {
  for (const arguments_ of [['--watch'], ['--show-text'], ['--crop', '0,0,1,1'],
    ['--interval', '1'], ['--self-test', '--watch']]) {
    const result = run(arguments_);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /旧正文 OCR 入口已退役/);
  }
});

test('显式自检只运行合成数据', () => {
  const result = run(['--self-test']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /合成自检通过；未采集屏幕或执行 OCR/);
});

test('Worker 先完成合成图预热，再发送 ready', { timeout: 60_000 }, async () => {
  const child = spawn(executable, ['--session-worker', '--json'], {
    env: { ...process.env, NOTALONE_SESSION_WORKER_MEASUREMENTS: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    stdout += chunk;
    if (stdout.includes('"event":"ready"')) resolveReady();
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.once('exit', code => {
    if (!stdout.includes('"event":"ready"')) {
      rejectReady(new Error(`Worker exited before ready (${code}): ${stderr}`));
    }
  });

  const timer = setTimeout(() => child.kill('SIGKILL'), 55_000);
  try {
    await ready;
    child.stdin.end();
    await closed;

    const warmupStarted = stderr.indexOf('session-worker-warmup-v1 started');
    const warmupCompleted = stderr.indexOf('session-worker-warmup-v1 completed');
    assert.ok(warmupStarted >= 0, stderr);
    assert.ok(warmupCompleted > warmupStarted, stderr);
    assert.doesNotMatch(stderr, /captureRequested|frameReceived|headerOcrStarted/);
    assert.doesNotMatch(stderr, /合成A1/);
    assert.equal(stdout.trim(), '{"event":"ready","version":1}');
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
});

test('历史菜单栏入口无 App 初始化或采集调用', () => {
  assert.doesNotMatch(legacyApp, /NSApplication|CGPreflight|CGRequest|LocalOcr|Timer/);
  assert.match(legacyApp, /exit\(EXIT_FAILURE\)/);
});
