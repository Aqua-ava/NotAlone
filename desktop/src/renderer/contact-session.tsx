import { useEffect, useState } from 'react';
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

  return { state, error, selectContact, setDraft, refreshContacts };
}

export type ContactSessionView = ReturnType<typeof useContactSession>;

export function CurrentContactLabel({ state }: { state: ContactSessionState }) {
  const selected = state.contacts.find((contact) => contact.contactId === state.selectedContactId);
  return <span className="current-contact">本次联系人：{selected?.displayName ?? '未确认'}</span>;
}

export function HelperContactPicker({ session }: { session: ContactSessionView }) {
  return <select className="contact-picker" aria-label="本次联系人"
    value={session.state.selectedContactId ?? ''} disabled={session.state.contacts.length === 0}
    onChange={(event) => void session.selectContact(event.target.value)}>
    <option value="" disabled>联系人未确认</option>
    {session.state.contacts.map((contact) => <option key={contact.contactId} value={contact.contactId}>{contact.displayName}</option>)}
  </select>;
}

export function HelperDraft({ session }: { session: ContactSessionView }) {
  const [text, setText] = useState(session.state.draft);
  // 只有小窗编辑草稿；会话切换时丢弃本地输入，同会话的在途回显不覆盖新按键。
  useEffect(() => { setText(session.state.draft); }, [session.state.scopeRevision]);
  return <textarea aria-label="草稿" rows={3} maxLength={65_536}
    value={text} disabled={!session.state.selectedContactId}
    placeholder="先确认联系人，再写下你的意思…"
    onChange={(event) => { setText(event.target.value); void session.setDraft(event.target.value); }} />;
}
