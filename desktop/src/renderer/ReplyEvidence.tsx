import type { ReplyCandidate, ReplyCandidateSelection } from '../shared/reply-bridge';
import type { ReplyEvidenceState, ReplyRetrievalReceipt } from '../shared/reply-evidence';
import { useRevisionedSession } from './use-revisioned-session';
import { MemoryTemporalStatus } from './MemoryTemporalStatus';
import { ReplyBasisChangeNotice } from './ReplyBasisChangeNotice';

const subscription = { getState: () => window.notalone.replies.getEvidenceState(),
  onStateChanged: (listener: (state: ReplyEvidenceState) => void) => window.notalone.replies.onEvidenceChanged(listener) };
const kindNames = { message: '消息', confirmed_memory: '关系资料', owner_memory: '本人资料', user_draft: '用户草稿', user_purpose: '本次主动目的', continued_candidate: '前序候选', pending_candidate: '未确认记忆候选' };
const statusNames: Record<string, string> = { active: '有效', user_input: '用户输入', candidate: '候选', pending: '待确认', confirmed: '已采纳', deleted: '已删除', invalidated: '已失效' };

function RetrievalSummary({ receipt }: { receipt: ReplyRetrievalReceipt | null | undefined }) {
  if (!receipt) return <p>本次快照未记录检索过程，不能据此判断是否查空或耗尽。</p>;
  const summary = { succeeded: '本次已完成有界检索。', empty: '本次检索未查到相关依据；不表示没有这件事。',
    budget_exhausted: '本次检索预算已耗尽，未查到的内容仍为未知。', unavailable: '本次检索有读取失败，未获得的内容仍为未知。' };
  const { contactMemory, ownerMemory, pendingCandidate, sourceMessages } = receipt.budgets;
  const queryNames = { confirmed_memory: '关系资料检索', owner_memory: '本人资料检索', pending_candidate: '未确认参考检索', message: '消息检索' };
  const queryStates = { succeeded: '已完成', empty: '未查到相关依据，不表示不存在', budget_exceeded: '预算已耗尽，未继续读取', failed: '读取失败，结果未知' };
  return <section aria-label="本次有界检索">
    <p>{summary[receipt.status]}</p>
    <p>概览仅用于定位；以下原话和资料才是本次实际依据。回执与导航版本对应生成时。</p>
    {[['联系人资料', contactMemory], ['本人资料', ownerMemory], ['未确认参考', pendingCandidate]].map(([name, budget]) => {
      const value = budget as typeof contactMemory;
      return <p key={name as string}>{name as string}：{value.usedCount}/{value.limit} 条，{value.usedChars}/{value.charLimit} 字符{value.exhausted ? '；预算已耗尽' : ''}。</p>;
    })}
    <p>原话补查：{sourceMessages.usedCalls}/{sourceMessages.callLimit} 次，{sourceMessages.usedCount}/{sourceMessages.itemLimit} 条，{sourceMessages.usedTokens}/{sourceMessages.tokenLimit} 估算 token{sourceMessages.exhausted ? '；预算已耗尽' : ''}。</p>
    {receipt.queries.map((query, index) => <p key={index}>
      {query.purpose === 'source_window' ? '原话窗口补查' : queryNames[query.kind]}：{queryStates[query.status]}
      {query.status === 'succeeded' ? `，${query.evidenceIds.length} 条进入本次生成` : ''}。
    </p>)}
  </section>;
}

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
        <RetrievalSummary receipt={state.retrieval} />
        <ReplyBasisChangeNotice changes={state.basisChanges} />
        {candidate.citationIds.some((id) => !state.items.some((item) => item.evidenceId === id)) && <p>部分引用缺失，不补填后来资料。</p>}
        {!state.items.length && <p>本次没有可展示的依据。</p>}
        {state.items.map((item) => <article key={item.evidenceId}>
          <strong>{kindNames[item.kind]}</strong>
          {item.navigation && <p>{item.navigation.scopeKind === 'contact' ? '由联系人概览定位' : '由本人概览定位'}，底层资料来历：{item.navigation.provenanceKind === 'manual_entry' ? '手动录入' : '来源支持'}。</p>}
          <ReplyBasisChangeNotice changes={state.basisChanges?.filter((change) => change.evidenceId === item.evidenceId && change.kind === item.kind)} />
          <p>{candidate.citationIds.includes(item.evidenceId) ? '本候选已引用' : item.cited ? '同组其他候选已引用' : '生成上下文，未被候选引用'}</p>
          <p>{item.text}</p><p>入选原因：{item.selectionReason}</p>
          <p>生成时状态：{statusNames[item.snapshotStatus] ?? '未识别状态'}</p>
          {['confirmed_memory', 'owner_memory', 'pending_candidate'].includes(item.kind) && <MemoryTemporalStatus timing={item.timing} snapshot />}
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
