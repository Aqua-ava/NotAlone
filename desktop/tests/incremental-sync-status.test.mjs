import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const bundled = await build({ stdin: { contents: `
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { ContactHistoryCoverage, HistoryCoverageStatus } from './src/renderer/HistoryCoverageStatus';
  export { parseSyncReport } from './src/main/sync/status';
  export function renderContact(coverage) {
    return renderToStaticMarkup(React.createElement(ContactHistoryCoverage, { coverages: [coverage], contactId: coverage.contactId }));
  }
  export function renderPage(coverages) {
    return renderToStaticMarkup(React.createElement(HistoryCoverageStatus, { coverages, contacts: [] }));
  }`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', write: false,
  loader: { '.css': 'empty' } });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const { parseSyncReport, renderContact, renderPage } = loaded.exports;

const id = '10000000-0000-4000-8000-000000000001';
const base = {
  sync_mode: 'cli_background', sync_enabled: true, cli_available: false, probe_available: false, wechat_in_front: false,
  cli_sync_phase: 'degraded', foreground_phase: 'unavailable', cli_bound_count: 1, cli_failure_code: 'wechat_body_unavailable',
  foreground_failure_code: null, cli_backfill_phase: 'not_required', cli_backfill_failure_code: null,
  cli_backfill_total_contacts: 0, cli_backfill_completed_contacts: 0, cli_backfill_succeeded_contacts: 0,
  cli_backfill_skipped_contacts: 0, cli_backfill_failed_contacts: 0, cli_backfill_incomplete_contacts: 0,
  cli_backfill_pending_contacts: 0, cli_backfill_total_message_count: 0, cli_backfill_total_non_text_count: 0,
  cli_history_authorization_state: 'accepted', cli_history_authorization_version: 1, cli_history_authorization_current_version: 1,
  cli_history_coverages: [{ binding_id: id, contact_id: id, phase: 'complete', failure_code: null, message_count: 2, non_text_count: 0, page_count: 1,
    incremental_phase: 'blocked', incremental_failure_code: 'history_tail_unsupported', incremental_last_accepted_at: 1700000000000, incremental_pages: 3 }],
  cli_incremental_phase: 'incomplete', cli_incremental_failure_code: 'history_tail_unsupported',
};
const coverage = changes => ({
  bindingId: id, contactId: id, phase: 'complete', failureCode: null, messageCount: 2, nonTextCount: 0, pageCount: 1,
  incrementalPhase: 'ready', incrementalFailureCode: null, incrementalLastAcceptedAt: 1700000000000, incrementalPages: 3, ...changes,
});

test('增量状态解析：缺失字段不推断已同步，非法枚举整份失败', () => {
  const parsed = parseSyncReport(base);
  assert.equal(parsed.historyCoverages[0].incrementalPhase, 'blocked');
  assert.equal(parsed.historyCoverages[0].incrementalFailureCode, 'history_tail_unsupported');
  assert.equal(parsed.historyCoverages[0].incrementalPages, 3);
  assert.equal(parsed.historyCoverages[0].incrementalLastAcceptedAt, 1700000000000);
  assert.equal(parsed.incrementalPhase, 'incomplete');
  assert.equal(parsed.incrementalFailureCode, 'history_tail_unsupported');
  const legacy = Object.fromEntries(Object.entries(base).filter(([key]) => !key.startsWith('cli_incremental_')));
  const withoutIncremental = parseSyncReport({ ...legacy,
    cli_history_coverages: [{ binding_id: id, contact_id: id, phase: 'complete', failure_code: null, message_count: 2, non_text_count: 0, page_count: 1 }] });
  assert.equal(withoutIncremental.historyCoverages[0].incrementalPhase, undefined, '未报告不得当成已同步');
  assert.equal(withoutIncremental.incrementalPhase, undefined);
  assert.throws(() => parseSyncReport({ ...base, cli_incremental_phase: 'synced' }));
  assert.throws(() => parseSyncReport({ ...base, cli_history_coverages: [{ ...base.cli_history_coverages[0], incremental_phase: 'done' }] }));
});

test('界面单独展示增量已停止/不可用原因，不把不可用显示成已同步', () => {
  const blocked = renderContact(coverage({ incrementalPhase: 'blocked', incrementalFailureCode: 'history_tail_unsupported' }));
  assert.ok(blocked.includes('新消息同步已停止'));
  assert.ok(blocked.includes('增量读取保持关闭'));
  const unavailable = renderContact(coverage({ incrementalPhase: 'unavailable', incrementalFailureCode: 'history_incremental_unavailable' }));
  assert.ok(unavailable.includes('新消息同步不可用'));
  assert.ok(unavailable.includes('尚未核验'));
  const noIncremental = renderContact(coverage({ incrementalPhase: undefined, incrementalFailureCode: undefined, incrementalPages: undefined }));
  assert.equal(noIncremental.includes('新消息同步'), false, '没有评估结果时不宣称增量状态');
  const page = renderPage([coverage({ incrementalPhase: 'blocked', incrementalFailureCode: 'history_cursor_invalid' })]);
  assert.ok(page.includes('新消息同步已停止或不完整'));
  assert.ok(page.includes('重新授权后可重试'));
});
