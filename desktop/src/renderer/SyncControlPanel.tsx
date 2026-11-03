import { HistoryCoverageStatus } from './HistoryCoverageStatus';
import { syncScopeNotice } from './sync-scope-notice';
import { useEffect, useState } from 'react';
import type { SyncControlBridge, SyncControlState, SyncStatusReport } from '../shared/sync-control-bridge';
import { useRevisionedSession } from './use-revisioned-session';
import { useVisibleRefresh } from './use-visible-refresh';
import './bindings.css';

const initial: SyncControlState = { revision: -1, scopeRevision: 0, phase: 'offline', report: null, busy: null, errorCode: null };
const localHistoryNotices: Record<string, string> = {
  local_history_deleted: '部分已确认会话在本机微信有删除记录，当前没有可读历史。历史覆盖尚未确认；这些会话收到新消息后会再次检查。',
  local_history_empty: '部分已确认会话在本机微信暂未保存聊天记录。历史覆盖尚未确认；这些会话收到新消息后会再次检查。',
};

// 自动恢复属于总开关内部流程；只在持续异常时展开可处理的说明。
function SyncRecoveryStatus({ report }: { report: SyncStatusReport }) {
  const { backfill } = report;
  const localHistory = backfill.failedContacts === 0
    ? localHistoryNotices[backfill.failureCode ?? ''] : undefined;
  const recovering = !localHistory && ['failed', 'incomplete'].includes(backfill.phase);
  const [needsAttention, setNeedsAttention] = useState(false);
  useEffect(() => {
    setNeedsAttention(false);
    if (!recovering) return;
    const timer = setTimeout(() => setNeedsAttention(true), 60_000);
    return () => clearTimeout(timer);
  }, [recovering]);
  if (['complete', 'not_required'].includes(backfill.phase)) return null;
  return <div aria-label="遗漏消息同步">
    {localHistory && ['gap_detected', 'backfilling', 'paused'].includes(backfill.phase)
      && <p role="status">正在自动同步遗漏消息…</p>}
    {localHistory ? <details className="sync-backfill-details">
      <summary>部分旧消息在本机不可读取</summary><p>{localHistory}</p>
    </details> : <>
      <p role="status">{recovering ? '部分消息暂未同步，正在自动重试。' : '正在自动同步遗漏消息…'}</p>
      {recovering && needsAttention && <details className="sync-backfill-details">
        <summary>同步恢复较慢，查看说明</summary>
        <p>请检查微信是否正常运行。应用会继续自动重试，恢复后无需手动补齐。</p>
      </details>}
    </>}
  </div>;
}

