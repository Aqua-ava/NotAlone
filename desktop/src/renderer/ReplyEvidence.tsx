import { useState } from 'react';
import type { ReplyCandidate, ReplyCandidateSelection } from '../shared/reply-bridge';
import type { ReplyEvidenceState, ReplyLayeredContext, ReplyLayeredScenarioRead, ReplyLayeredStatus, ReplyRetrievalReceipt } from '../shared/reply-evidence';
import { useRevisionedSession } from './use-revisioned-session';
import { MemoryTemporalStatus } from './MemoryTemporalStatus';
import { ReplyBasisChangeNotice } from './ReplyBasisChangeNotice';

const subscription = { getState: () => window.notalone.replies.getEvidenceState(),
  onStateChanged: (listener: (state: ReplyEvidenceState) => void) => window.notalone.replies.onEvidenceChanged(listener) };
const kindNames = { message: '消息', confirmed_memory: '关系资料', owner_memory: '本人资料', user_draft: '用户草稿', user_current_chat: '本次粘贴的对方文字（未经渠道核验）', user_purpose: '本次主动目的', continued_candidate: '前序候选', pending_candidate: '未确认记忆候选' };
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

function LayeredSummary({ context, status, receipts, owner = false }: { context?: ReplyLayeredContext | null; status?: ReplyLayeredStatus; receipts?: ReplyLayeredScenarioRead[]; owner?: boolean }) {
  const scope = owner ? '本人' : '联系人';
  const successfulReads = receipts?.filter((receipt) => receipt.status === 'succeeded') ?? [];
  if (!context) {
    const reasons = { not_allowed: '本次未授权加载系统整理资料。', unavailable: '本次系统整理资料不可用，未加入生成。',
      budget_omitted: '本次系统整理资料因预算限制未加入生成。', quality_closed: '本次系统整理资料未获质量资格，未加入生成。',
      loaded: '本次分层依据缺失，不补填后来资料。' };
    return <p>{owner ? '本人资料：' : ''}{status ? reasons[status] : '本次快照未记录分层资料，不补填后来资料。'}</p>;
  }
  const temporalNames = { stable: '稳定事实或明确偏好', historical: '历史资料', uncertain: '不确定' };
  return <section aria-label={`本次${scope}系统整理资料`}>
    <h4>系统整理 · 本次实际加入的{scope}背景与主题目录</h4>
    <p>生成时设置版本：{context.settingsGeneration}；整理版本：{context.organizationGeneration}。</p>
    <p>背景版本：{context.profileVersionId ?? '本次未加入长期背景'}。</p>
    <p>独立预算上限：背景 {context.budget.profileEntries} 条，目录 {context.budget.directoryEntries} 项，{context.budget.characters} 字符。</p>
    {context.profileEntries.map((entry, index) => <article key={index}>
      <p>{entry.text}</p><p>生成时状态：{temporalNames[entry.temporalStatus]}</p>
      {entry.uncertainty && <p>不确定性：{entry.uncertainty}</p>}
      {entry.references.map((ref) => <div key={`${ref.memoryId}:${ref.revision}`}>
        <p>底层资料：{ref.memoryId}；版本：{ref.revision}；{ref.provenanceKind === 'manual_entry' ? '手动录入' : '来源支持'}。</p>
        <MemoryTemporalStatus timing={ref.timing} snapshot />
        <p>保存时间：{ref.timing.recordedAt ?? '未知'}；来源时间：{ref.timing.sourceStartedAt ?? '未知'} 至 {ref.timing.sourceEndedAt ?? '未知'}{ref.timing.sourceTimeComplete ? '' : '（不完整）'}。</p>
      </div>)}
    </article>)}
    <p>{successfulReads.length ? '初始仅加载主题目录；下方正文为本次工具实际读取结果。' : '初始仅加载主题目录，未读取主题正文。'}</p>
    {context.directory.map((entry) => <article key={entry.scenarioId}>
      <strong>{entry.title}</strong><p>{entry.hint}</p><p>目录版本：{entry.versionId}；正文共 {entry.paragraphCount} 段。
        {entry.paragraphRange && <>允许读取范围：[{entry.paragraphRange[0]}, {entry.paragraphRange[1]})。</>}</p>
      <p>{successfulReads.some((receipt) => receipt.scenarioId === entry.scenarioId)
        ? '本次已读取的段落见下方正文。' : '本次没有该主题的成功正文读取记录。'}</p>
    </article>)}
  </section>;
}

function paragraphRangeLabel(range: [number, number]) {
  if (range[0] < 0 || range[1] <= range[0]) return `原范围 [${range[0]}, ${range[1]})（无效范围）`;
  return `${range[1] - range[0] === 1 ? `第 ${range[0] + 1} 段` : `第 ${range[0] + 1} 至 ${range[1]} 段`}（原范围 [${range[0]}, ${range[1]})）`;
}

