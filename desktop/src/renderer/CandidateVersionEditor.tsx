import { useEffect, useRef, useState } from 'react';
import type { AssistantCandidateMessage, AssistantCandidateVersionView } from '../shared/assistant-candidate-versions';
import type { ReplySessionView } from './RewritePanel';
import { CandidateMessageGroup } from './CandidateMessageGroup';

// 编辑稿只在当前组件内保留；保存和采用版本分别调用既有公开接口。
export function CandidateVersionEditor({ replies, view, candidateId, replyRequestId, number, restored, noteCopy }: {
  replies: ReplySessionView;
  view: AssistantCandidateVersionView | undefined;
  candidateId: string;
  replyRequestId: string;
  number: number;
  restored: boolean;
  noteCopy: (text: string) => void;
}) {
  const { state } = replies;
  const history = view?.history;
  const version = history?.versions.find((item) => item.versionId === view?.displayVersionId);
  const [draft, setDraft] = useState<{ versionId: string; messages: AssistantCandidateMessage[]; requirements: string } | null>(null);
  const messages = draft?.messages ?? [];
  const requirements = draft?.requirements ?? '';
  const [error, setError] = useState('');
  const editRevision = useRef(0);
  const saveKey = useRef<{ revision: number; key: string } | null>(null);
  const selectionKey = useRef<{ versionId: string; key: string } | null>(null);
  useEffect(() => {
    if (!version) return;
    setDraft((previous) => previous?.versionId === version.versionId ? previous
      : { versionId: version.versionId, messages: version.messages.map((message) => ({ ...message })), requirements: version.requirements ?? '' });
  }, [version]);
  const dirty = messages.some((message, index) => message.text !== version?.messages[index].text)
    || requirements !== (version?.requirements ?? '');
  const selected = state.explicitCandidateSelection;
  const chosen = selected?.phase === 'ready' && selected.selection?.sessionId === history?.sessionId
    && selected.selection?.candidateId === candidateId && selected.selection?.versionId === version?.versionId;
  const disabled = state.phase === 'waiting' || state.sourceAvailability !== undefined
    || state.sessionDeletion === 'deleting' || state.sessionDeletion === 'failed'
    || state.candidateVersions?.phase !== 'ready' || view?.phase !== 'ready' || state.savedSession?.phase !== 'ready'
    || selected?.phase === 'saving' || selected?.phase === 'loading';
  const identity = `${state.contactId}:${state.scopeRevision}:${history?.sessionId}:${candidateId}:${version?.versionId}`;
  const scope = { contactId: state.contactId!, scopeRevision: state.scopeRevision,
    sessionId: state.savedSession?.sessionId ?? '', candidateId };
  function beginEdit() {
    if (!version || draft?.versionId !== version.versionId) return;
    void replies.beginCandidateVersionEdit({ ...scope, versionId: version.versionId })
      .catch(() => setError('本组编辑身份尚未确认，请保留文字并重新读取。'));
  }
  function editMessage(messageId: string, text: string) {
    beginEdit();
    editRevision.current++;
    const next = messages.map((message) => message.messageId === messageId ? { ...message, text } : message);
    setDraft((previous) => previous ? { ...previous, messages: next } : null); setError('');
    if (state.result?.replyRequestId === replyRequestId) void replies.editCandidate(candidateId,
      next.map((message) => message.text).join('\n\n'));
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
  function retryRead() { void replies.readCandidateVersions(scope).catch(() => setError('本组版本尚未核对，请重试。')); }
  if (!history || !version || draft?.versionId !== version.versionId) return <>
    <p role="status">{view?.phase === 'failed' ? '本组版本暂不可用，编辑和复制尚未开放。' : '正在读取本组版本…'}</p>
    {view?.phase === 'failed' && <button onClick={retryRead}>重新读取本组版本</button>}
    {error && <p role="alert">{error}</p>}
  </>;
  return <>
    <CandidateMessageGroup identity={identity} number={number} messages={messages} requirements={requirements}
      restored={restored} disabled={disabled} dirty={dirty} canCopy={Boolean(chosen)}
      edit={editMessage} editRequirements={(text) => { beginEdit(); editRevision.current++; setDraft({ ...draft, requirements: text }); setError(''); }}
      save={save} noteTextCopy={noteCopy}
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
      </>} />
    {view?.phase === 'failed' && <button onClick={retryRead}>重新读取本组版本</button>}
    {error && <p role="alert">{error}</p>}
  </>;
}
