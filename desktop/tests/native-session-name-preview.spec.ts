import { test, expect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnApp, verifyAppTestLease } from './app-test-gate';

test.skip(process.env.NOTALONE_SESSION_NAME_PREVIEW !== '1', '仅在用户要求直接核对会话名称的有限时段执行');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('自动名称预览显示本轮识别结果并正常关闭，名称准确性由用户另行核对', async () => {
  const lease = await verifyAppTestLease();
  test.setTimeout(Math.max(1000, lease.until - Date.now() + 10000));
  const executable = path.resolve('../native/macos/build/cli/notalone-sync-probe');
  const child = await spawnApp(executable, ['--preview-session-name'], { stdio: ['ignore', 'pipe', 'ignore'] });
  await writeFile(test.info().outputPath('session-name-preview-owned.json'), JSON.stringify({ pid: child.pid, executable }),
    { mode: 0o600, flag: 'wx' });
  let report = '';
  let overflow = false;
  child.stdout?.on('data', chunk => {
    if (report.length + chunk.length > 8192) overflow = true;
    else report += chunk.toString();
  });
  process.stdout.write(`session_name_preview_started: pid=${child.pid}; 等待用户核对，20分钟内自动关闭。\n`);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject); child.once('close', resolve);
  });
  await child.waitForTestCleanup();
  expect(code).toBe(0);
  let summary: Record<string, unknown>;
  try {
    const events = report.trim().split('\n').map(line => JSON.parse(line));
    const ready = events[0];
    const closed = events[1];
    const fields = ['event', 'observations', 'recognized_samples', 'paused_samples', 'failed_samples',
      'saved_images', 'saved_names', 'runtime_frame_count_verified'];
    if (overflow || events.length !== 2 || ready?.event !== 'session_name_preview_ready'
      || ready.duration_seconds !== 1200 || Object.keys(ready).length !== 2
      || closed?.event !== 'session_name_preview_closed' || Object.keys(closed).length !== fields.length
      || !Object.keys(closed).every(key => fields.includes(key))
      || !fields.slice(1, -1).every(key => Number.isSafeInteger(closed[key]) && closed[key] >= 0)
      || closed.observations !== closed.recognized_samples + closed.paused_samples + closed.failed_samples
      || closed.saved_images !== 0 || closed.saved_names !== 0 || closed.runtime_frame_count_verified !== false) {
      throw new Error();
    }
    summary = closed;
  } catch { throw new Error('名称预览的匿名生命周期报告未通过，原始输出不回显。'); }
  process.stdout.write(`session_name_preview_summary: ${JSON.stringify(summary)}\n`);
});
