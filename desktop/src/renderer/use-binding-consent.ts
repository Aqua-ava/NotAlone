import { useCallback, useEffect, useRef, useState } from 'react';
import { readInitialState } from './initial-read';
import type { BindingConsentState, BindingSummary } from '../shared/binding-consent-bridge';
import type { ContactSessionView } from './contact-session';

const initial: BindingConsentState = { revision: -1, scopeRevision: 0, phase: 'offline',
  sessions: [], bindings: [], syncEnabled: null, sessionIssue: null, busy: null, errorCode: null, notice: null };
type Selection = { displayName: string; target: string };

export function useBindingConsent(contacts: ContactSessionView) {
  const [state, setState] = useState(initial);
  const latest = useRef(initial);
  const [selection, setSelection] = useState<Record<string, Selection>>({});
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [revocation, setRevocation] = useState<BindingSummary | null>(null);
  const active = useRef(true);
  const reading = useRef(false);
  const receive = useCallback((next: BindingConsentState) => {
    if (!active.current || next.revision < latest.current.revision) return;
    if (next.scopeRevision !== latest.current.scopeRevision) { setSelection({}); setRevocation(null); setError(''); }
    latest.current = next; setState(next);
  }, []);
  const retryRead = useCallback(() => readInitialState({
    read: () => window.notalone.bindings.getState(), receive, reportError: setReadError,
    isActive: () => active.current, busy: reading,
  }), [receive]);
  useEffect(() => {
    active.current = true;
    const unsubscribe = window.notalone.bindings.onStateChanged(receive);
    void retryRead();
    return () => { active.current = false; unsubscribe(); };
  }, [receive, retryRead]);
  useEffect(() => {
    if (state.phase !== 'ready') return;
    setSelection((previous) => Object.fromEntries(Object.entries(previous).filter(([locator, item]) =>
      state.sessions.some((session) => session.locator === locator && session.displayName === item.displayName && session.boundContactId === null)
      && !state.bindings.some((binding) => binding.locator === locator)
      && (!item.target || item.target === 'new' || contacts.state.contacts.some((contact) => contact.contactId === item.target)))));
  }, [state, contacts.state.contacts]);
  async function refresh() {
    try { await window.notalone.bindings.refresh(); setError(''); }
    catch { setError('会话与授权暂时无法刷新，请重试。'); }
  }
  async function confirm() {
    const scopeRevision = state.scopeRevision;
    try {
      await window.notalone.bindings.confirmSelections({ scopeRevision, selections: Object.entries(selection).map(([locator, item]) =>
        ({ locator, displayName: item.displayName, contactId: item.target === 'new' ? null : item.target })) });
      if (scopeRevision === latest.current.scopeRevision) setError('');
    } catch { if (scopeRevision === latest.current.scopeRevision) setError('本次授权选择已失效，请刷新后重新确认。'); }
  }
  async function revoke() {
    if (!revocation) return;
    const scopeRevision = state.scopeRevision;
    try { await window.notalone.bindings.revokeBinding({ scopeRevision, contactId: revocation.contactId, bindingId: revocation.bindingId }); }
    catch { if (scopeRevision === latest.current.scopeRevision) setError('撤销结果尚未确认，请刷新授权范围后重试。'); }
  }
  async function refreshSaved() {
    try { await window.notalone.bindings.refreshSaved(); setError(''); }
    catch { setError('联系人同步状态暂时无法刷新，请重试。'); }
  }
  return { state, selection, setSelection, error, readError, retryRead, revocation, setRevocation, refresh, refreshSaved, confirm, revoke };
}
export type BindingConsentView = ReturnType<typeof useBindingConsent>;