export function SyncControlPanel({ bridge, manualRelease = false, contacts, currentContactId }: { bridge: SyncControlBridge; manualRelease?: boolean; contacts?: { contactId: string; displayName: string }[]; currentContactId?: string | null }) {
  const { state, latest, active, error, setError, retry } = useRevisionedSession(initial, bridge);
  useEffect(() => {
    // 连接时报告可能还未播种；进入页面只刷新一次缓存状态，不触发正文周期。
    void bridge.refresh().catch(() => { if (active.current) setError('同步状态暂时无法刷新，请重试。'); });
  }, [bridge, active, setError]);
  async function operate(operation: () => Promise<void>) {
    const scopeRevision = latest.current.scopeRevision;
    try { await operation(); if (active.current && scopeRevision === latest.current.scopeRevision) setError(''); }
    catch { if (active.current && scopeRevision === latest.current.scopeRevision) setError('本次同步范围已变化，请重试读取状态后再操作。'); }
  }
  async function retryStatus() {
    await retry();
    await operate(() => bridge.refresh());
  }
  const readFailed = !!error || !!state.errorCode || state.phase === 'failed' || state.phase === 'unavailable';
  const report = state.report;
  // 有进度的运行状态已由主进程持续推送；这里只补齐关闭或尚无进度时的只读更新。
  const hasAutomaticSnapshot = !!report?.enabled && (!!report.priority || report.syncScope === 'all_private' || !!report.historyCoverages?.length);
  useVisibleRefresh(() => operate(() => bridge.refresh()), state.phase === 'ready' && state.busy === null && !readFailed && !hasAutomaticSnapshot);
  const scopeNotice = syncScopeNotice(report?.backgroundFailureCode);
  const selectionOnly = report?.selectionOnly === true;
  const bodyAvailable = report?.bodyAvailable !== false;
  const allPrivate = !selectionOnly && report?.syncScope === 'all_private';
  const changeScope = (mode: 'selected' | 'all_private') => operate(() => bridge.setScope({ scopeRevision: state.scopeRevision, mode, confirmed: true }));
  const decideHistory = (decision: 'accepted' | 'declined') => operate(() => bridge.setHistoryAuthorization({ scopeRevision: state.scopeRevision, decision, confirmed: true }));
  const historyAuthorization = report?.historyAuthorizationState ?? 'unknown';
  const available = state.phase === 'ready' && report !== null && state.busy === null;
  const switchSync = () => operate(() => report?.enabled
    ? bridge.disable({ scopeRevision: state.scopeRevision }) : bridge.enable({ scopeRevision: state.scopeRevision }));
  if (manualRelease) return <section className="bindings-explanation" aria-label="微信自动接入状态">
    <h2>微信自动接入尚未提供</h2>
    <p>首版请明确选择联系人，手动粘贴当前文字或导入已有单联系人 JSONL。无需配置微信工具、终端路径或系统权限。</p>
    <p role="status">{report ? `已保存的同步总开关：${report.enabled ? '开启' : '关闭'}；已确认范围：${report.confirmedBindingCount}个会话。`
      : '本次同步运行状态尚未核验；不能据此判断后台已停止。'}</p>
    {report && <p>本次后台报告：{report.backgroundPhase === 'active' ? '正在运行' : report.backgroundPhase === 'disabled' ? '读取已关闭'
      : report.backgroundPhase === 'waiting_bindings' ? '等待已有确认范围' : '读取不可用'}。现有授权与暂停状态继续保留。</p>}
    {report?.enabled && <button className="button" disabled={!available} onClick={() => void switchSync()}>
      {state.busy === 'disable' ? '正在关闭后台同步…' : '关闭后台同步'}</button>}
    {state.errorCode && <p role="alert">同步运行状态暂未核验。请保留当前资料，重新打开 App 后查看；此状态不影响手动输入。</p>}
    {error && <p role="alert">{error}<button className="button" onClick={() => void retry()}>重试读取</button></p>}
  </section>;
  return <div className="bindings-page">
    <section className="bindings-explanation" aria-label="后台 CLI 同步">
      <div className="bindings-toolbar"><h2>自动同步总开关</h2>
        {readFailed && <button className="button" disabled={state.phase === 'loading' || state.busy !== null}
          onClick={() => void retryStatus()}>重试读取同步状态</button>}</div>
      <p role="status">{!report ? '后台正文同步状态未确认' : !report.enabled ? '后台正文同步已关闭'
        : bodyAvailable ? '后台正文同步已开启' : '已开启同步，等待读取能力核验'}</p>
      <button className="button" disabled={!available} onClick={() => void switchSync()}>{state.busy === 'enable' ? '正在开启后台同步…'
        : state.busy === 'disable' ? '正在关闭后台同步…' : report?.enabled ? '关闭后台同步' : '开启后台同步'}</button>
      {bodyAvailable ? <p>{allPrivate ? '开启后自动关联并同步全部微信私聊的聊天记录，包括以后新增的会话；已单独停止的会话保持排除。' : '开启后自动同步已授权联系人的聊天记录。'}图片保存本机可读取的版本，包括缩略图；依据微信资源来源标记图片版本，取不到就保留消息和处理状态。关闭或退出 App 会停止读取；重新开启后，会自动同步遗漏消息。</p>
        : <p>开启后会先核验微信账号和聊天来源，通过后读取已授权会话的历史与新消息。关闭或退出 App 会停止读取。</p>}
      <section aria-label="微信私聊同步范围">
        <h3>同步范围</h3>
        <p role="status">{report ? allPrivate ? '当前范围：全部微信私聊（包括以后新增的会话）' : '当前范围：仅已关联并授权的会话' : '同步范围尚未确认'}</p>
        {selectionOnly ? <p>请到「联系人」逐人确认私聊；每次确认包含该会话本机可读的历史文字和后续新消息，新私聊不会自动纳入。</p> : allPrivate ? <>
          <p>已有和以后新增的微信私聊会自动建立对应联系人并同步，无需逐个确认。不会按同名合并不同微信账号。</p>
          {!report?.enabled && <p>总开关已关闭；范围已保存，开启后台同步后开始自动关联并读取。</p>}
          <p>改回仅同步已关联会话后，不再自动添加新会话；已有授权仍保留。停止某个人的同步，请在顶部选择联系人后，在本页操作。</p>
          <button className="button" disabled={!available} onClick={() => void changeScope('selected')}>改为仅同步已关联会话</button>
        </> : <>
          <p><strong>同步全部微信私聊，包括以后新增的会话</strong></p>
          <p>确认后，开启后台同步时会自动创建或复用对应联系人，读取现有及以后新增的微信私聊文字，不再逐个询问。群聊不在此范围；已单独停止的会话保持排除。</p>
          <button className="button primary" disabled={!available} onClick={() => void changeScope('all_private')}>确认同步全部微信私聊</button>
          <p>添加同步对象请到「联系人」确认；停止单个联系人的同步可在本页操作。</p>
        </>}
        {state.busy === 'scope' && <p role="status">正在保存同步范围…</p>}
        {!selectionOnly && report?.syncScopeFailureCode && <div role="alert"><p>自动关联微信私聊暂时受阻。请确认微信可用后重试；存在身份冲突的会话需要到「联系人」核对，已停止的会话不会自动恢复。</p>
          <button className="button" disabled={!available} onClick={() => void changeScope('all_private')}>重试自动关联</button></div>}
      </section>
      {report && !selectionOnly && <section aria-label="历史聊天读取">
        <h3>历史聊天</h3>
        {historyAuthorization === 'required' && <>
          <p role="status">读取范围将扩大：此前的同步授权只读取新消息。允许后，NotAlone 会读取当前已授权微信私聊在本机现有的全部文字历史，再继续同步新消息。</p>
          <p>聊天记录仍只保存在本机。历史读取仍只在后台同步开启且应用运行时进行。选择暂不读取不会改变同步总开关或已有会话授权，之后仍可在这里允许。</p>
          <button className="button primary" disabled={!available} onClick={() => void decideHistory('accepted')}>允许读取历史</button>
          <button className="button" disabled={!available} onClick={() => void decideHistory('declined')}>暂不读取</button>
        </>}
        {historyAuthorization === 'declined' && <>
          <p role="status">历史读取未开启：已有授权会话继续只同步新消息。允许后，会读取它们在本机现有的全部文字历史，再继续同步新消息。</p>
          <button className="button" disabled={!available} onClick={() => void decideHistory('accepted')}>允许读取历史</button>
        </>}
        {historyAuthorization === 'accepted' && <p role="status">已允许读取授权会话在这台电脑上的历史文字消息，并持续同步新消息。</p>}
        {historyAuthorization === 'unknown' && <p>历史读取授权状态尚未确认，状态会自动更新；读取失败时可重试。</p>}
        {state.busy === 'history' && <p role="status">正在保存历史读取授权…</p>}
      </section>}
      {scopeNotice && <p role="alert">部分已授权会话暂停读取：{scopeNotice}</p>}
      {state.phase === 'loading' && <p role="status">正在确认同步状态…</p>}
      {state.phase === 'offline' && <p>连接本机服务后查看与控制后台同步。</p>}
      {state.phase === 'unavailable' && <p role="alert">本次运行身份或同步宿主尚未就绪，请检查配置后重试读取状态。</p>}
      {state.errorCode && <p role="alert">{state.errorCode === 'operation-unconfirmed'
        ? '同步操作结果尚未确认，请重试读取状态后再决定下一步。'
        : '同步状态读取失败，请检查本机服务与 CLI 后重试。'}</p>}
      {error && <p role="alert">{error}</p>}
      {report && <HistoryCoverageStatus coverages={report.historyCoverages} contacts={contacts} currentContactId={currentContactId} bodyAvailable={bodyAvailable} />}
      {bodyAvailable && report?.enabled && <SyncRecoveryStatus key={state.scopeRevision} report={report} />}
    </section>
  </div>;
}
