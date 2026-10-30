import type { HistoryCoverage, HistoryCoveragePhase, HistoryIncrementalPhase } from '../shared/sync-control-bridge';
import { syncScopeNotice } from './sync-scope-notice';

const labels: Record<HistoryCoveragePhase, string> = {
  not_started: '等待同步', syncing: '正在读取历史', complete: '本机历史已读完', incomplete: '历史尚未读完',
};
const incrementalLabels: Record<HistoryIncrementalPhase, string> = {
  not_started: '新消息同步尚未开始', ready: '新消息同步待继续', syncing: '正在同步新消息',
  incomplete: '新消息同步暂时受阻', blocked: '新消息同步已停止', invalidated: '新消息同步检查点已失效',
  unavailable: '新消息同步不可用', stopped: '新消息同步已停止',
};
const incrementalReasons: Record<string, string> = {
  history_incremental_unavailable: '当前微信读取能力尚未核验，增量读取保持关闭。',
  history_tail_unsupported: '当前微信读取能力未提供增量续读，增量读取保持关闭。',
  history_support_unverified: '当前微信读取能力尚未核验，增量读取保持关闭。',
  history_source_continuity_unverified: '聊天来源已无法确认连续，增量读取保持关闭。',
  history_support_unsupported: '当前微信结构明确不支持增量读取。',
  history_support_changed: '微信读取支持档已变化，增量读取已停止，需要重新核验。',
  history_external_scope_changed: '微信账号或会话来源已变化，增量读取已停止，需要重新核验。',
  history_cursor_invalid: '本机微信不再认可上次读取位置，增量读取已停止；重新授权后可重试。',
  history_cursor_scope_changed: '读取范围证据与上次不一致，增量读取已停止。',
  history_suppression_unverified: '存在尚未认证的历史截断边界，读取保持关闭。',
  history_suppression_changed: '历史截断状态已变化，增量读取已停止。',
  history_page_invalid: '读取返回了不一致的分页，增量读取已停止。',
  history_deletion_in_progress: '相关消息正在删除，本次增量读取未提交。',
  history_identity_quarantined: '部分新消息身份存在冲突，已隔离待核验。',
  history_native_unavailable: '暂时无法读取微信，稍后会自动重试。',
  history_native_timeout: '读取微信暂时超时，稍后会自动重试。',
  history_interrupted: '本次新消息读取已中断，稍后会自动重试。',
  history_incomplete: '历史尚未读完，新消息同步会先补齐历史。',
};
const reasons: Record<string, string> = {
  cli_timeout: '读取暂时超时，开启同步时会自动重试。',
  cli_output_invalid: '暂时无法读取微信记录，开启同步时会自动重试。',
  cli_freshness_unknown: '暂时无法确认是否读到了最新记录，开启同步时会自动重试。',
  cli_normalization_failed: '部分消息暂时无法读取，开启同步时会自动重试。',
  local_history_deleted: '这台电脑上的微信记录已删除，无法读取更早的聊天。',
  local_history_empty: '这台电脑上的微信暂时没有可读取的聊天记录。',
  history_empty: '暂时没有读到聊天记录，还不能确认历史是否读完。',
  cli_message_table_missing: '暂时无法打开本机微信记录，开启同步时会自动重试。',
  history_page_stalled: '读取更早的聊天时暂时中断，开启同步时会自动重试。',
  history_identity_quarantined: '部分消息身份或内容存在冲突，已隔离待核验，不作为聊天或回复依据。',
  history_support_unsupported: '当前微信结构明确不支持，正文读取保持关闭。',
  history_support_unverified: '当前微信读取能力尚未核验，正文读取保持关闭。',
  history_source_continuity_unverified: '聊天来源已无法确认连续，正文读取保持关闭。',
  history_identity_conflict: '部分消息身份存在冲突，已隔离待核验，不作为聊天或回复依据。',
  history_identity_insufficient: '部分消息无法可靠识别，已隔离待核验，不作为聊天或回复依据。',
  history_partitions_missing: '本机历史分片未完整读到，不能确认历史已读完。',
  history_interrupted: '本次历史读取已中断，已保存部分不代表完整历史。',
};

