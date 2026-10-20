import { useEffect, useRef, useState } from 'react';
import type { AssistantCandidateMessage, AssistantCandidateVersionView } from '../shared/assistant-candidate-versions';
import type { ReplySessionView } from './RewritePanel';
import { CandidateMessageGroup } from './CandidateMessageGroup';
import { ReplyBasisChangeNotice } from './ReplyBasisChangeNotice';

// 编辑同步到主进程会话内存；结束编辑后自动保存版本，复制使用当前展示的已保存版本。
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
  const [carrying, setCarrying] = useState(false);
  const [failedSaveIdentity, setFailedSaveIdentity] = useState<string | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const editRevision = useRef(0);
  const saveKey = useRef<{ revision: number; key: string } | null>(null);
  useEffect(() => {
    if (!version) return;
    if (draft?.versionId !== version.versionId) {
      editRevision.current = 0;
      saveKey.current = null;
      setFailedSaveIdentity(null);
    }
    setDraft((previous) => previous?.versionId === version.versionId && editRevision.current > 0 ? previous
      : retained ?? { versionId: version.versionId, messages: version.messages.map((message) => ({ ...message })), requirements: version.requirements ?? '' });
  }, [version, retained]);
  const dirty = messages.some((message, index) => message.text !== version?.messages[index].text)
    || requirements !== (version?.requirements ?? '');
  useEffect(() => { onDirtyChange?.(candidateId, Boolean(draft && dirty)); }, [candidateId, draft?.versionId, dirty, onDirtyChange]);
  useEffect(() => () => { onDirtyChange?.(candidateId, false); }, [candidateId, onDirtyChange]);
  const disabled = state.phase === 'waiting' || state.sourceAvailability !== undefined
    || state.sessionCatalog?.phase === 'loading' || state.sessionCatalog?.selectionPending === true
    || state.sessionDeletion === 'deleting' || state.sessionDeletion === 'failed'
    || state.candidateVersions?.phase !== 'ready' || view?.phase !== 'ready' || state.savedSession?.phase !== 'ready';
  const identity = `${state.contactId}:${state.scopeRevision}:${history?.sessionId}:${candidateId}:${version?.versionId}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const scope = { contactId: state.contactId!, scopeRevision: state.scopeRevision,
    sessionId: state.savedSession?.sessionId ?? '', candidateId };
  const saveScope = `${scope.contactId}:${scope.scopeRevision}:${scope.sessionId}:${candidateId}`;
  const latestSaveScope = useRef(saveScope);
  latestSaveScope.current = saveScope;
  function retainDraft(messages: AssistantCandidateMessage[], requirements: string) {
    if (!version || draft?.versionId !== version.versionId) return;
    const operation = identity, revision = editRevision.current;
    void replies.updateCandidateVersionDraft({ ...scope, versionId: version.versionId, messages, requirements })
      .catch(() => {
        if (active.current && currentIdentity.current === operation && editRevision.current === revision) {
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
    const operation = saveScope, failedIdentity = `${saveScope}:${version.versionId}`;
    setFailedSaveIdentity(null); setError('');
    try {
      await replies.saveCandidateVersion({ ...scope, editKey: saveKey.current.key,
        parentVersionId: version.versionId, messages, requirements: requirements.trim() || null });
    } catch (error) {
      // 历史加载会卸载消息组；重试身份保留在版本编辑器，且不跨联系人或会话。
      if (active.current && latestSaveScope.current === operation) {
        setFailedSaveIdentity(failedIdentity);
      }
      throw error;
    }
  }
  async function carry() {
    if (disabled || dirty || carrying || !version) return;
    setCarrying(true);
    try { await replies.newSavedSessionWithCandidate({ sessionId: scope.sessionId, candidateId, versionId: version.versionId }); }
    finally { if (active.current) setCarrying(false); }
  }
  function retryRead() { void replies.readCandidateVersions(scope).catch(() => setError('本组版本尚未核对，请重试。')); }
  if (!history || !version || draft?.versionId !== version.versionId) return <>
    <p role="status">{view?.phase === 'failed' ? '本组版本暂不可用，编辑和复制尚未开放。' : '正在读取本组版本…'}</p>
    {view?.phase === 'failed' && <button onClick={retryRead}>重新读取本组版本</button>}
    {error && <p role="alert">{error}</p>}
  </>;
  const orderedVersions = [...history.versions].sort((a, b) => a.versionNumber - b.versionNumber);
  const versionIndex = orderedVersions.findIndex((item) => item.versionId === version.versionId);
  function showVersion(index: number) {
    const target = orderedVersions[index];
    if (dirty || disabled || !target) return;
    void replies.showCandidateVersion({ ...scope, versionId: target.versionId })
      .catch(() => setError('版本尚未切换，请重试。'));
  }
  return <>
    <ReplyBasisChangeNotice changes={history?.basisChanges} />
    <CandidateMessageGroup identity={identity} number={number} messages={messages}
      restored={restored} disabled={disabled || carrying} dirty={dirty}
      retrySave={failedSaveIdentity === `${saveScope}:${version.versionId}`}
      edit={editMessage}
      save={save} noteTextCopy={noteCopy}
      validatePaste={(text) => window.notalone.candidateProvenance.validateCandidatePaste({ ...scope, replyRequestId,
        versionId: version.versionId, text })}
      copy={(messageId) => window.notalone.candidateCopy.copy({ contactId: scope.contactId, scopeRevision: scope.scopeRevision,
        replyRequestId, candidateId, versionId: version.versionId, messageId, hideAfterCopy: false })}
      controls={<>
        {orderedVersions.length > 1 && <div className="candidate-version-navigation" role="group" aria-label={`说法${number}版本历史`}>
          <button aria-label={`查看说法${number}上一版`} disabled={dirty || disabled || versionIndex <= 0}
            onClick={() => showVersion(versionIndex - 1)}>← 上一版</button>
          <span>{version.versionNumber === 0 ? '原始版本' : `修改版本 ${version.versionNumber}`}</span>
          <button aria-label={`查看说法${number}下一版`} disabled={dirty || disabled || versionIndex >= orderedVersions.length - 1}
            onClick={() => showVersion(versionIndex + 1)}>下一版 →</button>
        </div>}
        <details className="candidate-more-actions" key={identity}><summary>更多操作</summary>
        <button disabled={dirty || disabled || carrying} onClick={() => void carry()}>用这组回复新开会话</button>
        </details>
      </>} />
    {view?.phase === 'failed' && <button onClick={retryRead}>重新读取本组版本</button>}
    {error && <p role="alert">{error}</p>}
  </>;
}
