import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const bundled = await build({ stdin: { contents: `
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { ContactHistoryCoverage, HistoryCoverageStatus } from './src/renderer/HistoryCoverageStatus';
  export { parseSyncReport } from './src/main/sync/status';
  export function renderContact(coverage, bodyAvailable) {
    return renderToStaticMarkup(React.createElement(ContactHistoryCoverage, { coverages: [coverage], contactId: coverage.contactId, bodyAvailable }));
  }
  export function renderPage(coverages, bodyAvailable) {
    return renderToStaticMarkup(React.createElement(HistoryCoverageStatus, { coverages, contacts: [], bodyAvailable }));
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

test('非文字类型明细校验计数并只展示中文标签，兼容旧宿主缺字段', () => {
  const rawCoverage = { ...base.cli_history_coverages[0], non_text_count: 4, non_text_types: [
    { message_type: 'image', label: '图片', count: 3 },
    { message_type: 'other', label: '后端标签不用于兜底显示', count: 1 },
  ] };
  const parsed = parseSyncReport({ ...base, cli_history_coverages: [rawCoverage] }).historyCoverages[0];
  assert.deepEqual(parsed.nonTextTypes, [
    { messageType: 'image', label: '图片', count: 3 },
    { messageType: 'other', label: '后端标签不用于兜底显示', count: 1 },
  ]);
  const markup = renderContact(parsed);
  assert.ok(markup.includes('图片：3 条'));
  assert.ok(markup.includes('其他消息（未识别）：1 条'));
  assert.ok(!markup.includes('image'));
  assert.ok(!markup.includes('other'));

  const legacy = parseSyncReport({ ...base, cli_history_coverages: [{ ...base.cli_history_coverages[0] }] });
  assert.equal(legacy.historyCoverages[0].nonTextTypes, undefined);
  assert.equal(renderContact(coverage({ nonTextTypes: undefined })).includes('非文字消息类型数量'), false);
});

test('非文字类型明细拒绝不完整、不唯一、超界或计数不一致的报告', () => {
  const row = { ...base.cli_history_coverages[0], non_text_count: 2, non_text_types: [
    { message_type: 'image', label: '图片', count: 2 },
  ] };
  const invalidRows = [
    { ...row, non_text_types: 'image' },
    { ...row, non_text_types: Array.from({ length: 33 }, (_, i) => ({ message_type: `type_${i}`, label: '类型', count: 1 })), non_text_count: 33 },
    { ...row, non_text_types: [{ message_type: 'type with spaces', label: '类型', count: 2 }] },
    { ...row, non_text_types: [{ message_type: 'text', label: '文字', count: 2 }] },
    { ...row, non_text_types: [{ message_type: 'image', label: '   ', count: 2 }] },
    { ...row, non_text_types: [{ message_type: 'image', label: '图'.repeat(65), count: 2 }] },
    { ...row, non_text_types: [{ message_type: 'image', label: '图片', count: 0 }] },
    { ...row, non_text_types: [{ message_type: 'image', label: '图片', count: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...row, non_text_types: [
      { message_type: 'image', label: '图片', count: 1 }, { message_type: 'image', label: '图片', count: 1 },
    ] },
    { ...row, non_text_count: 3 },
  ];
  for (const invalid of invalidRows) assert.throws(() => parseSyncReport({ ...base, cli_history_coverages: [invalid] }));
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

test('未建立覆盖的会话也显示首次历史支持核验阻断原因', () => {
  const waiting = renderContact(coverage({ phase: 'not_started', failureCode: 'history_support_unverified', incrementalPhase: 'unavailable', incrementalFailureCode: 'history_support_unverified' }), false);
  assert.ok(waiting.includes('读取能力核验受阻'));
  assert.ok(waiting.includes('正文读取保持关闭'));
});

test('已核验空历史与后续增量资格分开显示，不把空结果写成历史读取受阻',()=>{
 for(const incrementalPhase of ['unavailable','blocked']){
  const markup=renderContact(coverage({messageCount:0,nonTextCount:0,incrementalPhase,incrementalFailureCode:'history_incremental_unavailable'}),true);
  assert.ok(markup.includes('当前范围内暂无可读历史'));
  assert.equal(markup.includes('历史读取受阻'),false);
  assert.ok(markup.includes('出现新消息后需重新核验'));
 }
});

test('已认证空目标显示等待新消息且不计入需要关注',()=>{
 const raw={...base,cli_sync_phase:'active',cli_failure_code:null,cli_incremental_phase:'idle',cli_incremental_failure_code:null,
  cli_history_coverages:[{binding_id:id,contact_id:id,phase:'complete',failure_code:null,message_count:0,non_text_count:0,page_count:1,
   incremental_phase:'not_started',incremental_failure_code:null,incremental_waiting_for_messages:true}]};
 const parsed=parseSyncReport(raw);
 assert.equal(parsed.historyCoverages[0].incrementalAwaitingMessages,true);
 assert.equal(parsed.historyCoverages[0].incrementalFailureCode,null);
 const markup=renderPage(parsed.historyCoverages,false);
 assert.ok(markup.includes('等待新消息并定期检查'));
 assert.ok(markup.includes('需要关注：0 个'));
 assert.ok(!markup.includes('新消息同步不可用'));
 assert.throws(()=>parseSyncReport({...raw,cli_history_coverages:[{...raw.cli_history_coverages[0],incremental_waiting_for_messages:'yes'}]}));
});

test('正文未开放时如实显示能力核验进度，失败联系人不计入等待队列', () => {
  const markup = renderPage([
    coverage({ phase: 'syncing', incrementalPhase: 'syncing' }),
    coverage({ contactId: '20000000-0000-4000-8000-000000000002', phase: 'not_started', failureCode: 'history_support_unverified', incrementalPhase: 'unavailable', incrementalFailureCode: 'history_support_unverified' }),
    coverage({ contactId: '30000000-0000-4000-8000-000000000003', phase: 'not_started', incrementalPhase: 'not_started' }),
  ], false);
  assert.ok(markup.includes('正在核验读取能力：1 个会话'));
  assert.ok(markup.includes('等待核验：1 个 · 需要关注：1 个'));
  assert.equal(markup.includes('正在读取 1 个'), false);
  assert.equal(markup.includes('正在同步 1 个会话的新消息'), false);
  assert.equal(markup.includes('查看正在读取和等待同步的会话（2）'), false);
  assert.ok(markup.includes('当前微信读取能力尚未核验'));
});
