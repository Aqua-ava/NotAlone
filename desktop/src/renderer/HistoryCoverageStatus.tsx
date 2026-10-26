import type { HistoryCoverage, HistoryCoveragePhase } from '../shared/sync-control-bridge';
import { syncScopeNotice } from './sync-scope-notice';

const labels: Record<HistoryCoveragePhase, string> = {
  not_started: '等待同步', syncing: '正在读取历史', complete: '本机历史已读完', incomplete: '历史尚未读完',
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
};

export function ContactHistoryCoverage({ coverages, contactId }: {
  coverages?: HistoryCoverage[]; contactId: string;
}) {
  const rows = coverages?.filter(item => item.contactId === contactId);
  return <div aria-label="当前联系人消息历史覆盖">
    {!rows?.length ? <p>暂时还不知道历史聊天是否读完。</p> : rows.map(row => <div key={row.bindingId}>
      <p><strong>{labels[row.phase]}</strong> · 已保存 {row.messageCount} 条文字消息</p>
      {row.phase === 'incomplete' && <p role="status">{syncScopeNotice(row.failureCode) ?? reasons[row.failureCode ?? ''] ?? '部分聊天暂时无法读取，开启同步时会自动重试。'}</p>}
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
  return <>
    <section aria-label="聊天同步进度"><h3>聊天同步进度</h3>
      {coverages === undefined ? <p>暂时无法获取同步进度，请刷新后查看。</p>
        : coverages.length === 0 ? <p>暂无会话的历史同步进度。</p> : <>
          <p>已读完 {complete.length} / {coverages.length} 个会话的本机历史</p>
          <progress aria-label="本机历史读取进度" value={complete.length} max={coverages.length} />
          <p>正在读取 {total('syncing')} 个 · 等待同步 {total('not_started')} 个 · 需要关注 {incomplete.length} 个</p>
        </>}
      <p>只读取这台电脑上微信能提供的文字记录；已删除或仅在其他设备上的记录不包含在内。</p>
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
