import { useEffect, useRef, useState } from 'react';
import type { AssistantCandidateMessage, AssistantCandidateVersionView } from '../shared/assistant-candidate-versions';
import type { ReplySessionView } from './RewritePanel';
import { CandidateMessageGroup } from './CandidateMessageGroup';
import { ReplyBasisChangeNotice } from './ReplyBasisChangeNotice';

// 未保存编辑同步到主进程会话内存；保存和采用版本仍由用户明确操作。
export function CandidateVersionEditor({ replies, view, candidateId, replyRequestId, number, restored, noteCopy, onDirtyChange }: {
  replies: ReplySessionView;
  view: AssistantCandidateVersionView | undefined;
  candidateId: string;
  replyRequestId: string;
  number: number;
  restored: boolean;
  noteCopy: (text: string) => void;
  onDirtyChange?: (candidateId: string, dirty: boolean) => void;
}) {
  const { state } = replies;
  const history = view?.history;
  const version = history?.versions.find((item) => item.versionId === view?.displayVersionId);
  const retained = state.candidateDrafts?.find((item) => item.candidateId === candidateId && item.versionId === version?.versionId);
  const [draft, setDraft] = useState<{ versionId: string; messages: AssistantCandidateMessage[]; requirements: string } | null>(() => retained ?? (version ? {
    versionId: version.versionId, messages: version.messages.map((message) => ({ ...message })), requirements: version.requirements ?? '' } : null));
  const messages = draft?.messages ?? [];
  const requirements = draft?.requirements ?? '';
  const [error, setError] = useState('');
  const [sampleSaving, setSampleSaving] = useState(false);
  const sampleActive = useRef(true);
  useEffect(() => { sampleActive.current = true; return () => { sampleActive.current = false; }; }, []);
  const editRevision = useRef(0);
  const saveKey = useRef<{ revision: number; key: string } | null>(null);
  const selectionKey = useRef<{ versionId: string; key: string } | null>(null);
  useEffect(() => {
    if (!version) return;
    if (draft?.versionId !== version.versionId) editRevision.current = 0;
    setDraft((previous) => previous?.versionId === version.versionId && editRevision.current > 0 ? previous
      : retained ?? { versionId: version.versionId, messages: version.messages.map((message) => ({ ...message })), requirements: version.requirements ?? '' });
  }, [version, retained]);
  const dirty = messages.some((message, index) => message.text !== version?.messages[index].text)
    || requirements !== (version?.requirements ?? '');
  useEffect(() => { onDirtyChange?.(candidateId, Boolean(draft && dirty)); }, [candidateId, draft?.versionId, dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(candidateId, false); }, [candidateId, onDirtyChange]);
  const selected = state.explicitCandidateSelection;
  const chosen = selected?.phase === 'ready' && selected.selection?.sessionId === history?.sessionId
    && selected.selection?.candidateId === candidateId && selected.selection?.versionId === version?.versionId;
  const disabled = state.phase === 'waiting' || state.sourceAvailability !== undefined
    || state.sessionDeletion === 'deleting' || state.sessionDeletion === 'failed'
    || state.candidateVersions?.phase !== 'ready' || view?.phase !== 'ready' || state.savedSession?.phase !== 'ready'
    || selected?.phase === 'saving' || selected?.phase === 'loading';
  const identity = `${state.contactId}:${state.scopeRevision}:${history?.sessionId}:${candidateId}:${version?.versionId}`;
  const sampleIdentity = useRef(identity);
  sampleIdentity.current = identity;
  const scope = { contactId: state.contactId!, scopeRevision: state.scopeRevision,
    sessionId: state.savedSession?.sessionId ?? '', candidateId };
  function retainDraft(messages: AssistantCandidateMessage[], requirements: string) {
    if (!version || draft?.versionId !== version.versionId) return;
    const operation = identity, revision = editRevision.current;
    void replies.updateCandidateVersionDraft({ ...scope, versionId: version.versionId, messages, requirements })
      .catch(() => {
        if (sampleActive.current && sampleIdentity.current === operation && editRevision.current === revision) {
          setError('本组编辑暂未保留，请勿切换并重新读取版本。');
        }
      });
  }
  function editMessage(messageId: string, text: string) {
    if (!version || draft?.versionId !== version.versionId) return;
    editRevision.current++;
    const next = messages.map((message) => message.messageId === messageId ? { ...message, text } : message);
    setDraft((previous) => previous ? { ...previous, messages: next } : null); setError('');
    retainDraft(next, requirements);
  }
  async function save() {
    if (!version || draft?.versionId !== version.versionId) throw new Error('本组版本尚未核对。');
    if (!saveKey.current || saveKey.current.revision !== editRevision.current) {
      saveKey.current = { revision: editRevision.current, key: crypto.randomUUID() };
    }
    await replies.saveCandidateVersion({ ...scope, editKey: saveKey.current.key,
      parentVersionId: version.versionId, messages, requirements: requirements.trim() || null });
  }
  async function select() {
    if (!version || draft?.versionId !== version.versionId) return;
    if (selectionKey.current?.versionId !== version.versionId) {
      selectionKey.current = { versionId: version.versionId, key: crypto.randomUUID() };
    }
    try {
      await replies.selectCandidateVersion({ ...scope, versionId: version.versionId, selectionKey: selectionKey.current.key });
      selectionKey.current = null; setError('');
    } catch { setError('当前版本尚未确认选择，请重试。'); }
  }
  async function saveSample() {
    if (disabled || sampleSaving || !version || draft?.versionId !== version.versionId) return;
    const operation = identity;
    setSampleSaving(true); setError('');
    try {
      await window.notalone.styleSamples.saveCandidate({ ...scope, replyRequestId,
        versionId: version.versionId, text: messages.map((message) => message.text).join('\n\n') });
      const saved = await window.notalone.styleSamples.getState();
      if (sampleActive.current && sampleIdentity.current === operation
        && (saved.phase !== 'ready' || saved.error || saved.contactId !== scope.contactId || saved.scopeRevision !== scope.scopeRevision)) {
        setError('保存结果尚未确认，请刷新表达样本后核对，编辑文字仍保留。');
      }
    } catch {
      if (sampleActive.current && sampleIdentity.current === operation) setError('样本尚未保存，请核对当前版本后重试。');
    } finally { if (sampleActive.current) setSampleSaving(false); }
  }
  function retryRead() { void replies.readCandidateVersions(scope).catch(() => setError('本组版本尚未核对，请重试。')); }
  if (!history || !version || draft?.versionId !== version.versionId) return <>
    <p role="status">{view?.phase === 'failed' ? '本组版本暂不可用，编辑和复制尚未开放。' : '正在读取本组版本…'}</p>
    {view?.phase === 'failed' && <button onClick={retryRead}>重新读取本组版本</button>}
    {error && <p role="alert">{error}</p>}
  </>;
  return <>
    <ReplyBasisChangeNotice changes={history?.basisChanges} />
    <CandidateMessageGroup identity={identity} number={number} messages={messages} requirements={requirements}
      restored={restored} disabled={disabled || sampleSaving} dirty={dirty} canCopy={Boolean(chosen)}
      edit={editMessage} editRequirements={(text) => { editRevision.current++; setDraft({ ...draft, requirements: text }); setError(''); retainDraft(messages, text); }}
      save={save} noteTextCopy={noteCopy}
      validatePaste={(text) => window.notalone.styleSamples.validateCandidatePaste({ ...scope, replyRequestId,
        versionId: version.versionId, text })}
      copy={(messageId) => window.notalone.candidateCopy.copy({ contactId: scope.contactId, scopeRevision: scope.scopeRevision,
        replyRequestId, candidateId, versionId: version.versionId, messageId, hideAfterCopy: false })}
      controls={<>
        <label>本组版本<select aria-label={`说法${number}版本`} value={version.versionId} disabled={dirty || disabled}
          onChange={(event) => { void replies.showCandidateVersion({ ...scope, versionId: event.target.value })
            .catch(() => setError('版本尚未切换，请重试。')); }}>
          {history.versions.map((item) => <option key={item.versionId} value={item.versionId}>
            {item.versionNumber === 0 ? '原始版本' : `修改版本 ${item.versionNumber}`}
          </option>)}
        </select></label>
        <label><input type="radio" name="candidate-version" aria-label={`选择说法${number}当前版本`}
          checked={Boolean(chosen)} disabled={dirty || disabled} onChange={() => void select()} />选择这组当前版本</label>
        <button disabled={sampleSaving || messages.some((message) => !message.text.trim())
          || messages.map((message) => message.text).join('\n\n').length > 4096}
          onClick={() => void saveSample()}>主动保存说法{number}为样本</button>
      </>} />
    {view?.phase === 'failed' && <button onClick={retryRead}>重新读取本组版本</button>}
    {error && <p role="alert">{error}</p>}
  </>;
}