function ScenarioReadSummary({ receipts, owner = false }: { receipts?: ReplyLayeredScenarioRead[]; owner?: boolean }) {
  if (!receipts) return <p>本次快照未记录主题正文读取过程，不补填后来资料。</p>;
  if (!receipts.length) return <p>本次未调用主题正文读取工具。</p>;
  const statuses = { succeeded: '读取成功', duplicate: '重复读取，未追加正文', out_of_range: '段落越界，未读取正文',
    not_in_directory: '主题不在本次目录，未读取正文', invalid_arguments: '读取参数无效，未读取正文',
    stale: '冻结版本已失效，未读取正文', budget_exceeded: '读取预算已耗尽，未读取正文' };
  return <section aria-label={owner ? '本次本人主题正文读取' : '本次联系人主题正文读取'}>
    <h4>系统整理 · 本次实际读取的{owner ? '本人' : '联系人'}主题正文与回执</h4>
    <p>只展示生成时实际读入的冻结正文；未读取部分仍为未知。</p>
    {receipts.map((receipt, index) => <article key={index}>
      <p>主题读取 {index + 1}：{statuses[receipt.status]}。</p>
      <p>{receipt.reason}</p>
      <p>主题 ID：{receipt.scenarioId ?? '参数未提供合法主题 ID'}；
        请求段落：{receipt.paragraphRange ? paragraphRangeLabel(receipt.paragraphRange) : '无合法段落范围'}。</p>
      <p>本次累计：{receipt.budget.usedCalls}/{receipt.budget.callLimit} 次，
        {receipt.budget.usedParagraphs}/{receipt.budget.paragraphLimit} 段，
        {receipt.budget.usedCharacters}/{receipt.budget.characterLimit} 字符。</p>
      {receipt.status === 'succeeded' && <>
        <strong>{receipt.document.title}</strong><p>{receipt.document.hint}</p>
        <p>冻结正文版本：{receipt.document.versionId}；整理版本：{receipt.document.organizationGeneration}；
          实际读取：{paragraphRangeLabel(receipt.document.paragraphRange)}。</p>
        {receipt.document.paragraphs.map((paragraph, paragraphIndex) => <div key={paragraphIndex}>
          <p>第 {receipt.document.paragraphRange[0] + paragraphIndex + 1} 段：{paragraph.text}</p>
          {paragraph.references.map((ref) => <div key={`${ref.memoryId}:${ref.revision}`}>
            <p>底层资料：{ref.memoryId}；版本：{ref.revision}；
              {ref.provenanceKind === 'manual_entry' ? '手动录入' : ref.provenanceKind === 'source_supported' ? '来源支持' : '本次快照未记录来历'}。</p>
            {ref.timing ? <>
              <MemoryTemporalStatus timing={ref.timing} snapshot />
              <p>保存时间：{ref.timing.recordedAt ?? '未知'}；来源时间：{ref.timing.sourceStartedAt ?? '未知'} 至 {ref.timing.sourceEndedAt ?? '未知'}{ref.timing.sourceTimeComplete ? '' : '（不完整）'}。</p>
            </> : <p>本次快照未记录来源时间与核实状态。</p>}
          </div>)}
        </div>)}
      </>}
    </article>)}
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
  const selectionKey = JSON.stringify(selection);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const matches = state.contactId === selection.contactId && state.scopeRevision === selection.scopeRevision
    && state.replyRequestId === selection.replyRequestId && state.candidateId === selection.candidateId;
  const open = matches && state.phase !== 'idle';
  async function operate(close = false) {
    const revision = evidence.latest.current.scopeRevision;
    try {
      await (close ? window.notalone.replies.closeEvidence(selection) : window.notalone.replies.loadEvidence(selection));
      if (evidence.active.current && revision === evidence.latest.current.scopeRevision) setFailure(null);
    } catch { if (evidence.active.current && revision === evidence.latest.current.scopeRevision) setFailure({ key: selectionKey, message: '候选依据暂不可用，请重新确认本次候选。' }); }
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
        <LayeredSummary context={state.layeredContext} status={state.layeredStatus} receipts={state.layeredScenarioReads} />
        <ScenarioReadSummary receipts={state.layeredScenarioReads} />
        <LayeredSummary context={state.ownerLayeredContext} status={state.ownerLayeredStatus} receipts={state.ownerLayeredScenarioReads} owner />
        <ScenarioReadSummary receipts={state.ownerLayeredScenarioReads} owner />
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
    {failure?.key === selectionKey && <p role="alert">{failure.message}</p>}
  </div>;
}
