import { test, expect } from '@playwright/test';
import path from 'node:path';
import { spawnApp } from './app-test-gate';

test.skip(process.env.NOTALONE_FOREGROUND_STATUS_PREVIEW !== '1', '仅按用户要求打开有限前台状态验收窗口');

test('前台状态窗口由用户核对，关闭或八分钟到期后退出', async () => {
  test.setTimeout(510_000);
  const child = await spawnApp(path.resolve('../native/macos/build/cli/notalone-sync-probe'),
    ['--preview-foreground'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let report = '';
  child.stdout?.on('data', chunk => { report += chunk.toString(); });
  // 原生入口只输出固定事件与计数；不读取窗口标题、名称或原始异常。
  process.stdout.write(`foreground_preview_started: pid=${child.pid}; 每0.5秒刷新，8分钟自动退出。\n`);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  process.stdout.write(report);
  expect(code).toBe(0);
  const events = report.trim().split('\n').map(line => JSON.parse(line));
  expect(events[0].event).toBe('foreground_preview_ready');
  const summary = events.at(-1);
  expect(summary.event).toBe('foreground_preview_closed');
  expect(summary.machine_samples).toBeGreaterThan(0);
  expect(summary.captures).toBe(0);
  expect(summary.ocr_calls).toBe(0);
  // 此用例只验证入口生命周期，人工一致/不一致按实际计数另报，零次不算通过。
});
