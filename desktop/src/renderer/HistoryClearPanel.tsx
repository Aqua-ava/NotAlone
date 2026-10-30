import { useEffect, useRef, useState } from 'react';
import type { HistoryClearState, HistoryClearView } from '../shared/history-clear-bridge';
import type { ContactSessionView } from './contact-session';

const initial: HistoryClearState = { revision: -1, contactId: null, scopeRevision: 0, phase: 'idle', clear: null, resync: null, busy: null, error: null };
const boundaryReasons: Record<string, string> = {
  history_boundary_unverified: '本机微信读取能力尚未核验，无法建立精确历史边界。',
  history_no_active_binding: '这位联系人当前没有有效微信绑定，无法读取边界元数据。',
  read_not_authorized: '同步读取已关闭或授权已撤销，未读取边界元数据。',
  read_eligibility_stale: '读取资格在读取过程中变化，候选边界已失效。',
  history_boundary_window_changed: '读取窗口期间来源有变化，未建立边界；可稍后重试。',
  history_boundary_instance_changed: '消息分片实例发生变化，候选边界已失效。',
  history_boundary_namespace_changed: '来源命名空间不连续，候选边界已失效。',
  history_interrupted: '本次边界读取被中断，未接受候选。',
};
function clearSummary(clear: HistoryClearView) {
  if (clear.phase === 'completed') return '已清空这位联系人在 NotAlone 保存的全部聊天文字与非文字占位，并已建立本机历史边界；微信原消息与电脑上的原始文件未改动。';
  if (clear.phase === 'boundary_pending') return `已停止清空前旧历史的写入并清理已保存的聊天。本机历史边界尚未建立${clear.boundaryReason ? `（${boundaryReasons[clear.boundaryReason] ?? clear.boundaryReason}）` : ''}，因此不会显示为清空完成。`;
  if (clear.phase === 'cleanup_blocked') return '历史边界已建立，但受管资料或存储面清理尚未全部完成；请稍后重试清空以继续原操作。';
  if (clear.phase === 'cleaning') return '历史边界已建立，正在清理已保存资料与依赖副本。';
  return null;
}
export function ContactHistoryClear({ session }: { session: ContactSessionView }) {
  const [state, setState] = useState(initial);
  const [confirming, setConfirming] = useState<'clear' | 'resync' | null>(null);
  const [localError, setLocalError] = useState('');
  const latest = useRef(-1);
  // 结果未知时复用同一请求键，避免重试建立第二份重读授权。
  const pendingResyncKey = useRef<string | null>(null);
  const current = useRef(session.state); current.current = session.state;
  const selectedContactId = session.state.selectedContactId;
  const scopeRevision = session.state.scopeRevision;
  useEffect(() => {
    let active = true;
    const receive = (next: HistoryClearState) => { if (active && next.revision >= latest.current) { latest.current = next.revision; setState(next); } };
    const unsubscribe = window.notalone.historyClear.onStateChanged(receive);
    void window.notalone.historyClear.getState().then(receive).catch(() => { if (active) setLocalError('清空状态暂不可用。'); });
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => { setConfirming(null); setLocalError(''); pendingResyncKey.current = null; }, [selectedContactId, scopeRevision]);
  useEffect(() => {
    if (selectedContactId && state.contactId === selectedContactId && state.scopeRevision === scopeRevision && state.phase === 'idle') void refresh();
  }, [selectedContactId, scopeRevision, state.contactId, state.scopeRevision]);
  async function refresh() {
    const scope = current.current;
    if (!scope.selectedContactId) return;
    setLocalError('');
    try { await window.notalone.historyClear.refresh({ contactId: scope.selectedContactId, scopeRevision: scope.scopeRevision }); }
    catch { if (current.current === scope) setLocalError('清空状态已变化，请重新确认联系人。'); }
  }
  async function clearChat() {
    const scope = current.current;
    if (!scope.selectedContactId) return;
    setConfirming(null); setLocalError('');
    try { await window.notalone.historyClear.clear({ contactId: scope.selectedContactId, scopeRevision: scope.scopeRevision }); }
    catch { if (current.current === scope) setLocalError('清空请求已失效，请刷新后重新确认。'); }
  }
  async function resyncHistory() {
    const scope = current.current;
    if (!scope.selectedContactId) return;
    setConfirming(null); setLocalError('');
    const requestKey = pendingResyncKey.current ?? `resync-${crypto.randomUUID()}`;
    pendingResyncKey.current = requestKey;
    try {
      await window.notalone.historyClear.resync({ contactId: scope.selectedContactId,
        scopeRevision: scope.scopeRevision, requestKey, confirmed: true });
    } catch { if (current.current === scope) setLocalError('重新同步结果尚未确认，请稍后刷新或重试同一操作。'); }
  }
  const visible = state.contactId === selectedContactId && state.scopeRevision === scopeRevision;
  const clear = visible ? state.clear : null;
  const resync = visible ? state.resync : null;
  const summary = clear ? clearSummary(clear) : null;
  if (resync?.completed) pendingResyncKey.current = null;
  const busy = visible ? state.busy : null;
  const contactName = session.state.contacts.find(entry => entry.contactId === selectedContactId)?.displayName;
  return <section aria-label="清空聊天与重新同步历史" className="memory-section">
    <h3>清空聊天与重新同步历史</h3>
    {visible && state.phase === 'loading' && <p role="status">正在核对清空与重读状态…</p>}
    {!visible && <p>选择联系人后，可查看其聊天清空与历史重读状态。</p>}
    {clear && <>{summary && <p role="status">{summary}</p>}
      {clear.boundary?.state === 'verified' && <p>本机历史边界已接受：{clear.boundary.memberCount ?? 0} 条旧消息身份被持久排除；之后的新消息继续同步。</p>}
      {clear.failureCode && <p role="status">最近一次未完成原因：{boundaryReasons[clear.failureCode] ?? clear.failureCode}</p>}
      {resync && resync.state !== 'none' && <p role="status">{resync.completed
        ? `重新同步完成：已恢复 ${resync.messageCount} 条文字消息和 ${resync.nonTextCount} 条非文字占位；未恢复旧记忆、助手会话或媒体副本。`
        : resync.failureCode ? `重新同步尚未完成：${resync.failureCode}` : '正在重新同步本机可读历史…'}</p>}</>}
    <div className="history-clear-actions">
      <button className="button" disabled={!selectedContactId || state.phase === 'loading' || !!busy}
        onClick={() => void refresh()}>刷新清空状态</button>
      <button className="button" disabled={!selectedContactId || state.phase !== 'ready' || !!busy}
        onClick={() => setConfirming('clear')}>{clear?.phase === 'completed' ? '再次清空聊天' : '清空聊天'}</button>
      <button className="button" disabled={!selectedContactId || state.phase !== 'ready' || !!busy}
        onClick={() => setConfirming('resync')}>重新同步历史</button>
    </div>
    {busy && <p role="status">{busy === 'clear' ? '正在清空并核对边界，请稍候…' : '正在重新同步本机可读历史，请稍候…'}</p>}
    {confirming === 'clear' && <div role="dialog" aria-label="确认清空聊天">
      <p>清空 {contactName ?? '这位联系人'} 在 NotAlone 中保存的全部聊天、来源和依赖资料，并截断此前未读的旧历史；联系人与同步选择保留。微信原消息不会删除。</p>
      <button className="button" disabled={!!busy} onClick={() => void clearChat()}>确认清空聊天</button>
      <button className="button" onClick={() => setConfirming(null)}>取消</button></div>}
    {confirming === 'resync' && <div role="dialog" aria-label="确认重新同步历史">
      <p>只为 {contactName ?? '这位联系人'} 重新读取本机当前可读的全部历史，并建立新的读取授权。已删除的来源不会恢复，旧记忆、助手会话、媒体副本或旧证明也不会恢复；不会自动开始记忆处理或媒体提取。</p>
      <button className="button" disabled={!!busy} onClick={() => void resyncHistory()}>确认重新同步历史</button>
      <button className="button" onClick={() => setConfirming(null)}>取消</button></div>}
    {(visible && state.error) && <p role="alert">{state.error}</p>}{localError && <p role="alert">{localError}</p>}
  </section>;
}
