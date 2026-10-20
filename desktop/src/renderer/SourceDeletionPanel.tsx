import { useEffect, useRef, useState } from 'react';
import { MemoryList } from './MemoryList';
import type { SourceDeletionState, DeletionSource } from '../shared/source-deletion-bridge';
import type { ContactSessionView } from './contact-session';
import { UpdateBackupCleanupRecovery } from './UpdateBackupDeletionNotice';
const initial: SourceDeletionState = { revision: -1, contactId: null, scopeRevision: 0, phase: 'idle', sources: [], busySourceId: null, error: null };
const stepNames = { mark_deleted: '标记删除', delete_derived: '清理派生资料', delete_index: '清理检索索引', clear_cache: '清理缓存', verify_not_retrievable: '不可检索校验' };
function status(source: DeletionSource) {
  const task = source.task;
  if (task?.backupCleanupRequired) return '更新备份尚未清理，删除未完成。请查看恢复说明并核验本机备份，再重试原删除。';
  if (task?.status === 'succeeded') return '已删除，已通过不可检索校验';
  if (task?.status === 'failed') return `删除失败：${stepNames[task.step]}，可重试原任务`;
  if (task?.status === 'cancelled') return '删除任务已取消，尚未确认删除完成';
  if (task) return `${task.status === 'queued' ? '已请求删除，等待执行' : '正在删除'}：${stepNames[task.step]}`;
  return source.status === 'active' ? '有效来源' : '删除结果尚未核验';
}
export function SourceDeletionPanel({ session, refreshKey = '' }: { session: ContactSessionView; refreshKey?: string }) {
  const [state, setState] = useState(initial);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [error, setError] = useState('');
  const latest = useRef(-1);
  const current = useRef(session.state); current.current = session.state;
  useEffect(() => {
    let active = true;
    const receive = (next: SourceDeletionState) => { if (active && next.revision >= latest.current) { latest.current = next.revision; setState(next); } };
    const unsubscribe = window.notalone.sources.onStateChanged(receive);
    void window.notalone.sources.getState().then(receive).catch(() => { if (active) setError('来源目录暂不可用。'); });
    return () => { active = false; unsubscribe(); };
  }, []);
  async function refresh() {
    const scope = current.current;
    if (!scope.selectedContactId) return;
    setError('');
    try { await window.notalone.sources.refresh({ contactId: scope.selectedContactId, scopeRevision: scope.scopeRevision }); }
    catch { if (current.current === scope) setError('来源范围已变化，请重新确认联系人。'); }
  }
  useEffect(() => {
    setConfirmation(null); setError('');
    if (session.state.selectedContactId && (!state.busySourceId
      || state.contactId !== session.state.selectedContactId || state.scopeRevision !== session.state.scopeRevision)) void refresh();
  }, [session.state.selectedContactId, session.state.scopeRevision, refreshKey]);
  async function remove() {
    const scope = current.current; const sourceId = confirmation;
    if (!scope.selectedContactId || !sourceId) return;
    setConfirmation(null); setError('');
    try { await window.notalone.sources.delete({ contactId: scope.selectedContactId, scopeRevision: scope.scopeRevision, sourceId }); }
    catch { if (current.current === scope) setError('来源目录已变化，请刷新后重新确认。'); }
  }
  const visible = state.contactId === session.state.selectedContactId && state.scopeRevision === session.state.scopeRevision;
  const contactName = session.state.contacts.find((entry) => entry.contactId === session.state.selectedContactId)?.displayName;
  const confirmedSource = visible ? state.sources.find((source) => source.sourceId === confirmation) : undefined;
  return <section aria-label="已导入资料" className="memory-section">
    <h3>已导入资料</h3><button className="button" disabled={!session.state.selectedContactId || state.phase === 'loading' || !!state.busySourceId} onClick={() => void refresh()}>刷新资料与删除状态</button>
    {visible && state.phase === 'loading' && <p role="status">正在核对来源与删除任务…</p>}
    {visible && state.phase === 'ready' && state.sources.length === 0 && <p>这位联系人还没有可管理的来源资料。</p>}
    {visible && state.phase === 'ready' && <MemoryList key={`${state.contactId}:${state.scopeRevision}`} items={state.sources} label="已导入资料" className="memory-source-list" list>{(source) => <li key={source.sourceId} data-source-id={source.sourceId}>
      <b>{source.fileName ?? '文件名已清除'}</b><p>{source.recordCount} 条记录</p><p role="status">{status(source)}</p>
      {source.task?.status !== 'succeeded' && <button className="button" disabled={!!state.busySourceId} onClick={() => setConfirmation(source.sourceId)}>{source.task ? '重试来源删除' : '删除来源'}</button>}
      {source.task?.backupCleanupRequired && <UpdateBackupCleanupRecovery />}
    </li>}</MemoryList>}
    {confirmedSource && <div role="dialog" aria-label="确认来源删除">
      <p>删除 {contactName} 的「{confirmedSource.fileName ?? '文件名已清除'}」及失去有效来源支持的资料；其他有效来源支持的内容保留。</p>
      <button className="button" onClick={() => void remove()}>确认删除来源</button><button className="button" onClick={() => setConfirmation(null)}>取消删除</button></div>}
    {visible && state.error && <p role="alert">{state.error}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}
