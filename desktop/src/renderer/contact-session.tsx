import { useEffect, useState } from 'react';
import type { ForegroundState } from '../shared/foreground-bridge';
import type { ContactSessionState } from '../shared/contact-session-bridge';
import { useRevisionedSession } from './use-revisioned-session';

const initial: ContactSessionState = {
  revision: -1, scopeRevision: 0, directoryPhase: 'unavailable',
  contacts: [], selectedContactId: null, draft: '',
};

export function useContactSession() {
  const { state, error, setError, latest, active, receive } = useRevisionedSession(initial, window.notalone.contacts);

  async function selectContact(contactId: string) {
    const scopeRevision = latest.current.scopeRevision;
    try {
      receive(await window.notalone.contacts.selectContact({ contactId, scopeRevision }));
      if (active.current) setError('');
    } catch {
      if (active.current && scopeRevision === latest.current.scopeRevision) setError('联系人选择已失效，请刷新后重新确认。');
    }
  }

  async function confirmContact(contactId: string, foregroundRevision: number) {
    const contactScopeRevision = latest.current.scopeRevision;
    try {
      receive(await window.notalone.foreground.confirm({ contactId, contactScopeRevision, foregroundRevision }));
      if (active.current) setError('');
    } catch {
      if (active.current) setError('联系人确认已失效，请重新选择本次联系人。');
    }
  }

  async function resumeForeground(foregroundRevision: number) {
    const { selectedContactId, scopeRevision } = latest.current;
    if (!selectedContactId) return;
    try {
      await window.notalone.foreground.resume({ contactId: selectedContactId,
        contactScopeRevision: scopeRevision, foregroundRevision });
      if (active.current) setError('');
    } catch {
      if (active.current) setError('微信会话识别暂时无法恢复，请重新选择本次联系人。');
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

  async function createContact(displayName: string): Promise<boolean> {
    try {
      receive(await window.notalone.contacts.createContact({ displayName, scopeRevision: latest.current.scopeRevision }));
      if (active.current) setError('');
      return true;
    } catch { if (active.current) setError('联系人未能确认创建，请刷新目录后重试。'); return false; }
  }
  async function confirmManualContact(contactId: string) {
    try {
      receive(await window.notalone.contacts.confirmManualContact({ contactId, scopeRevision: latest.current.scopeRevision }));
      if (active.current) setError('');
      return true;
    } catch { if (active.current) setError('本次联系人未确认，请刷新目录后重新选择。'); return false; }
  }

  return { state, error, selectContact, confirmContact, confirmManualContact, resumeForeground, createContact, setDraft, refreshContacts };
}

export type ContactSessionView = ReturnType<typeof useContactSession>;

export function CurrentContactLabel({ state }: { state: ContactSessionState }) {
  const selected = state.contacts.find((contact) => contact.contactId === state.selectedContactId);
  return <span className="current-contact">本次联系人：{selected?.displayName ?? '未确认'}</span>;
}

export function HelperContactPicker({ session, foreground, manualRelease = false, manualInput = false }: { session: ContactSessionView; foreground?: ForegroundState; manualRelease?: boolean; manualInput?: boolean }) {
  const manual = manualRelease || manualInput || foreground?.manualInput;
  return <select className="contact-picker" aria-label="本次联系人"
    value={session.state.selectedContactId ?? ''} disabled={session.state.contacts.length === 0 || !foreground || !manual && foreground.unsupportedConversation}
    onChange={(event) => foreground && void (manual ? session.confirmManualContact(event.target.value) : session.confirmContact(event.target.value, foreground.foregroundRevision))}>
    <option value="" disabled>联系人未确认</option>
    {session.state.contacts.map((contact) => <option key={contact.contactId} value={contact.contactId}>{contact.displayName}</option>)}
  </select>;
}

export function HelperDraft({ session, currentChat = false, workspace = false, disabled = false }: { session: ContactSessionView; currentChat?: boolean; workspace?: boolean; disabled?: boolean }) {
  const [text, setText] = useState(session.state.draft);
  // 切换范围或收到删除完成通知时清除本地输入；普通在途回显不覆盖新按键。
  useEffect(() => { setText(session.state.draft); }, [session.state.scopeRevision, session.state.draftClearRevision]);
  return <textarea aria-label={workspace ? '有什么想说的' : currentChat ? '当前聊天文字' : '草稿'} rows={3} maxLength={65_536}
    value={text} disabled={disabled || !session.state.selectedContactId}
    placeholder={workspace ? '写下你的想法或草稿，也可以留空，点击「帮我想想」…' : currentChat ? '仅粘贴这位联系人的当前聊天文字，再填写你想表达的方向…' : '先确认联系人，再写下你的意思…'}
    onChange={(event) => { setText(event.target.value); void session.setDraft(event.target.value); }} />;
}
