import { useEffect, useState } from 'react';
import { historyClearSingleOperationActive, type HistoryClearState } from '../shared/history-clear-bridge';
import { historyRecertifyBatchLimitMax } from '../shared/history-recertify-batch-bridge';
import { useHistoryRecertifyBatch } from './use-history-recertify-batch';

const codeLabels: Record<string, string> = {
  history_recertify_source_changed: '来源与旧资料无法可靠对应，需人工处理',
  history_recertify_source_unverified: '来源实例与旧资料不一致，需人工处理',
  history_recertify_deletion_pending: '该联系人的资料删除尚未完成',
  history_no_active_binding: '没有有效的微信会话绑定',
  history_recertify_stale: '来源或读取资格已变化',
  read_eligibility_stale: '读取资格已变化',
  history_recertify_page_limit: '未能在页数上限内完成全部历史核验',
  history_recertify_incomplete: '全量历史未核验完整',
  history_recertify_already_running: '该联系人已有认证在运行，已等待其终态',
  history_recertify_suppression_unmapped: '删除或清空保护无法映射到新来源',
  history_recertify_terminal_alias_unmapped: '来源终态无法映射到新来源',
  history_recertify_legacy_proof_invalid: '旧来源证明无法核验',
  history_source_continuity_unverified: '来源连续性证明已失效',
  history_source_not_available: '来源内容暂不可用',
  history_native_timeout: '本机读取超时',
  history_native_unavailable: '本机读取暂时不可用',
  history_snapshot_unavailable: '微信历史快照暂不可用',
  history_delta_key_unavailable: '微信数据库密钥暂不可用',
  history_image_key_unavailable: '图片密钥暂不可用',
  history_recertify_stalled: '进度长时间无变化，已取消并确认终态',
};
const reasonLabels: Record<string, string> = {
  connection_changed: '本机服务连接已变化，批量状态只在内存中，不会自动恢复',
  ...codeLabels,
  read_not_authorized: '同步已关闭或授权已撤销',
  history_recertify_interrupted: '本次认证被中断',
  history_recertify_cancelled: '本次认证被取消',
  history_native_closed: '本机读取进程已关闭',
  history_recertify_guard_required: '当前读取工具不支持完整来源守卫',
  history_recertify_request_conflict: '认证请求标识与联系人冲突',
  history_recertify_response_invalid: '认证回包格式无法确认',
  history_recertify_admission_unconfirmed: '无法确认本次认证是否被接纳',
  history_recertify_status_unconfirmed: '无法确认本次认证的进度',
  history_recertify_stop_unconfirmed: '无法确认当前联系人的终态',
  history_recertify_stalled_unconfirmed: '进度停滞且无法确认取消终态',
  history_recertify_failed: '认证程序异常',
};
const stageLabels: Record<string, string> = {
  starting: '正在准备',
  metadata: '正在核对微信账号、来源与读取资格',
  history: '正在重新读取并检查电脑上的微信历史',
  activation: '正在确认检查结果并恢复同步',
  completed: '正在确认最终结果',
  cancelling: '正在停止当前联系人',
};
const codeLabel = (code: string) => codeLabels[code] ?? `原因码：${code}`;
const reasonLabel = (code: string | null) => code === null ? '原因未知' : reasonLabels[code] ?? `原因码：${code}`;
const formatDuration = (startedAt: number | null, finishedAt: number | null) =>
  startedAt !== null && finishedAt !== null && finishedAt >= startedAt ? `${((finishedAt - startedAt) / 1000).toFixed(1)} 秒` : null;
const sumCounts = (map: Record<string, number>) => Object.values(map).reduce((sum, count) => sum + count, 0);

function CodeDistribution({ title, map }: { title: string; map: Record<string, number> }) {
  const entries = Object.entries(map).sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (!entries.length) return null;
  return <div className="fenced-repair-batch-codes">
    <h4>{title}</h4>
    <ul>{entries.map(([code, count]) => <li key={code}><span>{codeLabel(code)}</span><b>{count} 位</b></li>)}</ul>
  </div>;
}

function useSingleHistoryOperationActive(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const bridge = window.notalone?.historyClear;
    if (!bridge) return;
    let subscribed = true;
    const derive = (state: HistoryClearState) => { if (subscribed) setActive(historyClearSingleOperationActive(state)); };
    const unsubscribe = bridge.onStateChanged(derive);
    void bridge.getState().then(derive).catch(() => {});
    return () => { subscribed = false; unsubscribe(); };
  }, []);
  return active;
}

