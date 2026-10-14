import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnApp } from './app-test-gate';

test.skip(process.env.NOTALONE_AUTOMATIC_FOREGROUND_ACCEPTANCE !== '1', '仅在明确授权的有限实机时段执行');

// 操作者通过 Computer Use 改变窗口，触发文件只协调时机，不提供任何定位坐标。
test('真实窗口原位移动缩放均自动识别', async () => {
  test.setTimeout(1_100_000);
  const expected = process.env.NOTALONE_TEST_SESSION_NAME;
  if (!expected) throw new Error('缺少本轮已确认测试会话');
  const directory = process.env.NOTALONE_AUTOMATIC_CONTROL_DIRECTORY;
  if (!directory || !path.isAbsolute(directory)) throw new Error('缺少本轮隔离协调目录');
  const reports: Record<string, unknown>[] = [];
  const requested = process.env.NOTALONE_AUTOMATIC_PHASE;
  if (requested && !['baseline', 'moved', 'resized'].includes(requested)) throw new Error('未知验收阶段');
  for (const phase of requested ? [requested] : ['baseline', 'moved', 'resized']) {
    process.stdout.write(`automatic_ready:${phase}\n`);
    await expect.poll(async () => readFile(path.join(directory, `${phase}.trigger`), 'utf8').then(v => v === 'ready').catch(() => false),
      { timeout: 300_000 }).toBe(true);
    const started = performance.now();
    const child = await spawnApp(path.resolve('../native/macos/build/cli/notalone-sync-probe'),
      ['--session', '--json', '--minimal-region'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout!.on('data', value => { if (output.length < 65_536) output += value.toString(); });
    // 不回显原生标准错误或名称，超时仅终止本次拥有的子进程。
    child.stderr!.resume();
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const exit = await new Promise<number | null>(resolve => child.once('close', resolve));
    clearTimeout(timer);
    let value: Record<string, any> = {};
    try { value = JSON.parse(output); } catch { /* 固定失败投影。 */ }
    const report = { phase, exit, elapsedMs: Math.round(performance.now() - started), ok: value.ok === true,
      front: value.wechat_in_front === true, versionValid: value.capture_version === 'automatic-window-v1',
      namesMatch: value.display_name === expected && value.selected_row_name === expected,
      stage: typeof value.stage === 'string' && /^[a-z_]{1,80}$/.test(value.stage) ? value.stage : null,
      error: typeof value.error === 'string' && /^[a-z_]{1,80}$/.test(value.error) ? value.error : null };
    reports.push(report);
    await writeFile(path.join(directory, `${phase}.result.json`), JSON.stringify(report), { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  for (const report of reports) {
    expect(report.ok).toBe(true); expect(report.front).toBe(true);
    expect(report.namesMatch).toBe(true); expect(report.versionValid).toBe(true);
    expect(report.elapsedMs as number, '正式 fresh 入口最多1秒').toBeLessThanOrEqual(1000);
  }
});
