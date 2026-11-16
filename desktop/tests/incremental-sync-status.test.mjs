import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const bundled = await build({ stdin: { contents: `
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { ContactHistoryCoverage, HistoryCoverageStatus } from './src/renderer/HistoryCoverageStatus';
  export { parseSyncReport } from './src/main/sync/status';
  export { historyReplyEligibility } from './src/shared/history-reply-eligibility';
  export function renderContact(coverage, bodyAvailable, compact = false) {
    return renderToStaticMarkup(React.createElement(ContactHistoryCoverage, { coverages: [coverage], contactId: coverage.contactId, bodyAvailable, compact }));
  }
  export function renderPage(coverages, bodyAvailable, enabled = true) {
    return renderToStaticMarkup(React.createElement(HistoryCoverageStatus, { coverages, contacts: [], bodyAvailable, enabled }));
  }`, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, platform: 'node', format: 'cjs', write: false,
  loader: { '.css': 'empty' } });
const loaded = { exports: {} };
new Function('require', 'module', 'exports', bundled.outputFiles[0].text)(createRequire(import.meta.url), loaded, loaded.exports);
const { parseSyncReport, renderContact, renderPage, historyReplyEligibility } = loaded.exports;

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
  cli_incremental_identity_limit: 100000,
};
const coverage = changes => {
  const row = {
    bindingId: id, contactId: id, phase: 'complete', failureCode: null, messageCount: 2, nonTextCount: 0, pageCount: 1,
    incrementalPhase: 'ready', incrementalFailureCode: null, incrementalLastAcceptedAt: 1700000000000, incrementalPages: 3, ...changes,
  };
  // 新后台总会报告已保存标记；默认与当前读完状态一致，需要时由用例显式覆盖。
  return { savedHistoryComplete: row.phase === 'complete', ...row };
};

test('原件暂不可读显示临时失败，不要求重新核验聊天来源', () => {
  for (const changes of [
    { phase: 'incomplete', failureCode: 'history_source_temporarily_unavailable' },
    { incrementalPhase: 'unavailable', incrementalFailureCode: 'history_source_temporarily_unavailable' },
  ]) {
    const markup = renderContact(coverage(changes), true, true);
    assert.match(markup, /暂时读取失败/);
    assert.doesNotMatch(markup, /聊天来源需要核验|同步状态需要检查/);
    const detail = renderContact(coverage(changes), true);
    assert.match(detail, /开启同步时会自动重试/);
    assert.doesNotMatch(detail, /请检查同步状态与来源核验结果|请查看同步状态与来源核验结果/);
  }
});

test('增量状态解析：缺失字段不推断已同步，非法枚举整份失败', () => {
  const parsed = parseSyncReport(base);
  assert.equal(parsed.historyCoverages[0].incrementalPhase, 'blocked');
  assert.equal(parsed.historyCoverages[0].incrementalFailureCode, 'history_tail_unsupported');
  assert.equal(parsed.historyCoverages[0].incrementalPages, 3);
  assert.equal(parsed.historyCoverages[0].incrementalLastAcceptedAt, 1700000000000);
  assert.equal(parsed.incrementalPhase, 'incomplete');
  assert.equal(parsed.incrementalFailureCode, 'history_tail_unsupported');
  assert.equal(parsed.incrementalIdentityLimit, 100000);
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
  const overLimit = renderContact(coverage({ incrementalPhase: 'blocked', incrementalFailureCode: 'history_tail_baseline_too_large' }));
  assert.ok(overLimit.includes('超过当前增量上限'));
  assert.ok(overLimit.includes('已保存内容仍保留'));
  const page = renderPage([coverage({ incrementalPhase: 'blocked', incrementalFailureCode: 'history_cursor_invalid' })]);
  assert.ok(page.includes('需要关注'));
  assert.ok(page.includes('查看并处理'));
  assert.equal(page.includes('重新授权后可重试'), false, '总览不铺开技术原因或暗示一键恢复授权');
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
 assert.ok(markup.includes('当前没有需要关注的同步问题'));
 assert.equal(markup.includes('查看并处理'), false, '等待新消息不属于异常');
 assert.ok(!markup.includes('新消息同步不可用'));
 assert.throws(()=>parseSyncReport({...raw,cli_history_coverages:[{...raw.cli_history_coverages[0],incremental_waiting_for_messages:'yes'}]}));
});

test('正文未开放时如实显示能力核验进度，失败联系人不计入等待队列', () => {
  const markup = renderPage([
    coverage({ phase: 'syncing', incrementalPhase: 'syncing' }),
    coverage({ contactId: '20000000-0000-4000-8000-000000000002', phase: 'not_started', failureCode: 'history_support_unverified', incrementalPhase: 'unavailable', incrementalFailureCode: 'history_support_unverified' }),
    coverage({ contactId: '30000000-0000-4000-8000-000000000003', phase: 'not_started', incrementalPhase: 'not_started' }),
  ], false);
  assert.ok(markup.includes('等待或核验读取能力'));
  assert.ok(markup.includes('1 位联系人同步需要关注'));
  assert.equal(markup.includes('正在读取 1 个'), false);
  assert.equal(markup.includes('正在同步 1 个会话的新消息'), false);
  assert.equal(markup.includes('查看正在读取和等待同步的会话（2）'), false);
  assert.ok(markup.includes('查看并处理'));
  assert.equal(markup.includes('当前微信读取能力尚未核验'), false, '具体原因留在问题面板');
});


