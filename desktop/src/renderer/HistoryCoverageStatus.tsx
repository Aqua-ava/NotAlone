import type { HistoryCoverage, HistoryCoveragePhase, HistoryIncrementalPhase } from '../shared/sync-control-bridge';
import { useEffect, useMemo, useState } from 'react';
import { syncScopeNotice } from './sync-scope-notice';
import { buildSyncContacts, syncContactLabel, syncIssueGroups, type SyncContactStatus, type SyncIssueKind } from './sync-history-model';
import './sync-history.css';

const labels: Record<HistoryCoveragePhase, string> = {
  not_started: '等待同步', syncing: '正在读取历史', complete: '本机历史已读完', incomplete: '历史尚未读完',
};
const unknownNonTextTypeLabel = '其他消息（未识别）';
const incrementalBaselineLimitMessage = '此会话的消息身份基线超过当前增量上限，暂时不能继续增量读取；已保存内容仍保留。';
const incrementalLabels: Record<HistoryIncrementalPhase, string> = {
  not_started: '新消息同步尚未开始', ready: '新消息同步待继续', syncing: '正在同步新消息',
  incomplete: '新消息同步暂时受阻', blocked: '新消息同步已停止', invalidated: '新消息同步检查点已失效',
  unavailable: '新消息同步不可用', stopped: '新消息同步已停止',
};
const incrementalReasons: Record<string, string> = {
  history_incremental_unavailable: '当前微信读取能力尚未核验，增量读取保持关闭。',
  history_tail_unsupported: '当前微信读取能力未提供增量续读，增量读取保持关闭。',
  history_support_unverified: '当前微信读取能力尚未核验，增量读取保持关闭。',
  history_message_state_unverified: '微信仍有消息状态未核验，增量读取保持关闭。',
  history_source_lifecycle_unverified: '微信聊天来源的变化规则尚未核验，增量读取保持关闭。',
  history_snapshot_runtime_proof_required: '微信历史快照尚未通过实机核验，增量读取保持关闭。',
  history_partition_coverage_runtime_proof_required: '微信历史分片覆盖尚未通过实机核验，增量读取保持关闭。',
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
  history_tail_baseline_too_large: incrementalBaselineLimitMessage,
  history_identity_quarantined: '部分新消息的身份、状态或内容尚未核验，已隔离；其他已核验消息继续同步。',
  history_native_unavailable: '暂时无法读取微信，开启同步时会自动重试。',
  history_native_timeout: '读取微信暂时超时，开启同步时会自动重试。',
  history_interrupted: '本次新消息读取已中断，开启同步时会自动重试。',
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
  history_tail_baseline_too_large: incrementalBaselineLimitMessage,
  history_identity_quarantined: '部分消息的身份、状态或内容尚未核验，已隔离，不作为聊天或回复依据。已核验消息可正常读取。',
  history_support_unsupported: '当前微信结构明确不支持，正文读取保持关闭。',
  history_support_unverified: '当前微信读取能力尚未核验，正文读取保持关闭。',
  history_message_state_unverified: '微信仍有消息状态未核验，正文读取保持关闭。',
  history_source_lifecycle_unverified: '微信聊天来源的变化规则尚未核验，正文读取保持关闭。',
  history_snapshot_runtime_proof_required: '微信历史快照尚未通过实机核验，正文读取保持关闭。',
  history_partition_coverage_runtime_proof_required: '微信历史分片覆盖尚未通过实机核验，正文读取保持关闭。',
  history_source_continuity_unverified: '聊天来源已无法确认连续，正文读取保持关闭。',
  history_identity_conflict: '部分消息身份存在冲突，已隔离待核验，不作为聊天或回复依据。',
  history_identity_insufficient: '部分消息无法可靠识别，已隔离待核验，不作为聊天或回复依据。',
  history_partitions_missing: '本机历史分片未完整读到，不能确认历史已读完。',
  history_interrupted: '本次历史读取已中断，已保存部分不代表完整历史。',
};

