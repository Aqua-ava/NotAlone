import { useEffect, useRef, useState } from 'react';
import type { ExpressionPreference, ExpressionPreferenceState, ExpressionReplyMode } from '../shared/expression-preference-bridge';
import type { ReplySessionView } from './RewritePanel';
import { useRevisionedSession } from './use-revisioned-session';
import { ExpressionPreferenceBasis, expressionReplyModeNames as modeNames } from './ExpressionPreferenceBasis';

export function ExpressionPreferences({ replies }: { replies: ReplySessionView }) {
  const view = useRevisionedSession<ExpressionPreferenceState>({ revision: -1, erasureRevision: 0,
    contactId: null, scopeRevision: 0, phase: 'idle', preferences: [], busy: false, error: null }, window.notalone.expressionPreferences);
  const [text, setText] = useState('');
  const [appliesTo, setAppliesTo] = useState<'owner' | 'contact'>('contact');
  const [replyMode, setReplyMode] = useState<ExpressionReplyMode | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [editing, setEditing] = useState<ExpressionPreference | null>(null);
  const editRevision = useRef(0);
  const selection = { contactId: replies.state.contactId!, scopeRevision: replies.state.scopeRevision };
  const enabled = Boolean(selection.contactId) && view.state.contactId === selection.contactId
    && view.state.scopeRevision === selection.scopeRevision && !view.state.busy;
  const recovered = !replies.state.result && replies.state.savedSession?.phase === 'ready'
    ? replies.state.savedSession.turns.filter((turn) => turn.state === 'completed' && turn.reply).at(-1) : undefined;
  const used = !selection.contactId || replies.state.sourceAvailability ? []
    : replies.state.result?.expressionPreferences ?? recovered?.reply?.expressionPreferences ?? [];
  function clear() { ++editRevision.current; setText(''); setEditing(null); setConfirmed(false); setAppliesTo('contact'); setReplyMode(null); }
  useEffect(() => {
    clear();
    if (selection.contactId) void operate(() => window.notalone.expressionPreferences.refresh(selection));
  }, [selection.contactId, selection.scopeRevision]);
  useEffect(() => { clear(); }, [view.state.erasureRevision]);
  async function operate(action: () => Promise<void>) {
    const scope = view.latest.current.scopeRevision;
    try { await action(); if (view.active.current && scope === view.latest.current.scopeRevision) view.setError(''); }
    catch { if (view.active.current && scope === view.latest.current.scopeRevision) view.setError('长期偏好操作未确认，请刷新核对后重试。'); }
  }
  async function submit() {
    const edit = editRevision.current;
    const request = { ...selection, text, appliesTo, replyMode, confirmLongTerm: confirmed };
    await operate(async () => {
      if (editing) await window.notalone.expressionPreferences.update({ ...request,
        preferenceId: editing.preferenceId, expectedRevision: editing.revision });
      else await window.notalone.expressionPreferences.save(request);
      const current = await window.notalone.expressionPreferences.getState();
      if (view.active.current && edit === editRevision.current && current.contactId === selection.contactId
        && current.scopeRevision === selection.scopeRevision && current.phase === 'ready' && !current.error) clear();
    });
  }
  function edit(item: ExpressionPreference) {
    ++editRevision.current; setEditing(item); setText(item.text); setAppliesTo(item.scope.contactId ? 'contact' : 'owner');
    setReplyMode(item.scope.replyMode); setConfirmed(false);
  }
  return <details className="expression-preferences" id="assistant-expression-preferences"><summary>长期表达偏好</summary>
    <p>仅在你明确长期保存后供后续适用回复参考；当前明确意图优先。本次指令、选择和复制不会自动保存为长期偏好。</p>
    <ExpressionPreferenceBasis preferences={used} />
    <button disabled={!enabled} onClick={() => void operate(() => window.notalone.expressionPreferences.refresh(selection))}>刷新长期偏好</button>
    <div className="expression-preference-form"><h3>{editing ? "修改长期偏好" : "添加长期偏好"}</h3>
    <label>长期表达要求<textarea aria-label="长期表达要求" maxLength={512} value={text} disabled={!enabled}
      onChange={(event) => { ++editRevision.current; setText(event.target.value); }} /></label>
    <label>适用联系人范围<select aria-label="适用联系人范围" value={appliesTo} disabled={!enabled || editing?.origin.kind === 'message'}
      onChange={(event) => { ++editRevision.current; setAppliesTo(event.target.value as 'owner' | 'contact'); }}>
      <option value="contact">当前联系人</option><option value="owner">本人全局</option></select></label>
    <label>适用输入模式<select aria-label="适用输入模式" value={replyMode ?? ''} disabled={!enabled}
      onChange={(event) => { ++editRevision.current; setReplyMode((event.target.value || null) as ExpressionReplyMode | null); }}>
      <option value="">全部输入模式</option>{Object.entries(modeNames).map(([mode, name]) => <option key={mode} value={mode}>{name}</option>)}</select></label>
    <label><input type="checkbox" checked={confirmed} disabled={!enabled}
      onChange={(event) => { ++editRevision.current; setConfirmed(event.target.checked); }} />明确长期保存</label>
    <button disabled={!enabled || !confirmed || !text.trim()} onClick={() => void submit()}>{editing ? '确认修改长期偏好' : '确认保存长期偏好'}</button>
    {editing && <button disabled={!enabled} onClick={clear}>取消修改</button>}
    </div>
    {view.state.phase === 'loading' && <p role="status">正在读取长期偏好…</p>}
    <h3>已保存的偏好</h3>
    {!view.state.preferences.length && <p className="section-empty">还没有保存长期表达偏好。</p>}
    <ul aria-label="长期表达偏好目录">{view.state.preferences.map((item) => <li key={item.preferenceId}><p>{item.text}</p>
      <small>{item.scope.contactId ? '当前联系人' : '本人全局'} · {item.scope.replyMode ? modeNames[item.scope.replyMode] : '全部输入模式'} · 版本{item.revision}</small>
      <details className="record-metadata"><summary>来源与修改记录</summary><small>
        {item.origin.kind === 'manual' ? '用户手动明确保存' : `用户明确保存，消息来源 ${item.origin.id}`} · 修改于 {item.updatedAt}<br />
        用户操作 {item.confirmedOperationKey}{item.sourceIds.length ? ` · 依赖来源 ${item.sourceIds.join('、')}` : ''}</small></details>
      <button disabled={!enabled} onClick={() => edit(item)} aria-label={`修改长期偏好：${item.text}`}>修改偏好</button>
      <button disabled={!enabled} onClick={() => void operate(() => window.notalone.expressionPreferences.remove({ ...selection,
        preferenceId: item.preferenceId, expectedRevision: item.revision }))} aria-label={`删除长期偏好：${item.text}`}>删除偏好</button></li>)}</ul>
    {(view.state.error || view.error) && <p role="alert">{view.state.error ?? view.error}{!view.state.error && <button className="button" onClick={() => void view.retry()}>重试读取</button>}</p>}
  </details>;
}
