import type { HistoryCoverage, HistoryCoveragePhase } from '../shared/sync-control-bridge';

const labels: Record<HistoryCoveragePhase, string> = {
  not_started: '尚未开始', syncing: '同步中', complete: '完整', incomplete: '不完整',
};
const reasons: Record<string, string> = {
  cli_timeout: '读取超时，正在自动重试。',
  cli_output_invalid: '读取结果无法解析，正在自动重试。',
  cli_freshness_unknown: '读取结果的新鲜度尚未确认，正在自动重试。',
  cli_normalization_failed: '消息格式无法识别，正在自动重试。',
  local_history_deleted: '本机微信记录已删除，无法确认更早历史。',
  local_history_empty: '本机微信没有可读记录，无法确认历史完整。',
  history_empty: '本次没有读到历史记录，无法确认历史完整。',
  cli_message_table_missing: '本机消息表不可读，正在自动重试。',
  history_page_stalled: '历史分页未能继续，正在自动重试。',
};

export function ContactHistoryCoverage({ coverages, contactId }: {
  coverages?: HistoryCoverage[]; contactId: string;
}) {
  const rows = coverages?.filter(item => item.contactId === contactId);
  return <div aria-label="当前联系人消息历史覆盖">
    {!rows?.length ? <p>消息历史覆盖尚未确认。</p> : rows.map(row => <div key={row.bindingId}>
      <p>消息历史覆盖：<strong>{labels[row.phase]}</strong></p>
      <p>已保存 {row.messageCount} 条文字，已读取 {row.pageCount} 页。</p>
      {row.phase === 'incomplete' && <p role="status">{reasons[row.failureCode ?? ''] ?? '读取失败或本机记录不可读，正在自动重试；当前历史不完整。'}</p>}
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
  return <>
    <section aria-label="消息历史覆盖"><h3>消息历史覆盖</h3>
      {coverages === undefined ? <p>历史覆盖状态尚未确认，请刷新后查看。</p>
        : <p>共 {coverages.length} 个会话：完整 {total('complete')}，同步中 {total('syncing')}，不完整 {total('incomplete')}，尚未开始 {total('not_started')}。</p>}
      <p>完整仅表示已读到本机可读历史的约定水位；连接或即时读取成功不代表历史完整。</p>
      {currentContactId && !ids.includes(currentContactId) && <p>当前联系人消息历史覆盖尚未确认。</p>}
      {ids.map(contactId => <div key={contactId}>
        <h4>{contactId === currentContactId ? '当前联系人：' : ''}{names.get(contactId) ?? `联系人 ${contactId}`}</h4>
        <ContactHistoryCoverage coverages={coverages} contactId={contactId} />
      </div>)}
    </section>
    <section aria-label="关系资料处理"><h3>关系资料处理</h3>
      <p>关系资料独立排队处理；消息历史完整不代表关系资料已处理完成。具体处理状态请到「关系资料」查看。</p>
    </section>
  </>;
}