export function ContactHistoryCoverage({ coverages, contactId, bodyAvailable, compact = false, enabled }: {
  coverages?: HistoryCoverage[]; contactId: string; bodyAvailable?: boolean; compact?: boolean; enabled?: boolean;
}) {
  const rows = coverages?.filter(item => item.contactId === contactId);
  const emptyHistory = (row: HistoryCoverage) => row.phase === 'complete' && row.messageCount === 0 && row.nonTextCount === 0 && (row.metadataOnlyCount ?? 0) === 0;
  const historyLabel = (row: HistoryCoverage) => row.phase === 'complete' ? emptyHistory(row) ? '当前范围内暂无可读历史' : labels.complete
    : bodyAvailable !== false && row.failureCode === 'history_identity_quarantined'
    ? '部分历史尚未核验' : row.failureCode || row.incrementalFailureCode
    ? bodyAvailable === false ? '读取能力核验受阻' : '历史读取受阻'
    : bodyAvailable === false && row.phase === 'syncing' ? '正在核验读取能力' : labels[row.phase];
  const incrementalLabel = (phase: HistoryIncrementalPhase) => bodyAvailable === false ? ({
    not_started: '尚未核验读取能力', ready: '等待读取能力核验', syncing: '正在核验读取能力', incomplete: '读取能力核验未完成',
    blocked: '读取能力核验受阻', invalidated: '读取能力核验已失效', unavailable: '正文同步能力不可用', stopped: '读取能力核验已停止',
  } satisfies Record<HistoryIncrementalPhase, string>)[phase] : incrementalLabels[phase];
  if (compact) return <small className="contact-history-status">
    {!rows?.length ? '历史覆盖待确认' : syncContactLabel(buildSyncContacts(rows)[0], bodyAvailable, enabled)}
  </small>;
  return <div role="region" aria-label="当前联系人消息历史覆盖">
    {!rows?.length ? <p>暂时还不知道历史聊天是否读完。</p> : rows.map(row => <div key={row.bindingId}>
      <p><strong>{enabled === false ? '自动同步已关闭' : historyLabel(row)}</strong> · 已保存 {row.messageCount} 条文字消息、{row.nonTextCount} 条非文字占位</p>
      {!!row.nonTextTypes?.length && <ul aria-label="非文字消息类型数量">
        {row.nonTextTypes.map(item => <li key={item.messageType}>{item.messageType === 'other' ? unknownNonTextTypeLabel : item.label}：{item.count} 条</li>)}
      </ul>}
      {row.nonTextCount > 0 && <p>非文字占位只表示消息存在，不包含语音、视频、文件或表情正文，不作为聊天或回复依据。图片即使已保存，也可能因本机文件缺失、缺密钥或来源未核验而无法查看。</p>}
      {(row.metadataOnlyCount ?? 0) > 0 && <p>另保存 {row.metadataOnlyCount} 条系统等元数据记录，不含正文。</p>}
      {row.phase !== 'complete' && row.failureCode && <p role="status">{syncScopeNotice(row.failureCode) ?? reasons[row.failureCode] ?? '部分聊天暂时无法读取，请检查同步状态与来源核验结果。'}</p>}
      {row.incrementalAwaitingMessages === true && <p role="status">这台电脑上当前没有可读聊天记录，开启同步时会等待新消息并定期检查。</p>}
      {row.incrementalPhase !== undefined && (row.incrementalPhase !== 'not_started' || row.incrementalFailureCode) && <p role="status">
        <strong>{enabled === false ? '新消息同步已暂停' : incrementalLabel(row.incrementalPhase)}</strong>{bodyAvailable !== false && typeof row.incrementalPages === 'number' ? ` · 已跟进 ${row.incrementalPages} 次` : ''}
      </p>}
      {row.incrementalFailureCode && <p role="status">
        {emptyHistory(row) && ['history_incremental_unavailable', 'history_tail_unsupported'].includes(row.incrementalFailureCode)
          ? '当前范围已核验无可读历史；出现新消息后需重新核验读取范围。'
          : syncScopeNotice(row.incrementalFailureCode) ?? incrementalReasons[row.incrementalFailureCode] ?? reasons[row.incrementalFailureCode] ?? '新消息同步暂未继续，请查看同步状态与来源核验结果。'}
      </p>}
    </div>)}
  </div>;
}

interface CoverageProps {
  coverages?: HistoryCoverage[];
  contacts?: { contactId: string; displayName: string }[];
  bodyAvailable?: boolean;
  enabled?: boolean;
  incrementalIdentityLimit?: number;
}
const pageSize = 10;