/** 开发者调试区里的批量来源重新认证（ADR-173）：只在开发模式渲染，不进入打包版。 */
export function FencedRepairBatchPanel() {
  const { bridge, state, active } = useHistoryRecertifyBatch();
  const singleBusy = useSingleHistoryOperationActive();
  const [limitText, setLimitText] = useState('5');
  const [allContacts, setAllContacts] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<'overview' | 'start' | 'stop' | null>(null);
  const [localError, setLocalError] = useState('');
  const overview = state.overview;
  const limit = Number(limitText);
  const limitValid = allContacts || (Number.isSafeInteger(limit) && limit >= 1 && limit <= historyRecertifyBatchLimitMax);
  const targetCount = allContacts ? overview.total : Math.min(Number.isSafeInteger(limit) && limit > 0 ? limit : 0, overview.total);
  const startBlocked = active || !!busy || singleBusy || !limitValid || overview.phase !== 'ready' || overview.total === 0 || !overview.readEnabled;
  useEffect(() => {
    if (!bridge) return;
    void bridge.refreshOverview().catch(() => {});
  }, [bridge]);
  useEffect(() => { if (state.phase === 'running' || state.phase === 'stopping') setConfirming(false); }, [state.phase]);
  async function refreshOverview() {
    if (!bridge) return;
    setBusy('overview'); setLocalError('');
    try { await bridge.refreshOverview(); }
    catch { setLocalError('暂时无法读取被围栏联系人，请检查本机服务后重试。'); }
    finally { setBusy(null); }
  }
  async function startBatch() {
    if (!bridge || startBlocked || !limitValid) return;
    setBusy('start'); setConfirming(false); setLocalError('');
    try { await bridge.start({ limit: allContacts ? null : limit, confirmed: true }); }
    catch { setLocalError('暂时不能开始批量修复：请核对概述和同步授权，并确认联系人页没有单个修复或清空操作正在进行。'); }
    finally { setBusy(null); }
  }
  async function stopBatch() {
    if (!bridge || !active) return;
    setBusy('stop'); setLocalError('');
    try { await bridge.stop(); }
    catch { setLocalError('停止请求未送达，请重试停止；批量修复不会自动恢复。'); }
    finally { setBusy(null); }
  }
  const duration = formatDuration(state.startedAt, state.finishedAt);
  const overviewNotes = <>
    {overview.phase === 'loading' && <p role="status">正在读取被围栏联系人…</p>}
    {overview.phase === 'failed' && <p role="alert">{overview.error ?? '暂时无法读取被围栏联系人，请重试。'}</p>}
    {overview.phase === 'ready' && <>
      <p role="status">当前被围栏且有有效读取授权的联系人 <b>{overview.total}</b> 位（其中有未保存图片 <b>{overview.withUnsavedImages}</b> 位），预计需重新读取消息 <b>{overview.messageTotal}</b> 条、补查未保存图片 <b>{overview.imageUnsavedTotal}</b> 张。</p>
      <p>顺序：未保存图片多的先修；图片数相同时，消息较少的先修。</p>
      {!overview.readEnabled && <p role="alert">同步读取已关闭或本人身份已失效，暂时不能批量修复。</p>}
      {overview.fencedTotal > overview.total && <p role="status">另有 {overview.fencedTotal - overview.total} 位仍被围栏但没有有效读取授权，需先在同步设置中核对授权。</p>}
      {overview.total === 0 && overview.fencedTotal === 0 && <p role="status">当前没有被围栏的联系人，无需批量修复。</p>}
    </>}
  </>;
  return <section aria-label="批量修复同步" className="startup-settings fenced-repair-batch">
    <h2>批量修复同步（开发模式）</h2>
    <p>逐个调用联系人页同一个“修复同步”后端路径，严格串行；只在开发调试区出现，不进入打包版。日志与状态只含批次、序号、阶段、计数和原因码。</p>
    <p>开发模式下改动源码会触发重启并中断修复，请暂停其他会话的改动。</p>
    {!bridge && <p>批量修复入口仅在开发模式可用。</p>}
    {bridge && <>
      <h3>被围栏联系人概览</h3>
      {overviewNotes}
      <div className="fenced-repair-batch-controls">
        <label className="fenced-repair-batch-limit">本次最多修复
          <input type="number" min={1} max={historyRecertifyBatchLimitMax} step={1} value={limitText} disabled={active || allContacts}
            aria-label="本次最多修复数量" onChange={event => { setLimitText(event.target.value); setConfirming(false); }} />
          <span>位</span>
        </label>
        <label className="fenced-repair-batch-all"><input type="checkbox" checked={allContacts} disabled={active}
          onChange={event => { setAllContacts(event.target.checked); setConfirming(false); }} /> 全部当前被围栏联系人</label>
        <button className="button" disabled={startBlocked} onClick={() => setConfirming(true)}>开始批量修复</button>
        <button className="button" disabled={active || busy === 'overview'} onClick={() => void refreshOverview()}>{busy === 'overview' ? '正在刷新概览…' : '刷新概览'}</button>
      </div>
      {!limitValid && <p role="alert">请输入 1–{historyRecertifyBatchLimitMax} 之间的整数，或勾选“全部”。</p>}
      {singleBusy && !active && <p role="status">联系人页有单个修复或清空操作正在进行，结束后才能开始批量修复。</p>}
      {active && <div className="fenced-repair-batch-progress">
        <p role="status">批量修复进行中：已完成 {state.completed} / {state.total} 位{state.current
          ? `，正在处理第 ${state.current.index} 位（${stageLabels[state.current.stage] ?? state.current.stage}），已检查 ${state.current.messageCount} 条文字和 ${state.current.pageCount} 页`
          : '。'}。</p>
        {state.aggregateComplete !== null && <p>汇总状态：已有 {state.aggregateComplete} 位联系人的历史覆盖为 complete。</p>}
        <CodeDistribution title="失败原因码" map={state.failedByCode} />
        <CodeDistribution title="跳过原因码" map={state.skippedByCode} />
        <button className="button" disabled={state.phase === 'stopping' || busy === 'stop'} onClick={() => void stopBatch()}>
          {state.phase === 'stopping' ? '正在停止批量修复…' : '停止批量修复'}</button>
        {state.phase === 'stopping' && <p role="status">正在取消当前联系人并等待确认终态；确认前不会开始下一位，也不会自动恢复。</p>}
      </div>}
      {(state.phase === 'finished' || state.phase === 'interrupted') && <div className="fenced-repair-batch-summary">
        <p role={state.phase === 'interrupted' ? 'alert' : 'status'}>
          {state.phase === 'interrupted' ? `批量修复已中断：${reasonLabel(state.interruptedReason)}。` : '批量修复结束。'}
          完成 {state.completed} 位，失败 {sumCounts(state.failedByCode)} 位，跳过 {sumCounts(state.skippedByCode)} 位，启动时已不再围栏 {state.alreadyFixed} 位{duration ? `，用时 ${duration}` : ''}。
        </p>
        {state.phase === 'interrupted' && <p>已完成与失败统计保留；重跑只会处理仍被围栏的联系人，不会重复已完成的。</p>}
        <CodeDistribution title="失败原因码" map={state.failedByCode} />
        <CodeDistribution title="跳过原因码" map={state.skippedByCode} />
        <button className="button" disabled={!!busy || singleBusy || !overview.readEnabled || overview.total === 0} onClick={() => void refreshOverview().then(() => setConfirming(true))}>再次修复剩余</button>
      </div>}
      {confirming && !active && <div role="dialog" aria-label="确认批量修复" className="fenced-repair-batch-confirm">
        <p>将按“未保存图片多的先修、图片数相同时消息少的先修”的顺序，依次修复这次快照中的 {targetCount} 位被围栏且有有效读取授权的联系人。</p>
        <p>每位会重新读取电脑上当前可读的全部历史；修复期间该联系人的旧资料会暂时撤下，全部检查通过后才恢复使用。</p>
        <p>不会调用模型，也不会提取图片等媒体内容；每位联系人仍由后端独立复验当前账号、绑定、来源与读取资格。</p>
        <p>过程中可以随时停止；遇到全局性问题或连续同类失败会整体停下并显示原因码，不会自动恢复。失败或中断时读取保持停止。</p>
        <p>开发模式下改动源码会触发重启并中断修复，请暂停其他会话的改动。</p>
        <div className="fenced-repair-batch-confirm-actions">
          <button className="button" disabled={busy === 'start' || singleBusy} onClick={() => void startBatch()}>确认修复 {targetCount} 位</button>
          <button className="button" disabled={busy === 'start'} onClick={() => setConfirming(false)}>取消</button>
        </div>
      </div>}
      {localError && <p role="alert">{localError}</p>}
      {state.phase === 'idle' && overview.phase === 'ready' && overview.total > 0 && !singleBusy && <p>一次确认只覆盖启动时快照中的联系人；之后新增被围栏的联系人需要再次确认。</p>}
    </>}
  </section>;
}
