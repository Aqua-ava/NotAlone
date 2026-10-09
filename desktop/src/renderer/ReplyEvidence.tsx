import type { ReplyCandidate, ReplyCandidateSelection } from '../shared/reply-bridge';
import type { ReplyEvidenceState } from '../shared/reply-evidence';
import { useRevisionedSession } from './use-revisioned-session';

const subscription = { getState: () => window.notalone.replies.getEvidenceState(),
  onStateChanged: (listener: (state: ReplyEvidenceState) => void) => window.notalone.replies.onEvidenceChanged(listener) };
const kindNames = { message: '消息', confirmed_memory: '关系资料', owner_memory: '本人资料', user_draft: '用户草稿', continued_candidate: '前序候选' };
const statusNames: Record<string, string> = { active: '有效', user_input: '用户输入', candidate: '候选', pending: '待确认', confirmed: '已采纳', deleted: '已删除', invalidated: '已失效' };

export function useReplyEvidence() {
  return useRevisionedSession<ReplyEvidenceState>({ revision: -1, scopeRevision: 0, contactId: null,
    replyRequestId: null, candidateId: null, phase: 'idle', items: [] }, subscription);
}
export function ReplyEvidence({ evidence, selection, candidate, number, waiting }: {
  evidence: ReturnType<typeof useReplyEvidence>; selection: ReplyCandidateSelection; candidate: ReplyCandidate; number: number; waiting: boolean;
}) {
  const { state } = evidence;
  const matches = state.contactId === selection.contactId && state.scopeRevision === selection.scopeRevision
    && state.replyRequestId === selection.replyRequestId && state.candidateId === selection.candidateId;
  const open = matches && state.phase !== 'idle';
  async function operate(close = false) {
    const revision = evidence.latest.current.scopeRevision;
    try {
      await (close ? window.notalone.replies.closeEvidence(selection) : window.notalone.replies.loadEvidence(selection));
      if (evidence.active.current && revision === evidence.latest.current.scopeRevision) evidence.setError('');
    } catch { if (evidence.active.current && revision === evidence.latest.current.scopeRevision) evidence.setError('候选依据暂不可用，请重新确认本次候选。'); }
  }
  return <div className="reply-evidence">
    <button disabled={waiting} aria-expanded={open} onClick={() => void operate(open)}>{open ? '收起' : '展开'}候选{number}依据</button>
    {open && <section aria-label={`候选${number}依据`}>
      <p>本次生成快照；状态和时间对应生成时，不代表资料当前仍可检索。</p>
      {state.phase === 'loading' && <p role="status">正在读取本次依据…</p>}
      {state.phase === 'failed' && <><p role="alert">本次依据读取失败，请检查本机连接后重试。</p><button onClick={() => void operate()}>重试候选{number}依据</button></>}
      {state.phase === 'missing' && <p role="status">本次依据不存在或已删除，无法恢复原正文。</p>}
      {state.phase === 'ready' && <>
        {candidate.citationIds.some((id) => !state.items.some((item) => item.evidenceId === id)) && <p>部分引用缺失，不补填后来资料。</p>}
        {!state.items.length && <p>本次没有可展示的依据。</p>}
        {state.items.map((item) => <article key={item.evidenceId}>
          <strong>{kindNames[item.kind]}</strong>
          <p>{candidate.citationIds.includes(item.evidenceId) ? '本候选已引用' : item.cited ? '同组其他候选已引用' : '生成上下文，未被候选引用'}</p>
          <p>{item.text}</p><p>入选原因：{item.selectionReason}</p>
          <p>生成时状态：{statusNames[item.snapshotStatus] ?? '未识别状态'}</p>
          <p>保存时间：{item.timing.recordedAt ?? '未知'}</p>
          {item.timing.sourceStartedAt && item.timing.sourceEndedAt
            ? <p>来源时间：{item.timing.sourceStartedAt} 至 {item.timing.sourceEndedAt}{item.timing.sourceTimeComplete ? '' : '（不完整）'}</p>
            : <p>来源时间未知</p>}
          <p>有效起点：{item.validAt ?? '未知'}；失效时间：{item.invalidAt ?? '未知'}</p>
        </article>)}
      </>}
    </section>}
    {matches && evidence.error && <p role="alert">{evidence.error}</p>}
  </div>;
}
