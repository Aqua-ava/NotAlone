import { expect, test } from '@playwright/test';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { spawnApp, verifyAppTestLease } from './app-test-gate';

const preview = process.env.NOTALONE_SESSION_EVENT_PREVIEW === '1';
test.skip(process.env.NOTALONE_SESSION_EVENT_DIAGNOSTIC !== '1' && !preview,
  '仅主 Agent 在明确有限场次检查界面通知能力或打开可视验收窗口');
test.use({ trace: 'off', screenshot: 'off', video: 'off' });

test('统计微信界面通知能力，结果不代表联系人切换覆盖率已通过', async () => {
  const lease = await verifyAppTestLease();
  const seconds = Math.min(90, Math.floor((lease.until - Date.now() - 15000) / 1000));
  expect(seconds).toBeGreaterThanOrEqual(5);
  test.setTimeout(seconds * 1000 + 15000);
  const executable = path.resolve('../native/macos/build/diagnostics/session-event-capabilities');
  const child = await spawnApp(executable, [...(preview ? ['--preview'] : []), '--seconds', String(seconds)],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  await writeFile(test.info().outputPath('session-events-owned.json'), JSON.stringify({ pid: child.pid, executable }),
    { mode: 0o600, flag: 'wx' });
  let pending = '';
  const events: Record<string, unknown>[] = [];
  let invalid = false;
  let observed = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    if (invalid) return;
    pending += chunk.toString('utf8');
    if (pending.length > 8192) { invalid = true; return; }
    for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      try {
        const value = JSON.parse(line);
        const categories = ['focus', 'window', 'selection', 'rows', 'title', 'moved', 'resized'];
        const counts = (object: unknown) => object !== null && typeof object === 'object' && !Array.isArray(object)
          && Object.entries(object).every(([key, count]) => categories.includes(key) && Number.isSafeInteger(count) && (count as number) >= 0);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        if (value.event === 'session_event_capability') {
          if (Object.keys(value).length !== 4 || !categories.includes(value.category)
            || !Number.isSafeInteger(value.count) || value.count < 1
            || !Number.isSafeInteger(value.elapsed_ms) || value.elapsed_ms < 0) throw new Error();
          observed += 1;
          if (observed > 10000) throw new Error();
        } else if (value.event === 'session_event_capabilities_ready') {
          if (events.length || Object.keys(value).length !== 8 || typeof value.accessibility_trusted !== 'boolean'
            || typeof value.unique_wechat !== 'boolean' || !counts(value.registered)
            || !Number.isSafeInteger(value.rejected) || value.rejected < 0
            || value.duration_seconds !== seconds || value.images !== 0 || value.text_reads !== 0) throw new Error();
          events.push(value);
          process.stdout.write(`session_events_ready:${JSON.stringify(value)}\n`);
        } else if (value.event === 'session_event_capabilities_closed') {
          if (events.length !== 1 || Object.keys(value).length !== 5 || !counts(value.counts)
            || !Number.isSafeInteger(value.foreground_transitions) || value.foreground_transitions < 0
            || value.images !== 0 || value.text_reads !== 0) throw new Error();
          events.push(value);
        } else if (preview && value.event === 'session_events_preview_closed') {
          if (events.length !== 2 || Object.keys(value).length !== 9
            || value.received_events !== observed || value.foreground_transitions !== events[1].foreground_transitions
            || !Number.isSafeInteger(value.human_with_prompt) || value.human_with_prompt < 0
            || !Number.isSafeInteger(value.human_without_prompt) || value.human_without_prompt < 0
            || value.contact_switch_coverage_verified !== false || value.captures !== 0
            || value.ocr_calls !== 0 || value.text_reads !== 0) throw new Error();
          events.push(value);
        } else throw new Error();
      } catch { invalid = true; }
    }
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), seconds * 1000 + 5000);
  let code: number | null;
  try {
    code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject); child.once('close', resolve);
    });
  } finally { clearTimeout(timer); await child.waitForTestCleanup(); }
  expect(code).toBe(0);
  expect(invalid).toBe(false);
  expect(pending).toBe('');
  expect(events).toHaveLength(preview ? 3 : 2);
  await writeFile(test.info().outputPath('session-events-summary.json'), JSON.stringify({
    events, preview, receivedEvents: observed, contactSwitchCoverageVerified: false,
  }), { mode: 0o600 });
  process.stdout.write(`session_events_summary:${JSON.stringify(events[1])}\n`);
});
