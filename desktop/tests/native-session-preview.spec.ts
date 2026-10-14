import { test, expect } from '@playwright/test';
import path from 'node:path';
import { spawnApp } from './app-test-gate';

test.skip(process.env.NOTALONE_SESSION_PREVIEW_ACCEPTANCE !== '1', '仅在用户要求本机OCR预览的有限时段执行');

test('本机内存预览由用户核对并关闭', async () => {
  test.setTimeout(510_000);
  const child = await spawnApp(path.resolve('../native/macos/build/cli/notalone-sync-probe'),
    ['--preview-session'], { stdio: 'ignore' });
  process.stdout.write(`session_preview_started: pid=${child.pid}; 原始画面与名称仅在本机窗口显示，8分钟自动关闭。\n`);
  const code = await new Promise<number | null>(resolve => child.once('close', resolve));
  expect(code).toBe(0);
});
