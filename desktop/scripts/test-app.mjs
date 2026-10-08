import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { acquireLease, gateError, leaseStatus, ownedGroupGone, serveLease } from './app-test-lease.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function reject(code, message) { throw gateError(code, message); }

export function parseArguments(args) {
  const values = {};
  const files = [];
  const flags = new Set(['--interactive', '--suite', '--status']);
  const options = new Set(['--coordinator', '--from', '--until', '--max-launches', '--grep', '--output', '--probe', '--hold-ms']);
  while (args.length) {
    const key = args.shift();
    if (key === '--') continue;
    if (flags.has(key)) values[key] = true;
    else if (options.has(key) && args[0] && !args[0].startsWith('--')) values[key] = args.shift();
    else if (/^tests\/[\w-]+\.spec\.ts$/.test(key)) files.push(key);
    else reject('app_test_arguments', '验收只接受明确的测试文件和受限参数');
  }
  if (values['--status']) {
    if (files.length || values['--interactive'] || values['--suite'] || (values['--probe'] && !/^[a-f\d-]{36}$/.test(values['--probe']))) {
      reject('app_test_arguments', '状态查询不能执行 App');
    }
    return { mode: 'status', id: values['--probe'] };
  }
  if (values['--probe']) {
    if (!/^[a-f\d-]{36}$/.test(values['--probe']) || values['--interactive'] || files.length || values['--suite']) {
      reject('app_test_arguments', '安全探针不能执行 App');
    }
    const until = Date.parse(values['--until']);
    const hold = Number(values['--hold-ms'] ?? 0);
    if (!Number.isFinite(until) || until <= Date.now() || until - Date.now() > 60_000 || !Number.isInteger(hold) || hold < 0 || hold > 30_000) {
      reject('app_test_window', '安全探针必须有一分钟内的截止时间及最多三十秒的等待');
    }
    return { mode: 'probe', id: values['--probe'], until, hold, desktop };
  }
  const from = Date.parse(values['--from']);
  const until = Date.parse(values['--until']);
  const budget = Number(values['--max-launches']);
  if (!values['--interactive'] || !/^[\w.-]{1,64}$/.test(values['--coordinator'] ?? '') || !Number.isFinite(from)
    || !Number.isFinite(until) || !Number.isInteger(budget) || budget < 1 || budget > 250 || (!files.length && !values['--suite'])) {
    reject('app_test_unapproved', '需要主 Agent 协调、用户认可的有限时段、明确范围和启动预算');
  }
  if (from > Date.now() || until <= Date.now() || until <= from || until - from > 60 * 60 * 1000) {
    reject('app_test_window', '当前不在有效预约时段内，最长一小时');
  }
  if (values['--suite'] && files.length) reject('app_test_arguments', '全量与文件范围不能同时指定');
  if (values['--output'] && !/^(artifacts|test-results)(\/[\w-]+)*$/.test(values['--output'])) {
    reject('app_test_arguments', '测试输出必须使用 artifacts 或 test-results 下的受控目录');
  }
  return { mode: 'interactive', coordinator: values['--coordinator'], from, until, budget, files,
    grep: values['--grep'], output: values['--output'], desktop };
}

let interactiveAttempted = false;

async function run(options) {
  for (const file of options.files ?? []) {
    if (!(await lstat(path.join(desktop, file)).catch(() => undefined))?.isFile()) reject('app_test_arguments', '指定测试文件不存在');
  }
  const lease = await acquireLease(options);
  let broker;
  let currentChild;
  const children = [];
  let exitCode = 0;
  let escalation = [];
  const stop = (code) => {
    if (exitCode) return;
    exitCode = code;
    broker?.stop();
    if (code === 124) process.stderr.write('app_test_expired: 预约时段到期，停止新启动并收尾本轮孩子。\n');
    // ChildProcess 对象来自本 runner 的 spawn，不查询或终止未知 PID/用户实例。
    const child = currentChild;
    const alive = () => child && child.exitCode === null && child.signalCode === null;
    if (alive()) child.kill('SIGINT');
    escalation = [setTimeout(() => { if (alive()) child.kill('SIGTERM'); }, 5000),
      setTimeout(() => { if (alive()) child.kill('SIGKILL'); }, 8000)];
  };
  const onInterrupt = () => stop(130);
  const onTerminate = () => stop(143);
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onTerminate);
  const deadline = setTimeout(() => stop(124), Math.max(1, options.until - Date.now()));
  const childEnvironment = () => ({ ...process.env, ...broker.environment,
    NOTALONE_APP_TEST_FILES: JSON.stringify(options.files ?? []) });
  const execute = (args, probe = false) => new Promise((resolve) => {
    if (exitCode || Date.now() >= options.until) { stop(124); resolve(124); return; }
    currentChild = spawn(process.execPath, args, { cwd: desktop, detached: true, env: childEnvironment(),
      stdio: probe ? ['ignore', 'pipe', 'pipe', 'ipc'] : 'inherit' });
    const child = currentChild;
    children.push(child);
    if (probe) { child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr); }
    child.once('error', () => resolve(exitCode || 2));
    child.once('close', (code) => { currentChild = undefined; resolve(exitCode || (code ?? 2)); });
  });
  try {
    broker = await serveLease(lease, options);
    if (options.mode === 'probe') exitCode ||= await execute([path.join(desktop, 'tests/scheduling/probe-child.mjs'), options.id, String(options.hold)], true);
    else {
      process.stdout.write('验证范围：预约时段内的真实 App 验收；会显示窗口并使用桌面焦点。\n');
      exitCode ||= await execute([path.join(desktop, 'scripts/build.mjs')]);
      if (!exitCode) {
        interactiveAttempted = true;
        const args = [path.join(desktop, 'node_modules/playwright/cli.js'), 'test', ...(options.files ?? []),
          '--workers=1', '--retries=0', '--repeat-each=1', '--max-failures=1'];
        if (options.grep) args.push('--grep', options.grep);
        if (options.output) args.push('--output', options.output);
        exitCode ||= await execute(args);
      }
    }
    return exitCode;
  } finally {
    clearTimeout(deadline);
    escalation.forEach(clearTimeout);
    broker?.stop();
    const limit = Date.now() + 2000;
    while (broker?.activeCount && Date.now() < limit) await delay(50);
    await broker?.close();
    if (!broker?.activeCount && children.every(ownedGroupGone)) await lease.release();
    else {
      process.stderr.write('app_test_cleanup_unconfirmed: 本轮孩子或启动收尾未获确认，保留租约；下一轮必须先由主 Agent 核验。\n');
      process.exitCode = 2;
    }
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onTerminate);
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = options.mode === 'status'
    ? (process.stdout.write(`${JSON.stringify(await leaseStatus(options.id))}\n验证范围：租约状态；App 未运行。\n`), 0)
    : await run(options);
  process.exitCode ||= result;
} catch (error) {
  const message = error.message.startsWith('app_test_') ? error.message : 'app_test_runner_failed: 调度入口未能安全完成';
  process.stderr.write(`${message}；${interactiveAttempted ? '真实 App 验收未完成' : 'App 未运行'}。\n`);
  process.exitCode = 2;
}