export function ContactHistoryCoverage({ coverages, contactId }: {
  coverages?: HistoryCoverage[]; contactId: string;
}) {
  const rows = coverages?.filter(item => item.contactId === contactId);
  return <div aria-label="当前联系人消息历史覆盖">
    {!rows?.length ? <p>暂时还不知道历史聊天是否读完。</p> : rows.map(row => <div key={row.bindingId}>
      <p><strong>{labels[row.phase]}</strong> · 已保存 {row.messageCount} 条文字消息、{row.nonTextCount} 条非文字占位</p>
      {row.phase === 'incomplete' && <p role="status">{syncScopeNotice(row.failureCode) ?? reasons[row.failureCode ?? ''] ?? '部分聊天暂时无法读取，开启同步时会自动重试。'}</p>}
      {row.incrementalPhase !== undefined && row.incrementalPhase !== 'not_started' && <p role="status">
        <strong>{incrementalLabels[row.incrementalPhase]}</strong>{typeof row.incrementalPages === 'number' ? ` · 已跟进 ${row.incrementalPages} 次` : ''}
      </p>}
      {row.incrementalFailureCode && <p role="status">
        {incrementalReasons[row.incrementalFailureCode] ?? reasons[row.incrementalFailureCode] ?? '新消息同步暂未继续，请稍后刷新状态或重新开启同步。'}
      </p>}
    </div>)}
  </div>;
}

export function HistoryCoverageStatus({ coverages, contacts = [], currentContactId }: {
  coverages?: HistoryCoverage[];
  contacts?: { contactId: string; displayName: string }[];
  currentContactId?: string | null;
}) {
  const names = new Map(contacts.map(contact => [contact.contactId, contact.displayName]));
  const total = (phase: HistoryCoveragePhase) => coverages?.filter(row => row.phase === phase).length ?? 0;
  const ids = [...new Set(coverages?.map(row => row.contactId))];
  const renderContacts = (rows: HistoryCoverage[]) => [...new Set(rows.map(row => row.contactId))].map(contactId => <div key={contactId}>
    <h4>{contactId === currentContactId ? '当前联系人：' : ''}{names.get(contactId) ?? '未命名联系人'}</h4>
    <ContactHistoryCoverage coverages={rows} contactId={contactId} />
  </div>);
  const incomplete = coverages?.filter(row => row.phase === 'incomplete') ?? [];
  const pending = coverages?.filter(row => row.phase === 'syncing' || row.phase === 'not_started') ?? [];
  const complete = coverages?.filter(row => row.phase === 'complete') ?? [];
  const incrementalAttention = coverages?.filter(row => ['blocked', 'incomplete', 'invalidated', 'unavailable'].includes(row.incrementalPhase ?? '')) ?? [];
  const incrementalBusy = coverages?.filter(row => row.incrementalPhase === 'syncing') ?? [];
  return <>
    <section aria-label="聊天同步进度"><h3>聊天同步进度</h3>
      {coverages === undefined ? <p>暂时无法获取同步进度，请刷新后查看。</p>
        : coverages.length === 0 ? <p>暂无会话的历史同步进度。</p> : <>
          <p>已读完 {complete.length} / {coverages.length} 个会话的本机历史</p>
          <progress aria-label="本机历史读取进度" value={complete.length} max={coverages.length} />
          <p>正在读取 {total('syncing')} 个 · 等待同步 {total('not_started')} 个 · 需要关注 {incomplete.length} 个</p>
          {incrementalBusy.length > 0 && <p role="status">正在同步 {incrementalBusy.length} 个会话的新消息…</p>}
          {incrementalAttention.length > 0 && <div role="status">
            <p>{incrementalAttention.length} 个会话的新消息同步已停止或不完整。</p>
            {incrementalAttention[0]?.incrementalFailureCode && <p>{incrementalReasons[incrementalAttention[0].incrementalFailureCode] ?? '请刷新状态查看原因。'}</p>}
          </div>}
        </>}
      <p>只读取这台电脑上微信能提供的文字与非文字占位；不下载媒体，已删除或仅在其他设备上的记录不包含在内。</p>
      {currentContactId && !ids.includes(currentContactId) && <p>当前联系人的同步进度暂时未知。</p>}
      {incomplete.length > 0 && <div><h4>需要关注的会话（{incomplete.length}）</h4>{renderContacts(incomplete)}</div>}
      {pending.length > 0 && <details className="sync-backfill-details">
        <summary>查看正在读取和等待同步的会话（{pending.length}）</summary>{renderContacts(pending)}
      </details>}
      {complete.length > 0 && <details className="sync-backfill-details">
        <summary>查看已读完的会话（{complete.length}）</summary>{renderContacts(complete)}
      </details>}
    </section>
    <section aria-label="关系资料处理"><h3>关系资料处理</h3>
      <p>聊天读完后，还需要整理关系资料。整理进度可到「关系资料」查看。</p>
    </section>
  </>;
}