test('总览历史与增量异常按联系人并集计数，多绑定不增加总数', () => {
  const rows = Array.from({length: 200}, (_, i) => coverage({
    bindingId: 'binding-' + i, contactId: 'contact-' + i,
    phase: i < 189 ? 'incomplete' : 'complete',
    failureCode: i < 189 ? 'history_source_continuity_unverified' : null,
    incrementalPhase: i < 192 ? 'blocked' : 'ready',
    incrementalFailureCode: i < 189 ? 'history_incomplete' : i < 192 ? 'history_tail_unsupported' : null,
  }));
  rows.push({...rows[0], bindingId:'another-binding', failureCode:'cli_timeout'});
  const markup = renderPage(rows, true);
  assert.match(markup, /192 位联系人同步需要关注/);
  assert.match(markup, /value="11" max="200"/);
  assert.doesNotMatch(markup, /189|条文字消息|非文字占位|已跟进/);
});

test('关闭同步时历史与增量旧运行状态不冒充当前正在读取', () => {
  const markup = renderPage([coverage({phase:'syncing', incrementalPhase:'syncing'})], true, false);
  assert.match(markup, /自动同步已关闭/);
  assert.doesNotMatch(markup, /正在读取|正在同步|正在自动重试/);
});


test('联系人简短状态在缺少等待新消息标记时仍识别空历史，有元数据则不误判为空', () => {
  const empty = coverage({messageCount:0, nonTextCount:0, metadataOnlyCount:0, incrementalAwaitingMessages:undefined});
  const markup = renderContact(empty, true, true);
  assert.match(markup, /本机暂无可读记录/);
  assert.doesNotMatch(markup, /本机历史已读完/);
  const metadata = renderContact({...empty, metadataOnlyCount:1}, true, true);
  assert.match(metadata, /本机历史已读完/);
  assert.doesNotMatch(metadata, /本机暂无可读记录/);
});

test('saved_history_complete 解析：布尔值保留，缺失（旧后台）不推断，非法类型整份失败', () => {
  const parsed = parseSyncReport({ ...base, cli_history_coverages: [{ ...base.cli_history_coverages[0], saved_history_complete: true }] });
  assert.equal(parsed.historyCoverages[0].savedHistoryComplete, true);
  const legacy = parseSyncReport(base);
  assert.equal('savedHistoryComplete' in legacy.historyCoverages[0], false, '旧后台缺字段不得推断为已保存完成');
  for (const invalid of ['true', 1, null]) {
    assert.throws(() => parseSyncReport({ ...base, cli_history_coverages: [{ ...base.cli_history_coverages[0], saved_history_complete: invalid }] }));
  }
});

test('进度文案区分已保存的历史与当前连接：历史完成但来源待重验仍计入已保存并保留来源警示', () => {
  const rows = [
    coverage({ contactId: 'c1', bindingId: 'b1' }),
    coverage({ contactId: 'c2', bindingId: 'b2', phase: 'incomplete', failureCode: 'history_source_continuity_unverified', savedHistoryComplete: true,
      incrementalPhase: 'invalidated', incrementalFailureCode: 'history_source_continuity_unverified' }),
    coverage({ contactId: 'c3', bindingId: 'b3', phase: 'syncing', savedHistoryComplete: false, incrementalPhase: 'not_started' }),
    coverage({ contactId: 'c4', bindingId: 'b4', phase: 'not_started', savedHistoryComplete: false, incrementalPhase: 'not_started' }),
  ];
  const markup = renderPage(rows, true);
  assert.match(markup, /已保存本机历史：2 \/ 4 位联系人/);
  assert.match(markup, /value="2" max="4"/);
  assert.match(markup, /1 位联系人的聊天来源待重新核验，已保存的聊天不受影响/);
  assert.match(markup, /1 位联系人同步需要关注/, '真实来源失效的警示不因已保存标记而消失');
  assert.doesNotMatch(markup, /本机历史已读完：/);
});

test('旧后台缺少 saved_history_complete 时显示进度待确认，不画进度条也不推断完成', () => {
  const legacyRow = row => { const { savedHistoryComplete, ...rest } = row; return rest; };
  const markup = renderPage([legacyRow(coverage({})), legacyRow(coverage({ contactId: 'c2', bindingId: 'b2' }))], true);
  assert.match(markup, /已保存本机历史：进度待确认/);
  assert.doesNotMatch(markup, /<progress/);
  assert.doesNotMatch(markup, /\d+ \/ \d+ 位联系人/);
  assert.match(markup, /后台尚未报告已保存的历史进度/);
  assert.doesNotMatch(markup, /已保存当前同步进度/);
});

test('展示字段不改变回复资格：已保存完成但当前 phase 未完成时，资格仍按 phase 判断', () => {
  const stale = coverage({ phase: 'incomplete', failureCode: 'history_source_continuity_unverified', savedHistoryComplete: true });
  const report = { historyAuthorizationState: 'accepted', historyCoverages: [stale] };
  assert.equal(historyReplyEligibility(report, id), 'incomplete');
  assert.equal(historyReplyEligibility({ ...report, historyCoverages: [{ ...stale, savedHistoryComplete: false }] }, id), 'incomplete');
});
