import { useEffect, useRef, useState } from 'react';
import type { ReplySessionState } from '../shared/reply-bridge';
import { Icon } from './icons';

export function CandidateCopyControls({ state }: { state: ReplySessionState }) {
  const candidate = state.result?.candidates.find((item) => item.original.candidateId === state.selectedCandidateId);
  const identity = JSON.stringify([state.scopeRevision, state.contactId, state.result?.replyRequestId,
    candidate?.original.candidateId, candidate?.editedText]);
  const latest = useRef(identity);
  latest.current = identity;
  const active = useRef(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setNotice(''); setError(''); }, [identity]);
  const enabled = Boolean(state.contactId && state.result && candidate?.editedText.trim() && state.phase !== 'waiting' && !busy);
  async function copy(hideAfterCopy: boolean) {
    if (!enabled || !state.result || !candidate || !state.contactId) return;
    const operation = identity;
    setBusy(true); setNotice(''); setError('');
    try {
      await window.notalone.candidateCopy.copy({ contactId: state.contactId, scopeRevision: state.scopeRevision,
        replyRequestId: state.result.replyRequestId, candidateId: candidate.original.candidateId, hideAfterCopy });
      if (active.current && latest.current === operation) setNotice('已复制当前编辑文本，请自行粘贴并发送。');
    } catch {
      if (active.current && latest.current === operation) setError('复制未确认，编辑文本仍保留，请重试。');
    } finally { if (active.current) setBusy(false); }
  }
  return <>
    <button disabled={!enabled} onClick={() => void copy(false)}><Icon name="copy" size={13} />复制</button>
    <button className="copy-hide" disabled={!enabled} onClick={() => void copy(true)}>复制并收起</button>
    {busy && <span role="status">正在复制…</span>}
    {notice && <span role="status">{notice}</span>}
    {error && <span role="alert">{error}</span>}
  </>;
}
