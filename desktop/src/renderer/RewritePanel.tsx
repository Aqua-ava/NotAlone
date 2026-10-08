import { useEffect, useRef, useState } from 'react';
import type { ReplySessionState, RewriteOptions, RewriteTone } from '../shared/reply-bridge';
import { HelperDraft, type ContactSessionView } from './contact-session';
import { Icon } from './icons';
import './rewrite.css';

export function useReplySession() {
  const [state, setState] = useState<ReplySessionState>({ revision: -1, scopeRevision: 0, contactId: null,
    options: { tone: 'original', instruction: '', includeRelationshipContext: false },
    phase: 'idle', result: null, selectedCandidateId: null, canRetry: false });
  const [error, setError] = useState('');
  const latest = useRef(state);
  const active = useRef(true);
  const receive = (next: ReplySessionState) => {
    if (!active.current || next.revision < latest.current.revision) return;
    if (next.scopeRevision !== latest.current.scopeRevision) setError('');
    latest.current = next; setState(next);
  };
  useEffect(() => {
    active.current = true;
    const unsubscribe = window.notalone.replies.onStateChanged(receive);
    void window.notalone.replies.getState().then(receive).catch(() => {});
    return () => { active.current = false; unsubscribe(); };
  }, []);
  async function operate(operation: () => Promise<ReplySessionState | void>) {
    const scopeRevision = latest.current.scopeRevision;
    try { const next = await operation(); if (next) receive(next); if (active.current && scopeRevision === latest.current.scopeRevision) setError(''); }
    catch { if (active.current && scopeRevision === latest.current.scopeRevision) setError('本次表达操作暂时不可用，请重新确认联系人。'); }
  }
  const selection = () => ({ contactId: latest.current.contactId!, scopeRevision: latest.current.scopeRevision });
  return { state, error,
    updateOptions: (options: RewriteOptions) => operate(() => window.notalone.replies.updateOptions({ ...selection(), options })),
    generate: (newRequest = false) => operate(() => window.notalone.replies.generate({ ...selection(), newRequest })),
    selectCandidate: (candidateId: string) => operate(() => window.notalone.replies.selectCandidate({ ...selection(), replyRequestId: latest.current.result!.replyRequestId, candidateId })),
    editCandidate: (candidateId: string, text: string) => operate(() => window.notalone.replies.editCandidate({ ...selection(), replyRequestId: latest.current.result!.replyRequestId, candidateId, text })),
  };
}
export type ReplySessionView = ReturnType<typeof useReplySession>;

export function RewriteInput({ contacts, replies }: { contacts: ContactSessionView; replies: ReplySessionView }) {
  const [options, setOptions] = useState(replies.state.options);
  useEffect(() => { setOptions(replies.state.options); }, [replies.state.scopeRevision]);
  const enabled = Boolean(contacts.state.selectedContactId);
  const update = (value: Partial<RewriteOptions>) => {
    const next = { ...options, ...value }; setOptions(next); void replies.updateOptions(next);
  };
  return <>
    <div className="ime-input"><HelperDraft session={contacts} />
      <button className="generate-button" aria-label="生成候选" title="生成候选"
        disabled={!enabled || !contacts.state.draft.trim() || replies.state.phase === 'waiting'}
        onClick={() => void replies.generate()}><Icon name="sparkle" size={18} /></button></div>
    <div className="rewrite-options">
      <label>本次语气<select aria-label="本次语气" value={options.tone} disabled={!enabled}
        onChange={(event) => update({ tone: event.target.value as RewriteTone })}>
        <option value="original">保留原意</option><option value="warm">自然温和</option>
        <option value="concise">简洁直接</option><option value="polite">礼貌克制</option></select></label>
      <label className="rewrite-context"><input type="checkbox" checked={options.includeRelationshipContext} disabled={!enabled}
        onChange={(event) => update({ includeRelationshipContext: event.target.checked })} />结合关系语境</label>
      <label className="rewrite-instruction">本次要求<input aria-label="本次要求" maxLength={4096}
        value={options.instruction} disabled={!enabled} placeholder="可选，如只说明时间，不增加承诺"
        onChange={(event) => update({ instruction: event.target.value })} /></label>
    </div>
    <p className="rewrite-privacy">{options.includeRelationshipContext ? '本次允许使用这位联系人的近期消息和相关资料。' : '默认只处理草稿，不读取关系历史。'} 语气和要求只作用于本次生成。</p>
    <div className="rewrite-retry">
      {replies.state.canRetry && <button disabled={replies.state.phase === 'waiting'} onClick={() => void replies.generate()}>重试同一次生成</button>}
      {replies.state.result && <button disabled={!contacts.state.draft.trim() || replies.state.phase === 'waiting'} onClick={() => void replies.generate(true)}>重新生成</button>}
    </div>
  </>;
}

function CandidateEditor({ text, candidateId, number, edit }: { text: string; candidateId: string; number: number; edit: ReplySessionView['editCandidate'] }) {
  const [value, setValue] = useState(text);
  useEffect(() => { setValue(text); }, [candidateId]);
  return <textarea aria-label={`候选${number}编辑文本`} maxLength={65_536} value={value}
    onChange={(event) => { setValue(event.target.value); void edit(candidateId, event.target.value); }} />;
}

export function ReplyCandidates({ replies }: { replies: ReplySessionView }) {
  const { state } = replies;
  return <section className="reply-candidates" aria-label="候选回复">
    {state.phase === 'waiting' && <p className="reply-note" role="status">正在等待本次生成结果…</p>}
    {state.phase === 'failed' && <p className="reply-note" role="alert">{state.errorCode === 'connection' ? '未收到生成结果，请用同一次请求重试。'
      : state.errorCode === 'timeout' ? '本次生成超时，请重试同一次生成。'
      : state.errorCode === 'rejected' ? '本次生成被拒绝，请在管理后台确认联系人及有效会话绑定。'
      : state.errorCode === 'unavailable' ? '回复服务暂不可用，请检查应用配置和本机服务。'
      : '本次生成失败，请核对本机服务后重试。'}</p>}
    {state.result ? <>
      <details className="reply-input-snapshot"><summary>这组候选的生成输入 · {state.result.input.contactDisplayName}</summary>
        <p>{state.result.input.draftText}</p><p>{state.result.input.userInstruction ?? '没有额外要求'}</p>
        <p>关系语境：{state.result.input.includeRelationshipContext ? '已开启' : '关闭'}</p></details>
      <div className="reply-candidate-grid">
        {state.result.candidates.map(({ original, editedText }, index) => <article className="reply-candidate" key={original.candidateId}>
          <label className="reply-choice"><input type="radio" name="candidate" checked={state.selectedCandidateId === original.candidateId}
            onChange={() => void replies.selectCandidate(original.candidateId)} />说法 {index + 1}</label>
          <CandidateEditor text={editedText} candidateId={original.candidateId} number={index + 1} edit={replies.editCandidate} />
          <p className="reply-basis">{original.basis}</p>
          {original.riskNotes.map((note, number) => <p className="reply-risk" key={number}>{note}</p>)}
          <details><summary>查看原候选</summary><p className="reply-original">{original.text}</p></details>
        </article>)}
      </div>
    </> : state.phase !== 'waiting' && <div className="reply-empty"><p>暂无候选</p><small>准备好你的意思，再选择合适的表达。</small></div>}
    {replies.error && <p className="reply-note" role="alert">{replies.error}</p>}
  </section>;
}