function ContactStatusList({ contacts, bodyAvailable, enabled, onOpenContact, diagnostic = false }: {
  contacts: SyncContactStatus[]; bodyAvailable?: boolean; enabled?: boolean;
  onOpenContact?: (contactId: string) => void; diagnostic?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = contacts.filter(contact => contact.displayName.toLocaleLowerCase().includes(normalizedQuery));
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  return <>
    <label className="sync-history-search">搜索联系人
      <input type="search" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} placeholder="输入联系人名称" />
    </label>
    <p className="sync-history-count">共 {filtered.length} 位联系人，每页最多 {pageSize} 位</p>
    {visible.length ? <ul className="sync-history-contact-list" aria-label={diagnostic ? '同步诊断联系人' : '需关注的联系人'}>
      {visible.map(contact => <li key={contact.contactId}>
        <div><strong title={contact.displayName}>{contact.displayName}</strong><small>{syncContactLabel(contact, bodyAvailable, enabled)}</small></div>
        {onOpenContact && <button className="button" onClick={() => onOpenContact(contact.contactId)}>{diagnostic ? '查看明细' : '查看联系人'}</button>}
      </li>)}
    </ul> : <p role="status">没有符合条件的联系人。</p>}
    <nav className="sync-history-pagination" aria-label="同步联系人分页">
      <button className="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
      <span>第 {currentPage + 1} / {pageCount} 页</span>
      <button className="button" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>下一页</button>
    </nav>
  </>;
}

function SyncIssuePanel({ contacts, bodyAvailable, enabled, onClose, onOpenContact, onOpenDiagnostics }: {
  contacts: SyncContactStatus[]; bodyAvailable?: boolean; enabled?: boolean; onClose: () => void;
  onOpenContact?: (contactId: string) => void; onOpenDiagnostics?: () => void;
}) {
  const [selectedKind, setSelectedKind] = useState<SyncIssueKind | null>(null);
  const issues = contacts.filter(contact => contact.issue !== null);
  const group = syncIssueGroups.find(item => item.kind === selectedKind);
  const selected = issues.filter(contact => contact.issue === selectedKind);
  return <section className="sync-history-panel" aria-label="同步问题">
    <div className="sync-history-toolbar"><h3>{group ? group.title : '同步问题'}</h3>
      <button className="button" onClick={group ? () => setSelectedKind(null) : onClose}>{group ? '返回问题分类' : '返回同步概览'}</button></div>
    {enabled === false && <p role="status">自动同步已关闭。以下为已保存的状态，当前不会读取或自动重试。</p>}
    {group ? <>
      <p>{group.description}{group.kind === 'temporary' && enabled === true ? '同步开启期间会自动重试。' : ''}</p>
      <ContactStatusList key={group.kind} contacts={selected} bodyAvailable={bodyAvailable} enabled={enabled} onOpenContact={onOpenContact} />
    </> : <>
      <p>{issues.length ? `${issues.length} 位联系人需要关注，按主要原因归类，每位联系人只计一次。` : '当前没有需要关注的同步问题。'}</p>
      <div className="sync-history-groups">{syncIssueGroups.map(item => {
        const count = issues.filter(contact => contact.issue === item.kind).length;
        return count > 0 && <button className="sync-history-group" key={item.kind} onClick={() => setSelectedKind(item.kind)}>
          <strong>{item.title}</strong><span>{count} 位联系人<span aria-hidden="true"> ›</span></span>
        </button>;
      })}</div>
    </>}
    {onOpenDiagnostics && <button className="button sync-history-diagnostics-link" onClick={onOpenDiagnostics}>打开同步诊断</button>}
  </section>;
}

