import { useEffect, useRef, useState } from 'react';
import { historyRecertifyFailureMessage, type HistoryClearState, type HistoryClearView, type HistoryRecertifyView } from '../shared/history-clear-bridge';
import type { ContactSessionView } from './contact-session';
import { useHistoryRecertifyBatch } from './use-history-recertify-batch';

const initial: HistoryClearState = { revision: -1, contactId: null, scopeRevision: 0, phase: 'idle', clear: null, resync: null, recertify: null, pendingRecertifyKey: null, recertifyStoppingKey: null, recertifyCancelBusy: false, busy: null, error: null };
const boundaryReasons: Record<string, string> = {
  history_boundary_unverified: '暂时无法核对电脑上的微信历史。',
  history_no_active_binding: '这位联系人还没有可读取的微信会话，请先检查同步设置。',
  read_not_authorized: '同步已关闭或不再允许读取，请先检查同步设置。',
  read_eligibility_stale: '同步设置已变化，请重新确认后继续。',
  history_boundary_window_changed: '核对时微信历史发生了变化，请稍后继续。',
  history_boundary_instance_changed: '电脑上的微信历史发生了变化，请稍后继续。',
  history_boundary_namespace_changed: '电脑上的微信历史暂时无法确认，请先检查同步情况。',
  history_interrupted: '核对微信历史时中断了，请稍后继续。',
  exact_channel_cutoff_required: '还没有确认哪些旧聊天应停止导入，请检查同步情况后继续。',
};
const repairReasons: Record<string, string> = {
  history_recertify_not_required: '目前没有需要修复的同步问题。',
  history_recertify_already_running: '这位联系人的同步正在修复，请等待本次结果。',
  history_recertify_guard_required: '当前微信读取工具暂不支持这次修复。',
  history_recertify_source_changed: '现在的微信历史与旧资料对不上，暂时无法安全恢复同步。',
  history_recertify_deletion_pending: '还有资料没有删除完，请完成删除后再试。',
  history_recertify_stale: '微信历史或同步设置已变化，本次修复已停止。',
  read_eligibility_stale: '微信历史或同步设置已变化，本次修复已停止。',
  read_not_authorized: '同步已关闭或不再允许读取，请先检查同步设置。',
  history_no_active_binding: '这位联系人还没有可读取的微信会话，请先检查同步设置。',
  history_recertify_interrupted: '本次修复已中断，同步尚未恢复。',
  history_recertify_cancelled: '已停止本次修复，同步尚未恢复。',
  history_source_continuity_unverified: '暂时无法确认微信历史的来源，同步尚未恢复。',
  history_recertify_page_limit: '还没有检查完电脑上的全部历史，同步尚未恢复。',
  history_recertify_incomplete: '还没有检查完电脑上的全部历史，同步尚未恢复。',
  history_recertify_request_conflict: '本次修复与当前联系人不一致，请重新选择联系人。',
};
function clearSummary(clear: HistoryClearView) {
  if (clear.phase === 'completed') return '已清空这位联系人在 NotAlone 中保存的聊天及相关资料，旧聊天不会自动导回。微信里的聊天和电脑上的原始文件没有删除。';
  if (clear.phase === 'boundary_pending') return `已清理 NotAlone 中保存的聊天，但还没有确认哪些旧聊天应停止导入，清空尚未全部完成。${clear.boundaryReason ? boundaryReasons[clear.boundaryReason] ?? '请检查同步情况后继续。' : ''}`;
  if (clear.phase === 'cleanup_blocked') return '旧聊天已停止导入，还有相关资料没有清理完。可以继续清空。';
  if (clear.phase === 'cleaning') return '正在清理 NotAlone 中保存的聊天和相关资料，进度会自动更新。';
  return null;
}
function recertifySummary(view: HistoryRecertifyView): string | null {
  if (view.completed) return `同步修复完成：已重新核对 ${view.messageCount} 条文字记录和 ${view.nonTextCount} 条其他消息记录，保留了 ${view.preservedMessageCount} 条旧消息。旧资料中无法确认来源的记忆和助手结果不会自动恢复使用。`;
  if (view.state === 'failed' || view.state === 'interrupted') return `同步修复未完成：${repairReasons[view.failureCode ?? ''] ?? '暂时无法完成检查，同步尚未恢复。'}旧资料仍保留。`;
  if (view.state === 'running') {
    const stage = { none: '正在准备修复', metadata: '正在核对微信账号和联系人', history: '正在重新读取并检查电脑上的微信历史', activation: '正在确认检查结果并恢复同步', completed: '正在确认最终结果' }[view.stage];
    return `${stage}：已检查 ${view.messageCount} 条文字记录和 ${view.nonTextCount} 条其他消息记录。旧资料仍保留，全部检查通过后才恢复同步。`;
  }
  return null;
}
type Confirmation = { action: 'clear' | 'recertify'; contactId: string; scopeRevision: number };
export function ContactHistoryClear({ session, repairNeeded = false }: { session: ContactSessionView; repairNeeded?: boolean }) {
  const recertifyBatch = useHistoryRecertifyBatch();
  const batchActive = recertifyBatch.active;
  const [state, setState] = useState(initial);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [localError, setLocalError] = useState('');
  const latest = useRef(-1);
  const observedRepair = useRef<{ contactId: string; scopeRevision: number; requestKey: string } | null>(null);
  const current = useRef(session.state); current.current = session.state;
  const selectedContactId = session.state.selectedContactId;
  const scopeRevision = session.state.scopeRevision;
  useEffect(() => {
    let active = true;
    const receive = (next: HistoryClearState) => { if (active && next.revision >= latest.current) { latest.current = next.revision; setState(next); } };
    const unsubscribe = window.notalone.historyClear.onStateChanged(receive);
    void window.notalone.historyClear.getState().then(receive).catch(() => { if (active) setLocalError('暂时读不到操作进度，请重试。'); });
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => { setConfirming(null); setLocalError(''); observedRepair.current = null; }, [selectedContactId, scopeRevision]);
  useEffect(() => { if (!repairNeeded) setConfirming(previous => previous?.action === 'recertify' ? null : previous); }, [repairNeeded]);
  useEffect(() => {
    if (selectedContactId && state.contactId === selectedContactId && state.scopeRevision === scopeRevision && state.phase === 'idle') void refresh();
  }, [selectedContactId, scopeRevision, state.contactId, state.scopeRevision]);
  async function refresh() {
    const scope = current.current;
    if (!scope.selectedContactId) return;
    setLocalError('');
    try { await window.notalone.historyClear.refresh({ contactId: scope.selectedContactId, scopeRevision: scope.scopeRevision }); }
    catch { if (current.current === scope) setLocalError('暂时读不到操作进度，请重试。'); }
  }
  function confirm(action: Confirmation['action']) {
    if (batchActive) return;
    if (selectedContactId && (action !== 'recertify' || repairNeeded)) setConfirming({ action, contactId: selectedContactId, scopeRevision });
  }
  const confirmation = confirming?.contactId === selectedContactId && confirming.scopeRevision === scopeRevision
    && (confirming.action !== 'recertify' || repairNeeded) ? confirming.action : null;
  async function clearChat() {
    const scope = current.current;
    if (!scope.selectedContactId || confirmation !== 'clear') return;
    setConfirming(null); setLocalError('');
    try { await window.notalone.historyClear.clear({ contactId: scope.selectedContactId, scopeRevision: scope.scopeRevision }); }
    catch { if (current.current === scope) setLocalError('清空状态已变化，请重试读取进度后再确认。'); }
  }
  async function recertifyHistory() {
    const scope = current.current;
    if (!scope.selectedContactId || confirmation !== 'recertify' || !repairNeeded) return;
    setConfirming(null); setLocalError('');
    const requestKey = `recertify-${crypto.randomUUID()}`;
    observedRepair.current = { contactId: scope.selectedContactId, scopeRevision: scope.scopeRevision, requestKey };
    try {
      await window.notalone.historyClear.recertify({ contactId: scope.selectedContactId, scopeRevision: scope.scopeRevision,
        requestKey, confirmed: true });
    } catch { if (current.current === scope) setLocalError('修复状态已变化，请重试读取进度后再确认。'); }
  }
  async function stopRecertify() {
    const scope = current.current;
    const requestKey = state.recertifyStoppingKey ?? state.pendingRecertifyKey ?? (state.recertify?.state === 'running' ? state.recertify.requestKey : null);
    if (!scope.selectedContactId || !visible || !requestKey) return;
    setLocalError('');
    try { await window.notalone.historyClear.cancelRecertify({ contactId: scope.selectedContactId, scopeRevision: scope.scopeRevision, requestKey }); }
    catch { if (current.current === scope) setLocalError('停止修复的状态已变化，请重试读取进度。'); }
  }
  const visible = state.contactId === selectedContactId && state.scopeRevision === scopeRevision;
  const clear = visible ? state.clear : null;
  const resync = visible ? state.resync : null;
  const recertify = visible ? state.recertify : null;
  const pendingRecertify = visible && !!state.pendingRecertifyKey;
  const stoppingRecertify = visible && !!state.recertifyStoppingKey;
  const recertifyActive = pendingRecertify || stoppingRecertify || recertify?.state === 'running';
  const showRepair = repairNeeded || recertifyActive || recertify?.state === 'failed' || recertify?.state === 'interrupted';
  const activeRepairKey = recertifyActive ? state.pendingRecertifyKey ?? state.recertifyStoppingKey ?? recertify?.requestKey : null;
  useEffect(() => {
    if (visible && selectedContactId && activeRepairKey) observedRepair.current = { contactId: selectedContactId, scopeRevision, requestKey: activeRepairKey };
  }, [visible, selectedContactId, scopeRevision, activeRepairKey]);
  const observedResult = observedRepair.current?.contactId === selectedContactId && observedRepair.current?.scopeRevision === scopeRevision
    && observedRepair.current?.requestKey === recertify?.requestKey;
  const recertifyMessage = recertify && (!recertify.completed || observedResult) ? recertifySummary(recertify) : null;
  const summary = clear ? clearSummary(clear) : null;
  const busy = visible ? state.busy : null;
  const progressActive = recertifyActive || clear?.phase === 'cleaning' || (resync?.state === 'authorized' || resync?.state === 'active') && !resync.failureCode;
  const hasError = !!localError || visible && (state.phase === 'failed' || !!state.error);
  // 只查询已有操作。读取失败后等待明确重试，不自动重发清空或修复请求。
  useEffect(() => {
    if (!visible || !progressActive || state.phase !== 'ready' || hasError || busy === 'clear' || busy === 'resync') return;
    const timer = setTimeout(() => { void refresh(); }, 2000);
    return () => clearTimeout(timer);
  }, [visible, selectedContactId, scopeRevision, progressActive, state.revision, state.phase, hasError, busy]);
  const contactName = session.state.contacts.find(entry => entry.contactId === selectedContactId)?.displayName;
  const actionsDisabled = !visible || !selectedContactId || state.phase !== 'ready' || !!busy || recertifyActive || batchActive;
  const continueClear = clear?.phase === 'boundary_pending' || clear?.phase === 'cleanup_blocked' || clear?.phase === 'cleaning';
  const friendlyError = Object.entries(repairReasons).find(([code]) => historyRecertifyFailureMessage(code) === state.error)?.[1] ?? state.error;
  const errorMessage = localError || (state.phase === 'failed' ? '暂时读不到操作进度，请重试。' : stoppingRecertify
    ? '还没确认本次修复是否已停止。可以重试读取进度，或再次停止同一次修复。' : pendingRecertify
      ? '还没确认本次修复的结果，请重试读取进度。不会重复开始修复。' : friendlyError);
  return <>
    <section aria-label="清理聊天资料" className="memory-section">
      <h3>清理聊天资料</h3>
      {batchActive && <p role="status">开发者批量修复正在进行：完成或停止批量修复前，不能对单个联系人修复同步、清空聊天或重新同步。</p>}
      {visible && state.phase === 'loading' && !clear && <p role="status">正在读取资料状态…</p>}
      {!visible && !localError && <p>选择联系人后，可管理保存的聊天资料。</p>}
      {summary && busy !== 'clear' && <p role="status">{summary}</p>}
      {clear?.failureCode && !clear.boundaryReason && <p role="status">{boundaryReasons[clear.failureCode] ?? '还有清理步骤没有完成，请稍后继续。'}</p>}
      {resync && resync.state !== 'none' && <p role="status">{resync.completed
        ? `重新同步完成：已恢复 ${resync.messageCount} 条文字记录和 ${resync.nonTextCount} 条其他消息记录；旧记忆、助手会话和媒体副本没有恢复。`
        : resync.failureCode ? '上次重新同步尚未完成，请检查同步情况。' : '正在重新读取电脑上的微信历史，进度会自动更新…'}</p>}
      <button className="button" disabled={actionsDisabled}
        onClick={() => confirm('clear')}>{continueClear ? '继续清空' : '清空已保存的聊天'}</button>
      {busy === 'clear' && <p role="status">正在清空 NotAlone 保存的聊天和相关资料…</p>}
      {confirmation === 'clear' && <div role="dialog" aria-label="确认清空聊天">
        <p>清空 {contactName ?? '这位联系人'} 在 NotAlone 中保存的聊天、来源记录，以及依赖这些聊天的记忆、助手记录等资料；旧聊天不会自动导回。联系人和同步选择保留，之后的新消息仍按同步设置处理。</p>
        <p>微信里的聊天和电脑上的原始文件不会删除。</p>
        <button className="button" disabled={actionsDisabled} onClick={() => void clearChat()}>确认清空聊天</button>
        <button className="button" onClick={() => setConfirming(null)}>取消</button>
      </div>}
    </section>
    {(showRepair || recertifyMessage) && <section aria-label="修复同步" className="memory-section">
      <h3>修复同步</h3>
      {recertifyMessage && <p role={recertify?.state === 'failed' || recertify?.state === 'interrupted' ? 'alert' : 'status'}>{recertifyMessage}</p>}
      {showRepair && <div className="history-clear-actions">
        {repairNeeded && <button className="button" disabled={actionsDisabled || !recertify} onClick={() => confirm('recertify')}>修复同步</button>}
        {recertifyActive && <button className="button" disabled={state.recertifyCancelBusy} onClick={() => void stopRecertify()}>{stoppingRecertify ? '重试停止本次修复' : '停止本次修复'}</button>}
      </div>}
      {stoppingRecertify && <p role="status">正在停止本次修复；收到确定结果前，不会开始新的修复。</p>}
      {busy === 'recertify' && <p role="status">正在开始修复，全部检查通过后才恢复同步…</p>}
      {confirmation === 'recertify' && <div role="dialog" aria-label="确认修复同步">
        <p>为 {contactName ?? '这位联系人'} 重新核对微信历史的来源。旧聊天、来源记录、记忆和助手结果都会保留，无需先清空。</p>
        <p>会重新读取电脑上当前可读的全部历史，全部检查通过后才恢复同步。旧资料中无法确认来源的记忆和助手结果不会自动恢复使用。</p>
        <p>之前的删除、清空和撤回记录仍然有效。检查失败、切换联系人或同步授权变化时会停止；无法保留这些保护时不会恢复同步。</p>
        <p>修复不会自动整理关系资料或记忆，也不会提取图片等媒体内容。</p>
        <button className="button" disabled={actionsDisabled} onClick={() => void recertifyHistory()}>确认修复同步</button>
        <button className="button" onClick={() => setConfirming(null)}>取消</button>
      </div>}
    </section>}
    {hasError && <div>
      <p role="alert">{errorMessage}</p>
      <button className="button" disabled={!selectedContactId || state.phase === 'loading' || busy === 'clear' || busy === 'resync'} onClick={() => void refresh()}>重试读取进度</button>
    </div>}
  </>;
}
