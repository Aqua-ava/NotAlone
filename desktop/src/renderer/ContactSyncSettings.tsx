import { useEffect, useState } from 'react';
import type { ContactSessionView } from './contact-session';
import type { ManagerPage } from './pages';
import type { SyncControlState } from '../shared/sync-control-bridge';
import { BindingConsentPage, BindingFeedback, ContactSyncDetails } from './BindingConsentPage';
import { useBindingConsent } from './use-binding-consent';
import { useRevisionedSession } from './use-revisioned-session';

const initialSync: SyncControlState = { revision: -1, scopeRevision: 0, phase: 'offline', report: null, busy: null, errorCode: null };

export function ContactSyncSettings({ session, navigate }: {
  session: ContactSessionView; navigate: (page: ManagerPage) => void;
}) {
  const consent = useBindingConsent(session);
  const { state: sync } = useRevisionedSession(initialSync, window.notalone.syncControl);
  const allPrivate = consent.state.selectionOnly !== true && sync.report?.syncScope === 'all_private';
  const [selecting, setSelecting] = useState(false);
  const selected = session.state.contacts.find(contact => contact.contactId === session.state.selectedContactId);
  useEffect(() => { void consent.refreshSaved(); }, []);
  function closeSelection() {
    setSelecting(false); consent.setSelection({});
    void window.notalone.syncControl.refresh().catch(() => {});
  }
  return <section className="bindings-explanation" aria-label="单个联系人同步">
    <div className="bindings-toolbar"><h2>当前联系人同步</h2>
      <button className="button" disabled={!!consent.state.busy || consent.state.phase === 'loading'}
        onClick={() => void consent.refreshSaved()}>刷新联系人同步状态</button></div>
    {selected ? <>
      <p><b>{selected.displayName}</b></p>
      {selecting ? <BindingConsentPage contacts={session} consent={consent} navigate={navigate}
        targetContactId={selected.contactId} allPrivate={allPrivate} onClose={closeSelection} returnLabel="返回同步设置" />
        : <ContactSyncDetails contactId={selected.contactId} consent={consent} allPrivate={allPrivate}
          onConnect={() => { consent.setSelection({}); setSelecting(true); }} />}
    </> : <p>在顶部选择联系人后，可在这里开启或停止这位联系人的同步。</p>}
    <BindingFeedback consent={consent} />
  </section>;
}
