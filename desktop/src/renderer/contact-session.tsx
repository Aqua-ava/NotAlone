import { ContactPicker } from './ContactPicker';
export { ContactPicker } from './ContactPicker';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ForegroundState } from '../shared/foreground-bridge';
import type { ContactSessionState } from '../shared/contact-session-bridge';
import { createContactSessionReceiver } from '../shared/contact-session-bridge';
import { useRevisionedSession } from './use-revisioned-session';

const initial: ContactSessionState = {
  revision: -1, scopeRevision: 0, directoryPhase: 'unavailable',
  contacts: [], selectedContactId: null, draft: '',
};

export function useContactSession() {
  const reduce = useMemo(createContactSessionReceiver, []);
  const { state, error: sessionError, setError, latest, active, receive, retry } = useRevisionedSession(initial, window.notalone.contacts, true, reduce);
  const latestForegroundRevision = useRef(-1);
  const [confirmationError, setConfirmationError] = useState<{ message: string; foregroundRevision: number; scopeRevision: number } | null>(null);
  // 确认错误只属于发起时的观察，后续识别不能继续显示旧错误或接收迟到失败。
  useEffect(() => window.notalone.foreground.onStateChanged(next => {
    if (next.foregroundRevision <= latestForegroundRevision.current) return;
    latestForegroundRevision.current = next.foregroundRevision;
    setConfirmationError(previous => previous && previous.foregroundRevision < next.foregroundRevision ? null : previous);
  }), []);
  const error = confirmationError?.scopeRevision === state.scopeRevision ? confirmationError.message : sessionError;

  async function selectContact(contactId: string) {
    const scopeRevision = latest.current.scopeRevision;
    try {
      receive(await window.notalone.contacts.selectContact({ contactId, scopeRevision }));
      if (active.current) { setError(''); setConfirmationError(null); }
    } catch {
      if (active.current && scopeRevision === latest.current.scopeRevision) setError('联系人选择已失效，请刷新后重新确认。');
    }
  }

  async function confirmContact(contactId: string, foregroundRevision: number) {
    const contactScopeRevision = latest.current.scopeRevision;
    latestForegroundRevision.current = Math.max(latestForegroundRevision.current, foregroundRevision);
    try {
      receive(await window.notalone.foreground.confirm({ contactId, contactScopeRevision, foregroundRevision }));
      if (active.current) { setError(''); setConfirmationError(null); }
    } catch (error) {
      if (active.current && latestForegroundRevision.current === foregroundRevision && latest.current.scopeRevision === contactScopeRevision) {
        const message = error instanceof Error && error.message.includes('foreground_binding_required')
        ? '当前联系人没有与本次微信观察一致的有效绑定，请到同步设置重新确认会话，或在上方选择本次联系人。'
        : error instanceof Error && error.message.includes('foreground_confirmation_unavailable')
        ? '尚未取得可确认的微信会话，请切回目标私聊等待自动识别，或在上方选择本次联系人。'
        : error instanceof Error && error.message.includes('foreground_confirmation_stale')
        ? '微信识别结果已过期，请切回目标私聊等待自动重新识别，再选择联系人。'
        : '联系人确认已失效，请重新选择本次联系人。';
        setConfirmationError({ message, foregroundRevision, scopeRevision: contactScopeRevision });
      }
    }
  }

  async function setDraft(text: string) {
    const { selectedContactId, scopeRevision } = latest.current;
    if (!selectedContactId) return;
    try {
      receive(await window.notalone.contacts.setDraft({ contactId: selectedContactId, scopeRevision, text }));
    } catch {
      if (active.current && scopeRevision === latest.current.scopeRevision) setError('草稿暂时无法更新，请重新确认联系人。');
    }
  }

  async function refreshContacts() {
    try { await window.notalone.contacts.refreshContacts(); }
    catch { if (active.current) setError('联系人目录暂时无法刷新，请重试。'); }
  }

  async function confirmManualContact(contactId: string) {
    try {
      receive(await window.notalone.contacts.confirmManualContact({ contactId, scopeRevision: latest.current.scopeRevision }));
      if (active.current) { setError(''); setConfirmationError(null); }
      return true;
    } catch { if (active.current) setError('本次联系人未确认，请刷新目录后重新选择。'); return false; }
  }

  return { state, error, retryRead: retry, selectContact, confirmContact, confirmManualContact, setDraft, refreshContacts };
}

export type ContactSessionView = ReturnType<typeof useContactSession>;

export function HelperContactPicker({ session, foreground }: { session: ContactSessionView; foreground?: ForegroundState }) {
  // 用户明确选择只确认本次表达对象，不依赖前台回执，也不恢复微信读取授权。
  return <ContactPicker session={session} disabled={!foreground} onSelect={session.confirmManualContact} />;
}

export function HelperDraft({ session, currentChat = false, workspace = false, disabled = false, restoreRevision, placeholder }: { session: ContactSessionView; currentChat?: boolean; workspace?: boolean; disabled?: boolean; restoreRevision?: number; placeholder?: string }) {
  const [text, setText] = useState(session.state.draft);
  const pendingDraft = useRef<string | null>(null);
  // 切换范围与明确删除必须清除输入；讨论恢复不得用尚未回显的旧值覆盖新按键。
  useEffect(() => {
    pendingDraft.current = null;
    setText(session.state.draft);
  }, [session.state.selectedContactId, session.state.scopeRevision, session.state.draftClearRevision]);
  useEffect(() => {
    if (pendingDraft.current === null) setText(session.state.draft);
  }, [restoreRevision]);
  useEffect(() => {
    if (pendingDraft.current === session.state.draft) pendingDraft.current = null;
  }, [session.state.draft]);
  return <textarea aria-label={workspace ? '有什么想说的' : currentChat ? '当前聊天文字' : '草稿'} rows={3} maxLength={65_536}
    value={text} disabled={disabled || !session.state.selectedContactId}
    placeholder={placeholder ?? (workspace ? '写下你的想法或草稿，也可以留空，点击「帮我想想」…' : currentChat ? '仅粘贴这位联系人的当前聊天文字，再填写你想表达的方向…' : '先确认联系人，再写下你的意思…')}
    onChange={(event) => { pendingDraft.current = event.target.value; setText(event.target.value); void session.setDraft(event.target.value); }} />;
}
