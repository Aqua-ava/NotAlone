import { useEffect } from 'react';
import type { BackgroundSyncPhase, SyncBackfillPhase, SyncControlBridge, SyncControlState } from '../shared/sync-control-bridge';
import { useRevisionedSession } from './use-revisioned-session';
import './bindings.css';

const initial: SyncControlState = { revision: -1, scopeRevision: 0, phase: 'offline', report: null, busy: null, errorCode: null };
const backgroundLabels: Record<BackgroundSyncPhase, string> = { disabled: '后台读取已关闭', waiting_bindings: '等待确认会话授权',
  active: '后台读取运行中', degraded: '后台读取已降级，请检查 CLI 后刷新状态' };
const backfillLabels: Record<SyncBackfillPhase, string> = { not_required: '当前没有补齐任务', gap_detected: '已检测到待补齐缺口',
  backfilling: '正在补齐历史消息', complete: '补齐已完成', failed: '补齐失败', incomplete: '无法确认补齐完整性', paused: '补齐已暂停' };
const backfillFailures: Record<string, string> = { cli_freshness_unknown: 'CLI未能确认覆盖到当前水位，请检查后显式重试。',
  cli_output_invalid: 'CLI返回的数据无法解析，本次补齐未完成，请检查后显式重试。' };
const localHistoryNotices: Record<string, string> = {
  local_history_deleted: '部分已确认会话在本机微信有删除记录，当前没有可读历史。历史覆盖尚未确认；这些会话收到新消息后会再次检查。',
  local_history_empty: '部分已确认会话在本机微信暂未保存聊天记录。历史覆盖尚未确认；这些会话收到新消息后会再次检查。',
};

export function SyncControlPanel({ bridge, manualRelease = false }: { bridge: SyncControlBridge; manualRelease?: boolean }) {
  const { state, latest, active, error, setError } = useRevisionedSession(initial, bridge);
  useEffect(() => {
    // 连接时报告可能还未播种；进入页面只刷新一次缓存状态，不触发正文周期。
    void bridge.refresh().catch(() => { if (active.current) setError('同步状态暂时无法刷新，请重试。'); });
  }, [bridge, active, setError]);
  async function operate(operation: () => Promise<void>) {
    const scopeRevision = latest.current.scopeRevision;
    try { await operation(); if (active.current && scopeRevision === latest.current.scopeRevision) setError(''); }
    catch { if (active.current && scopeRevision === latest.current.scopeRevision) setError('本次同步范围已变化，请刷新状态后重试。'); }
  }
  const report = state.report;
  const localHistory = report?.backfill.failedContacts === 0
    ? localHistoryNotices[report.backfill.failureCode ?? ''] : undefined;
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
    {error && <p role="alert">{error}</p>}
  </section>;
  return <div className="bindings-page">
    <section className="bindings-explanation" aria-label="后台 CLI 同步">
      <div className="bindings-toolbar"><h2>自动同步总开关</h2><button className="button"
        disabled={state.phase === 'offline' || state.phase === 'loading' || state.busy !== null}
        onClick={() => void operate(() => bridge.refresh())}>刷新同步状态</button></div>
      <p role="status">{report ? report.enabled ? '后台正文同步已开启' : '后台正文同步已关闭' : '后台正文同步状态未确认'}</p>
      <button className="button" disabled={!available} onClick={() => void switchSync()}>{state.busy === 'enable' ? '正在开启后台同步…'
        : state.busy === 'disable' ? '正在关闭后台同步…' : report?.enabled ? '关闭后台同步' : '开启后台同步'}</button>
      <p>开启后自动同步已授权联系人的文字。关闭或退出 App 会停止读取；重新开启后，在有效授权范围内补齐遗漏。</p>
      <p>添加同步对象或停止某个人的同步，请到「联系人」管理。</p>
      {report && <p>{backgroundLabels[report.backgroundPhase]}。已确认范围：{report.confirmedBindingCount}个会话。</p>}
      {state.phase === 'loading' && <p role="status">正在确认同步状态…</p>}
      {state.phase === 'offline' && <p>连接本机服务后查看与控制后台同步。</p>}
      {state.phase === 'unavailable' && <p role="alert">本次运行身份或同步宿主尚未就绪，请检查配置后刷新状态。</p>}
      {state.errorCode && <p role="alert">{state.errorCode === 'operation-unconfirmed'
        ? '同步操作结果尚未确认，请刷新同步状态后再决定下一步。'
        : '同步状态读取失败，请检查本机服务与 CLI 后刷新。'}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
    <section className="bindings-explanation" aria-label="历史补齐"><h2>历史补齐</h2>
      <p role="status">{localHistory && report?.backfill.phase === 'incomplete' ? '部分会话本地无可读历史，覆盖尚未确认'
        : report ? backfillLabels[report.backfill.phase] : '补齐状态尚未确认'}</p>
      {report && <p>本轮已检查{report.backfill.completedContacts}／{report.backfill.totalContacts}个会话。
        {report.backfill.failedContacts > 0 && ` ${report.backfill.failedContacts}个失败。`}
        {report.backfill.incompleteContacts > 0 && ` ${report.backfill.incompleteContacts}个无法确认完整。`}</p>}
      <details className="sync-backfill-details"><summary>查看补齐详情与操作</summary>
        {report && <><p>已完成{report.backfill.completedContacts}／{report.backfill.totalContacts}个会话，待处理{report.backfill.pendingContacts}个；
        失败{report.backfill.failedContacts}个，无法确认完整{report.backfill.incompleteContacts}个。</p>
        <p>已写入文字{report.backfill.messageCount}条，已跳过非文字{report.backfill.nonTextCount}条。</p>
        {report.backfill.failureCode && <p role={localHistory ? 'status' : 'alert'}>{localHistory ?? backfillFailures[report.backfill.failureCode]
          ?? '本次补齐遇到错误，请检查本机服务与CLI后显式重试。'}</p>}</>}
      <div className="bindings-toolbar"><button className="button"
        disabled={!available || !report?.enabled || !['gap_detected', 'backfilling', 'incomplete'].includes(report.backfill.phase)}
        onClick={() => void operate(() => bridge.pause({ scopeRevision: state.scopeRevision }))}>
        {state.busy === 'pause' ? '正在暂停补齐…' : '暂停补齐'}</button>
        <button className="button" disabled={!available || !report?.enabled || !['paused', 'failed', 'incomplete'].includes(report.backfill.phase)}
          onClick={() => void operate(() => bridge.retry({ scopeRevision: state.scopeRevision }))}>
          {state.busy === 'retry' ? '正在重试补齐…' : '重试补齐'}</button></div>
      <p>暂停只针对历史补齐；后台总开关开启时，已确认范围的实时增量仍可读取。关闭后台同步会停止全部新增正文读取。</p>
      </details>
    </section>
  </div>;
}