export function HistoryCoverageStatus({ coverages, contacts, bodyAvailable, enabled, onOpenContact, onOpenDiagnostics }: CoverageProps & {
  currentContactId?: string | null;
  onOpenContact?: (contactId: string) => void;
  onOpenDiagnostics?: () => void;
}) {
  const [showIssues, setShowIssues] = useState(false);
  useEffect(() => { if (coverages === undefined) setShowIssues(false); }, [coverages]);
  const statuses = useMemo(() => buildSyncContacts(coverages, contacts), [coverages, contacts]);
  // 已保存的历史进度（展示）与当前读取资格（phase）分开：旧后台缺字段时不推断，显示“进度待确认”。
  const savedKnown = statuses.every(contact => contact.savedComplete !== undefined);
  const saved = statuses.filter(contact => contact.savedComplete === true).length;
  // 已读完历史但当前来源资格待重验的联系人；真实来源失效同样落在这里，仍计入“需要关注”。
  const reverifying = statuses.filter(contact => contact.savedComplete === true && !contact.complete && contact.issue === 'source').length;
  const attention = statuses.filter(contact => contact.issue !== null).length;
  const reading = statuses.filter(contact => contact.reading).length;
  const following = statuses.filter(contact => contact.following).length;
  if (showIssues && coverages !== undefined) return <SyncIssuePanel contacts={statuses} bodyAvailable={bodyAvailable} enabled={enabled}
    onClose={() => setShowIssues(false)} onOpenContact={onOpenContact} onOpenDiagnostics={onOpenDiagnostics} />;
  return <section className="sync-history-summary" aria-label="聊天同步进度">
    <h3>聊天同步进度</h3>
    {coverages === undefined ? <p>同步进度暂不可用，状态会自动更新。</p>
      : statuses.length === 0 ? <p>暂无联系人的历史同步进度。</p> : <>
        <p>{savedKnown ? `已保存本机历史：${saved} / ${statuses.length} 位联系人` : '已保存本机历史：进度待确认'}</p>
        {savedKnown && <progress aria-label="已保存本机历史进度" value={saved} max={statuses.length} />}
        <p role="status">{enabled === false ? '自动同步已关闭，已保存的进度会保留。'
          : bodyAvailable === false ? '正文读取尚未开放，正在等待或核验读取能力。'
          : [reading > 0 ? `正在读取 ${reading} 位联系人的历史。` : null,
            following > 0 ? `正在同步 ${following} 位联系人的新消息。` : null,
            reverifying > 0 ? `${reverifying} 位联系人的聊天来源待重新核验，已保存的聊天不受影响。` : null]
            .filter(Boolean).join('') || (savedKnown ? '已保存当前同步进度。' : '后台尚未报告已保存的历史进度，状态会自动更新。')}</p>
        <div className="sync-history-toolbar"><p>{attention ? `${attention} 位联系人同步需要关注` : '当前没有需要关注的同步问题'}</p>
          {attention > 0 && <button className="button" onClick={() => setShowIssues(true)}>查看并处理</button>}</div>
      </>}
  </section>;
}

/** 仅展示已取得的状态；展开单人后才挂载详细统计，不触发读取或授权。 */
export function HistoryCoverageDiagnostics({ coverages, contacts, bodyAvailable, enabled, incrementalIdentityLimit }: CoverageProps) {
  const statuses = useMemo(() => buildSyncContacts(coverages, contacts), [coverages, contacts]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = statuses.find(contact => contact.contactId === selectedId);
  useEffect(() => { if (!selected) setSelectedId(null); }, [selected]);
  return <section className="sync-history-diagnostics" aria-label="同步诊断">
    <div className="sync-history-toolbar"><h3>同步诊断</h3>
      {selected && <button className="button" onClick={() => setSelectedId(null)}>返回诊断列表</button>}</div>
    <p>查看已保存的状态和消息数量，供故障排查使用。这里不会重新授权或触发聊天读取。</p>
    {incrementalIdentityLimit !== undefined && <p>增量同步的消息身份基线上限为 {incrementalIdentityLimit.toLocaleString('zh-CN')} 条；超过上限的会话保留已保存内容，但不会继续增量读取。</p>}
    {selected ? <div className="sync-history-diagnostic-detail"><h4>{selected.displayName}</h4>
      <ContactHistoryCoverage coverages={selected.rows} contactId={selected.contactId} bodyAvailable={bodyAvailable} enabled={enabled} />
    </div> : coverages === undefined ? <p>同步状态暂不可用。</p>
      : <ContactStatusList contacts={statuses} bodyAvailable={bodyAvailable} enabled={enabled} onOpenContact={setSelectedId} diagnostic />}
  </section>;
}
