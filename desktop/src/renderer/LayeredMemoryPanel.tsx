import { useEffect, useState } from 'react';
import type { LayeredMemory, LayeredMemoryManagementRequest, LayeredMemoryManagementOptions, MemoryOverviewState } from '../shared/memory-bridge';
import { MemoryTemporalStatus } from './MemoryTemporalStatus';

const statusNames: Record<LayeredMemory['status'], string> = { disabled: '已停用', ready: '本批主题资料整理成功',
  empty: '暂无合格资料可整理', failed: '部分整理未完成，请核对主题资料与长期背景状态', updating: '正在整理，尚未完成',
  stale: '依据已变化，主题资料待刷新', blocked: '已开启范围，质量资格待核验', paused: '已暂停，剩余资料可继续整理' };
function time(value: string | null): string {
  return value ? `${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Taipei', dateStyle: 'long', timeStyle: 'medium' }).format(new Date(value))}（UTC+8）` : '未知';
}
export function LayeredMemoryPanel({ state, contactName, busy, read, manage, facts, owner = false }: {
  state: MemoryOverviewState<LayeredMemory>; contactName: string; busy: boolean;
  read: (mappingCursor?: string | null) => Promise<void>; manage: (action: LayeredMemoryManagementRequest['action'], settingsGeneration: number, options?: LayeredMemoryManagementOptions) => Promise<void>;
  facts: (target?: { memoryId: string; revision: number }) => void; owner?: boolean;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const value = state.value;
  useEffect(() => { setConfirmed(false); setDeleting(false); }, [value?.contactId, value?.settingsGeneration]);
  const waiting = busy || state.phase === 'loading';
  return <section className="memory-section memory-overview layered-memory" aria-label="主题资料">
    <header><div><h2>主题资料</h2><p>{owner ? '范围：仅当前本人；只整理合法本人记忆，不包含联系人的身份或多联系人原话。' : `范围：仅当前联系人 ${contactName}；不包含本人或其他联系人的资料。`}</p></div>
      <button className="button" disabled={waiting} onClick={() => void read()}>重新读取主题资料</button></header>
    {state.phase === 'loading' && <p role="status">正在核对当前范围的主题资料…</p>}
    {state.phase === 'error' && <p role="alert">主题资料读取失败或旧入口分页已过期，旧内容已撤下。请重新读取首屏。</p>}
    {state.phase === 'idle' && <p>尚未读取主题资料。首次不会自动开启。</p>}
    {value && <>
      <p>整理用途：{value.purpose}</p>
      <p>合格资料 {value.eligibleCount} 条 · 已覆盖 {value.coveredCount} 条 · 剩余 {value.remainingCount} 条</p>
      {value.workId && <p>当前批次：{value.currentBatch}</p>}
      {value.workId && <p>累计已用 {value.modelCallsUsed} / 已授权 {value.modelCallLimit} 次模型调用</p>}
      <p role={value.status === 'failed' || value.status === 'paused' ? 'alert' : 'status'}>{value.errorCode === 'model_call_budget_exhausted'
        ? '当前工作模型调用预算已耗尽，整理已暂停。刷新不会重置预算。' : statusNames[value.status]}</p>
      {value.maintenancePending && <p role="status">资料已变化，等待后台更新。</p>}
      {value.remainingCount > 0 && value.coveredCount > 0 && <p>目前仅覆盖部分资料；剩余资料尚未整理。</p>}
      {value.qualityStatus === 'unknown' ? <div className="memory-section-note"><p>质量资格未知，资料不会发给模型。</p>
        <p>生产调用预算尚未标定；当前不开放真实资料整理或回复加载。</p></div>
        : <div className="memory-section-note"><p>仅用于受控合成验证，不代表真实模型质量已获资格。</p>
          <p>本批上限：{value.budget.maxMemories} 条记忆、{value.budget.maxScenarios} 个主题、{value.budget.maxParagraphs} 段、{value.budget.maxCharacters} 字符。</p>
          <p>当前工作模型调用授权上限：{value.budget.maxModelCalls} 次。</p>
          {value.budget.maxProfileEntries !== undefined && <p>长期背景最多 {value.budget.maxProfileEntries} 项。</p>}</div>}
      {value.qualityStatus === 'synthetic' && <><p>当前工作模型调用：累计已消耗 {value.budget.modelCallsUsed} 次 · 剩余 {value.budget.modelCallsRemaining} 次 · 上限 {value.budget.maxModelCalls} 次。</p>
        <p className="memory-section-note">额度包含失败、超时及已预留后中断的调用。当前合法的新目标或新启用世代独立计额。</p></>}
      {value.enabled && value.workId && <p className="memory-section-note">每次继续仅推进一批，并追加模型调用额度；已消耗调用不会因继续或重启清零。</p>}
      <p>本范围{value.enabled ? '已开启' : '已关闭'} · 更新时间：{time(value.updatedAt)}</p>
      {!value.enabled && <div className="layered-memory-confirm"><label><input type="checkbox" checked={confirmed} disabled={waiting}
        onChange={(event) => setConfirmed(event.target.checked)} />{owner ? '确认仅整理本人的合法已采纳记忆，并同意以上用途与模型接收范围' : '确认仅整理这位联系人的合法已采纳记忆，并同意以上用途与模型接收范围'}</label>
        <p>仅合格的底层记忆及其时间、引用标识可用于整理；待确认候选与来历未知资料不参与。</p>
        <button className="button" disabled={waiting || !confirmed} onClick={() => void manage('enable', value.settingsGeneration, { purposeConfirmed: true })}>确认范围并开启</button></div>}
      {value.enabled && <>{value.workId && value.workRevision > 0 && <>
        {(value.status === 'paused' || value.status === 'failed') && <button className="button" disabled={waiting}
          onClick={() => void manage('continue', value.settingsGeneration, { workRevision: value.workRevision })}>继续整理主题资料</button>}
        {value.status === 'updating' && <button className="button" disabled={waiting}
          onClick={() => void manage('pause', value.settingsGeneration, { workRevision: value.workRevision })}>暂停整理主题资料</button>}</>}
        <button className="button" disabled={waiting} onClick={() => void manage('refresh', value.settingsGeneration)}>刷新主题资料</button>
        <button className="button" disabled={waiting} onClick={() => void manage('disable', value.settingsGeneration)}>停用主题资料</button></>}
      <button className="button" disabled={waiting} onClick={() => setDeleting(true)}>删除整理结果</button>
      {deleting && <div className="memory-section-note" role="group" aria-label="确认删除主题资料">
        <p>删除将关闭本范围并清除整理正文、旧版本及相关副本。底层记忆另行管理；只有重新开启后才会再次整理。</p>
        <button className="button" disabled={waiting} onClick={() => void manage('delete', value.settingsGeneration)}>确认删除整理结果</button>
        <button className="button" disabled={waiting} onClick={() => setDeleting(false)}>取消删除</button></div>}
      {!value.enabled && (value.scenarios.length > 0 || value.profile !== null) && <p>已停止整理及回复加载；下方仅供回看来源仍有效的现有文档。</p>}
      <section className="memory-card" aria-label="长期背景">
        <div className="memory-card-labels"><h3>长期背景</h3>{value.profile && <b>系统整理</b>}</div>
        {value.profile ? <>
          <p className="memory-times">更新时间：{time(value.profile.updatedAt)}</p>
          {value.profile.entries.map((entry, index) => <div key={index}>
            <p className="memory-text">{entry.text}</p>
            <p>时间状态：{({ stable: '稳定背景', historical: '历史背景', uncertain: '尚不确定' } as const)[entry.temporalStatus]}</p>
            {entry.uncertainty && <p>不确定性：{entry.uncertainty}</p>}
            <details className="memory-details"><summary>查看第 {index + 1} 项依据与时间</summary>
              {entry.references.map((reference) => <div key={`${reference.memoryId}:${reference.revision}`}>
                <p>底层记忆：{reference.memoryId} · 版本 {reference.revision} · {reference.provenanceKind === 'manual_entry' ? '用户手动录入' : '来源支持'}</p>
                <MemoryTemporalStatus timing={reference.timing} snapshot />
                <p>来源聊天时间：{time(reference.timing.sourceStartedAt)}{reference.timing.sourceEndedAt !== reference.timing.sourceStartedAt ? ` 至 ${time(reference.timing.sourceEndedAt)}` : ''}
                  {!reference.timing.sourceTimeComplete ? '（来源时间不完整）' : ''}</p>
                <p>记忆保存时间：{time(reference.timing.recordedAt)}</p>
                <button className="button" disabled={waiting} onClick={() => facts(reference)}>查看底层记忆</button>
                <button className="button" disabled={waiting} onClick={() => void manage('fact-error', value.settingsGeneration,
                  { organizationGeneration: value.organizationGeneration, targetKind: 'profile', versionId: value.profile!.versionId, itemIndex: index, memoryId: reference.memoryId })}>事实有误：修正此条</button>
              </div>)}
            </details>
            <SummaryCorrection key={`profile:${value.profile!.versionId}:${index}`} busy={waiting} submit={(reason, operationId) => manage('summary-error', value.settingsGeneration,
              { organizationGeneration: value.organizationGeneration, targetKind: 'profile', versionId: value.profile!.versionId, itemIndex: index, reason, operationId })} />
          </div>)}
          <details className="memory-details"><summary>查看长期背景版本</summary>
            <p>版本标识：{value.profile.versionId}</p><p>一致集合世代：{value.organizationGeneration}</p></details>
          <button className="button" disabled={waiting} onClick={() => void manage('withdraw-profile', value.settingsGeneration,
            { organizationGeneration: value.organizationGeneration, profileVersionId: value.profile!.versionId })}>撤回本版长期背景</button>
          <p>撤回仅移除当前长期背景，不自动恢复旧版。事实有误可查看或修正底层记忆。</p>
        </> : <p>暂无可展示的长期背景。</p>}
      </section>
      {value.scenarios.length === 0 && value.status === 'ready' && <p>本批没有可展示的主题资料。</p>}
      {(value.mappingCursor || value.mappingNextCursor || value.scenarioMappings.length > 0) && <div>
        <p>旧入口映射按页展示，更多目标请翻页。</p>
        {value.mappingCursor && <button className="button" disabled={waiting} onClick={() => void read(null)}>返回旧入口首屏</button>}
        {value.mappingNextCursor && <button className="button" disabled={waiting} onClick={() => void read(value.mappingNextCursor)}>下一页旧入口</button>}
      </div>}
      {value.scenarioMappings.length > 0 && <details className="memory-details"><summary>查看旧主题入口的当前去向</summary>
        <p>旧入口仅用于查找当前合法主题；此处不展示旧版正文。</p>
        {value.scenarioMappings.map((mapping) => <div key={`${mapping.sourceScenarioId}:${mapping.sourceVersionId}`}>
          <p>旧主题：{mapping.sourceScenarioId} · 旧版本：{mapping.sourceVersionId}</p>
          {mapping.targets.map((target) => <p key={target.versionId}><a href={`#layered-scenario-${target.versionId}`}>
            查看当前主题：{value.scenarios.find((scenario) => scenario.versionId === target.versionId)?.title}
          </a></p>)}
        </div>)}
      </details>}
      <div className="memory-overview-entries">{value.scenarios.map((scenario) => <article className="memory-card" id={`layered-scenario-${scenario.versionId}`} key={scenario.versionId}>
        <div className="memory-card-labels"><h3>{scenario.title}</h3><b>系统整理</b></div>
        <p>{scenario.hint}</p><p className="memory-times">更新时间：{time(scenario.updatedAt)}</p>
        {scenario.paragraphs.map((paragraph, index) => <div key={index}><p className="memory-text">{paragraph.text}</p>
          <details className="memory-details"><summary>查看第 {index + 1} 段依据与时间</summary>
            {paragraph.references.map((reference) => <div key={`${reference.memoryId}:${reference.revision}`}>
              <p>底层记忆：{reference.memoryId} · 版本 {reference.revision} · {reference.provenanceKind === 'manual_entry' ? '用户手动录入' : '来源支持'}</p>
              <MemoryTemporalStatus timing={reference.timing} snapshot />
              <p>来源聊天时间：{time(reference.timing.sourceStartedAt)}{reference.timing.sourceEndedAt !== reference.timing.sourceStartedAt ? ` 至 ${time(reference.timing.sourceEndedAt)}` : ''}
                {!reference.timing.sourceTimeComplete ? '（来源时间不完整）' : ''}</p>
              <p>记忆保存时间：{time(reference.timing.recordedAt)}</p>
              <button className="button" disabled={waiting} onClick={() => facts(reference)}>查看底层记忆</button>
              <button className="button" disabled={waiting} onClick={() => void manage('fact-error', value.settingsGeneration,
                { organizationGeneration: value.organizationGeneration, targetKind: 'scenario', versionId: scenario.versionId, itemIndex: index, memoryId: reference.memoryId })}>事实有误：修正此条</button>
            </div>)}
          </details>
          <SummaryCorrection key={`scenario:${scenario.versionId}:${index}`} busy={waiting} submit={(reason, operationId) => manage('summary-error', value.settingsGeneration,
            { organizationGeneration: value.organizationGeneration, targetKind: 'scenario', versionId: scenario.versionId, itemIndex: index, reason, operationId })} />
        </div>)}
        {owner && <><button className="button" disabled={waiting} onClick={() => void manage('withdraw-scenario', value.settingsGeneration,
          { organizationGeneration: value.organizationGeneration, scenarioVersionId: scenario.versionId })}>撤回本版主题资料：{scenario.title}</button>
          <p>撤回仅移除本版主题及依赖它的长期背景，不自动恢复旧版。</p></>}
        <details className="memory-details"><summary>查看主题版本</summary><p>主题标识：{scenario.scenarioId}</p><p>版本标识：{scenario.versionId}</p></details>
      </article>)}</div>
      <p className="memory-section-note">来源聊天时间表示当时说过，不证明事件恰在当天发生，也不保证今天仍成立。事实有误请修正底层记忆，再刷新主题资料。</p>
      <p>补充背景请通过底层记忆的手动录入，整理结果会按合法资料更新。</p>
      <button className="button" disabled={waiting} onClick={() => facts()}>{owner ? '管理底层本人记忆' : '管理底层联系人记忆'}</button>
      {value.feedback.length > 0 && <section aria-label="整理纠错反馈"><h3>整理纠错反馈</h3>
        <p>受保护的旧依据 {value.protectedCount} 条。无法核对的新概括不会自动生效。</p>
        {value.feedback.map(feedback => <article key={feedback.id}><p>{feedback.targetKind === 'scenario' ? '主题资料' : '长期背景'}第 {feedback.itemIndex + 1} 项：
          {feedback.state === 'active' ? feedback.reason : '来源敏感内容已清除，仅保留仍有效旧依据的保护。'}</p></article>)}
      </section>}
    </>}
  </section>;
}

function SummaryCorrection({ busy, submit }: { busy: boolean; submit: (reason: string, operationId: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [reason, setReason] = useState('');
  return <div>
    <button className="button" disabled={busy} onClick={() => setEditing(true)}>总结有误</button>
    {editing && <form aria-label="反馈总结错误" onSubmit={event => { event.preventDefault(); void submit(reason.trim(), crypto.randomUUID()); }}>
      <p>仅反馈整理含义，不修改正确的底层事实；本版及受影响背景将撤下并重新整理。</p>
      <label>总结错误说明<textarea value={reason} maxLength={500} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
      <button className="button" disabled={busy || !reason.trim()}>提交总结纠错</button>
      <button className="button" type="button" disabled={busy} onClick={() => { setEditing(false); setReason(''); }}>取消总结纠错</button>
    </form>}
  </div>;
}
