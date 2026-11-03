import { useEffect, useRef, useState } from 'react';
import type { ContactSessionView } from './contact-session';
import type { ManagerPage } from './pages';
import type { SyncControlState } from '../shared/sync-control-bridge';
import { BindingConsentPage, BindingFeedback, ContactSyncDetails } from './BindingConsentPage';
import { useBindingConsent } from './use-binding-consent';
import { useRevisionedSession } from './use-revisioned-session';
import { useVisibleRefresh } from './use-visible-refresh';

const initialSync: SyncControlState = { revision: -1, scopeRevision: 0, phase: 'offline', report: null, busy: null, errorCode: null };

export function ContactSyncSettings({ session, navigate }: {
  session: ContactSessionView; navigate: (page: ManagerPage) => void;
}) {
  const consent = useBindingConsent(session);
  const { state: sync } = useRevisionedSession(initialSync, window.notalone.syncControl);
  const allPrivate = consent.state.selectionOnly !== true && sync.report?.syncScope === 'all_private';
  const [selecting, setSelecting] = useState(false);
  const [opening, setOpening] = useState<{ contactId: string; scopeRevision: number; consentScopeRevision: number } | null>(null);
  const [savedReadPending, setSavedReadPending] = useState(false);
  const savedRead = useRef<Promise<void> | null>(null), active = useRef(true);
  const openingPending = useRef(false);
  const selected = session.state.contacts.find(contact => contact.contactId === session.state.selectedContactId);
  async function refreshSaved() {
    if (savedRead.current) return savedRead.current;
    setSavedReadPending(true);
    const operation = consent.refreshSaved();
    savedRead.current = operation;
    try {
      await operation;
      // 请求返回后再接收主进程快照，确保旧回包已在选择页挂载前处理。
      if (active.current) await consent.retryRead();
    } finally {
      if (savedRead.current === operation) savedRead.current = null;
      if (active.current) setSavedReadPending(false);
    }
  }
  useEffect(() => {
    active.current = true; void refreshSaved();
    return () => { active.current = false; openingPending.current = false; };
  }, []);
  const readFailed = consent.state.phase === 'failed' || consent.state.phase === 'unavailable' || !!consent.state.errorCode || !!consent.error;
  // 选择和撤销确认期间不刷新名单或扰动用户正在核对的范围。
  useVisibleRefresh(() => refreshSaved(), consent.state.phase === 'ready' && !consent.state.busy
    && !selecting && !opening && !savedReadPending && !consent.revocation && !readFailed && !consent.readError);
  useEffect(() => {
    if (!opening) return;
    const sameScope = opening.contactId === session.state.selectedContactId
      && opening.scopeRevision === session.state.scopeRevision && opening.consentScopeRevision === consent.state.scopeRevision;
    if (sameScope && savedReadPending) return;
    if (sameScope && consent.state.phase === 'ready' && !consent.state.busy && !readFailed && !consent.readError) {
      consent.setSelection({}); setSelecting(true);
    }
    openingPending.current = false; setOpening(null);
  }, [opening, savedReadPending, session.state.selectedContactId, session.state.scopeRevision, consent.state.scopeRevision, consent.state.phase, consent.state.busy, readFailed, consent.readError]);
  function closeSelection() {
    setSelecting(false); consent.setSelection({});
    void window.notalone.syncControl.refresh().catch(() => {});
  }
  return <section className="bindings-explanation" aria-label="单个联系人同步">
    <div className="bindings-toolbar"><h2>当前联系人同步</h2>
      {readFailed && <button className="button" disabled={!!consent.state.busy || consent.state.phase === 'loading'}
        onClick={() => void refreshSaved()}>重试读取联系人同步状态</button>}</div>
    {selected ? <>
      <p><b>{selected.displayName}</b></p>
      {opening ? <p role="status">正在确认联系人同步状态…</p> : selecting ? <BindingConsentPage contacts={session} consent={consent} navigate={navigate}
        targetContactId={selected.contactId} allPrivate={allPrivate} onClose={closeSelection} returnLabel="返回联系人同步" />
        : <ContactSyncDetails contactId={selected.contactId} consent={consent} allPrivate={allPrivate}
          onConnect={() => {
            if (openingPending.current) return;
            openingPending.current = true;
            setOpening({ contactId: selected.contactId, scopeRevision: session.state.scopeRevision, consentScopeRevision: consent.state.scopeRevision });
          }} />}
    </> : <p>在顶部选择联系人后，可在这里开启或停止这位联系人的同步。</p>}
    <BindingFeedback consent={consent} />
  </section>;
}
