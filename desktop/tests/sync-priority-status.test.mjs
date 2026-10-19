import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/main/sync/status.ts'], bundle: true,
  platform: 'node', format: 'esm', write: false });
const { readSyncStatus } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);
const contactId = '00000000-0000-4000-8000-000000000021';
function report() {
  return { sync_mode: 'cli_background', sync_enabled: true, cli_available: true, probe_available: true,
    wechat_in_front: false, cli_sync_phase: 'active', foreground_phase: 'waiting_foreground',
    cli_bound_count: 116, cli_failure_code: null, foreground_failure_code: null,
    cli_backfill_phase: 'not_required', cli_backfill_failure_code: null,
    ...Object.fromEntries(['total_contacts', 'completed_contacts', 'succeeded_contacts', 'skipped_contacts',
      'failed_contacts', 'incomplete_contacts', 'pending_contacts', 'total_message_count', 'total_non_text_count']
      .map((key) => [`cli_backfill_${key}`, 0])),
    cli_priority_contact_id: contactId, cli_priority_last_success_at: '2026-10-19T06:00:00.123456+00:00',
    cli_priority_last_duration_ms: 145, cli_priority_last_cli_duration_ms: 90,
    cli_priority_last_store_duration_ms: 30, cli_priority_last_failure_code: null,
    cli_priority_queue_wait_ms: 24 };
}
const read = (data) => readSyncStatus({ requestJson: async () => ({ generation: 3, data }) }, new AbortController().signal);

test('公开同步状态保留当前优先联系人的成功时间与分阶段耗时', async () => {
  const result = await read(report());
  assert.equal(result.generation, 3);
  assert.deepEqual(result.report.priority, { contactId,
    lastSuccessAt: '2026-10-19T06:00:00.123456+00:00', lastDurationMs: 145,
    lastCliDurationMs: 90, lastStoreDurationMs: 30, lastFailureCode: null, queueWaitMs: 24 });
});
