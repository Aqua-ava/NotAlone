import { test, expect } from '@playwright/test';
import path from 'node:path';
import { spawnApp } from './app-test-gate';

test.skip(process.env.NOTALONE_FOREGROUND_RUNTIME_DIAGNOSTIC !== '1', '只在限定时段执行无窗口元数据诊断');

test('短生命周期探针能取得系统前台元数据', async () => {
  const child = await spawnApp(path.resolve('../native/macos/build/cli/notalone-sync-probe'),
    ['--foreground-status', '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
  process.stdout.write(`foreground_runtime_owned_pid:${child.pid}\n`);
  let output = '';
  child.stdout?.on('data', chunk => { if (output.length < 4096) output += chunk.toString(); });
  child.stderr?.resume();
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
  } finally { clearTimeout(timer); await child.waitForTestCleanup(); }
  expect(code).toBe(0);
  const result = JSON.parse(output);
  const report = { systemFrontApp: result.system_front_app, probePreflight: result.probe_preflight,
    mainThread: result.main_thread === true, applicationInitialized: result.application_initialized === true };
  process.stdout.write(`foreground_runtime:${JSON.stringify(report)}\n`);
  expect(result.ok).toBe(true);
  expect(['wechat', 'preview', 'other']).toContain(report.systemFrontApp);
});
