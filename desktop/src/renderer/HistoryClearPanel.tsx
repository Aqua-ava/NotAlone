import { useEffect, useRef, useState } from 'react';
import type { HistoryClearState, HistoryClearView } from '../shared/history-clear-bridge';
import type { ContactSessionView } from './contact-session';

const initial: HistoryClearState = { revision: -1, contactId: null, scopeRevision: 0, phase: 'idle', clear: null, resync: null, busy: null, error: null };
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
function clearSummary(clear: HistoryClearView) {
  if (clear.phase === 'completed') return '已清空这位联系人在 NotAlone 中保存的聊天及相关资料，旧聊天不会自动导回。微信里的聊天和电脑上的原始文件没有删除。';
  if (clear.phase === 'boundary_pending') return `已清理 NotAlone 中保存的聊天，但还没有确认哪些旧聊天应停止导入，清空尚未全部完成。${clear.boundaryReason ? boundaryReasons[clear.boundaryReason] ?? '请检查同步情况后继续。' : ''}`;
  if (clear.phase === 'cleanup_blocked') return '旧聊天已停止导入，还有相关资料没有清理完。可以继续清空。';
  if (clear.phase === 'cleaning') return '正在清理 NotAlone 中保存的聊天和相关资料，进度会自动更新。';
  return null;
}
type Confirmation = { contactId: string; scopeRevision: number };
export function ContactHistoryClear({ session }: { session: ContactSessionView }) {
  const [state, setState] = useState(initial);
  const [confirming, setConfirming] = useState<Confirmation | null>(null);
  const [localError, setLocalError] = useState('');
  const latest = useRef(-1), current = useRef(session.state); current.current = session.state;
  const selectedContactId = session.state.selectedContactId, scopeRevision = session.state.scopeRevision;
  useEffect(() => {
    let active = true;
    const receive = (next: HistoryClearState) => { if (active && next.revision >= latest.current) { latest.current = next.revision; setState(next); } };
    const unsubscribe = window.notalone.historyClear.onStateChanged(receive);
    void window.notalone.historyClear.getState().then(receive).catch(() => { if (active) setLocalError('暂时读不到操作进度，请重试。'); });
    return () => { active = false; unsubscribe(); };
  }, []);
  useEffect(() => { setConfirming(null); setLocalError(''); }, [selectedContactId, scopeRevision]);
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
  const confirmation = confirming?.contactId === selectedContactId && confirming.scopeRevision === scopeRevision;
  async function clearChat() {
    const scope = current.current;
    if (!scope.selectedContactId || !confirmation) return;
    setConfirming(null); setLocalError('');
    try { await window.notalone.historyClear.clear({ contactId: scope.selectedContactId, scopeRevision: scope.scopeRevision }); }
    catch { if (current.current === scope) setLocalError('清空状态已变化，请重试读取进度后再确认。'); }
  }
  const visible = state.contactId === selectedContactId && state.scopeRevision === scopeRevision;
  const clear = visible ? state.clear : null, resync = visible ? state.resync : null, busy = visible ? state.busy : null;
  const summary = clear ? clearSummary(clear) : null;
  const progressActive = clear?.phase === 'cleaning' || (resync?.state === 'authorized' || resync?.state === 'active') && !resync.failureCode;
  const hasError = !!localError || visible && (state.phase === 'failed' || !!state.error);
  // 只查询已有操作；读取失败后等待明确重试，不自动重发清空或重读请求。
  useEffect(() => {
    if (!visible || !progressActive || state.phase !== 'ready' || hasError || busy) return;
    const timer = setTimeout(() => { void refresh(); }, 2000);
    return () => clearTimeout(timer);
  }, [visible, selectedContactId, scopeRevision, progressActive, state.revision, state.phase, hasError, busy]);
  const contactName = session.state.contacts.find(entry => entry.contactId === selectedContactId)?.displayName;
  const actionsDisabled = !visible || !selectedContactId || state.phase !== 'ready' || !!busy;
  const continueClear = clear?.phase === 'boundary_pending' || clear?.phase === 'cleanup_blocked' || clear?.phase === 'cleaning';
  const errorMessage = localError || (state.phase === 'failed' ? '暂时读不到操作进度，请重试。' : state.error);
  return <>
    <section aria-label="清理聊天资料" className="memory-section">
      <h3>清理聊天资料</h3>
      {visible && state.phase === 'loading' && !clear && <p role="status">正在读取资料状态…</p>}
      {!visible && !localError && <p>选择联系人后，可管理保存的聊天资料。</p>}
      {summary && busy !== 'clear' && <p role="status">{summary}</p>}
      {clear?.failureCode && !clear.boundaryReason && <p role="status">{boundaryReasons[clear.failureCode] ?? '还有清理步骤没有完成，请稍后继续。'}</p>}
      {resync && resync.state !== 'none' && <p role="status">{resync.completed
        ? `重新同步完成：已恢复 ${resync.messageCount} 条文字记录和 ${resync.nonTextCount} 条其他消息记录；旧记忆、助手会话和媒体副本没有恢复。`
        : resync.failureCode ? '上次重新同步尚未完成，请检查同步情况。' : '正在重新读取电脑上的微信历史，进度会自动更新…'}</p>}
      <button className="button" disabled={actionsDisabled}
        onClick={() => { if (selectedContactId) setConfirming({ contactId: selectedContactId, scopeRevision }); }}>{continueClear ? '继续清空' : '清空已保存的聊天'}</button>
      {busy === 'clear' && <p role="status">正在清空 NotAlone 保存的聊天和相关资料…</p>}
      {confirmation && <div role="dialog" aria-label="确认清空聊天">
        <p>清空 {contactName ?? '这位联系人'} 在 NotAlone 中保存的聊天、来源记录，以及依赖这些聊天的记忆、助手记录等资料；旧聊天不会自动导回。联系人和同步选择保留，之后的新消息仍按同步设置处理。</p>
        <p>微信里的聊天和电脑上的原始文件不会删除。</p>
        <button className="button" disabled={actionsDisabled} onClick={() => void clearChat()}>确认清空聊天</button>
        <button className="button" onClick={() => setConfirming(null)}>取消</button>
      </div>}
    </section>
    {hasError && <div><p role="alert">{errorMessage}</p>
      <button className="button" disabled={!selectedContactId || state.phase === 'loading' || !!busy} onClick={() => void refresh()}>重试读取进度</button>
    </div>}
  </>;
}
