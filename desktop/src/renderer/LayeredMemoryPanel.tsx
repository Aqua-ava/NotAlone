import { useEffect, useState } from 'react';
import type { LayeredMemory, LayeredMemoryManagementRequest, MemoryOverviewState } from '../shared/memory-bridge';
import { MemoryTemporalStatus } from './MemoryTemporalStatus';

const statusNames: Record<LayeredMemory['status'], string> = { disabled: '已停用', ready: '本批主题资料整理成功',
  empty: '暂无合格资料可整理', failed: '整理失败，未采用本批结果', updating: '正在整理，尚未完成',
  stale: '依据已变化，主题资料待刷新', blocked: '已开启范围，质量资格待核验' };
function time(value: string | null): string {
  return value ? `${new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Taipei', dateStyle: 'long', timeStyle: 'medium' }).format(new Date(value))}（UTC+8）` : '未知';
}
export function LayeredMemoryPanel({ state, contactName, busy, read, manage, facts }: {
  state: MemoryOverviewState<LayeredMemory>; contactName: string; busy: boolean;
  read: () => Promise<void>; manage: (action: LayeredMemoryManagementRequest['action'], settingsGeneration: number, purposeConfirmed?: true) => Promise<void>;
  facts: () => void;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const value = state.value;
  useEffect(() => { setConfirmed(false); setDeleting(false); }, [value?.contactId, value?.settingsGeneration]);
  const waiting = busy || state.phase === 'loading';
  return <section className="memory-section memory-overview layered-memory" aria-label="主题资料">
    <header><div><h2>主题资料</h2><p>范围：仅当前联系人 {contactName}；不包含本人或其他联系人的资料。</p></div>
      <button className="button" disabled={waiting} onClick={() => void read()}>重新读取主题资料</button></header>
    {state.phase === 'loading' && <p role="status">正在核对当前范围的主题资料…</p>}
    {state.phase === 'error' && <p role="alert">主题资料读取失败，旧内容已撤下。请重新读取。</p>}
    {state.phase === 'idle' && <p>尚未读取主题资料。首次不会自动开启。</p>}
    {value && <>
      <p>整理用途：{value.purpose}</p>
      <p>合格资料 {value.eligibleCount} 条 · 已覆盖 {value.coveredCount} 条 · 剩余 {value.remainingCount} 条</p>
      <p role={value.status === 'failed' ? 'alert' : 'status'}>{statusNames[value.status]}</p>
      {value.remainingCount > 0 && value.coveredCount > 0 && <p>目前仅覆盖部分资料；剩余资料尚未整理。</p>}
      {value.qualityStatus === 'unknown' ? <div className="memory-section-note"><p>质量资格未知，资料不会发给模型。</p>
        <p>生产调用预算尚未标定；当前不开放真实资料整理或回复加载。</p></div>
        : <div className="memory-section-note"><p>仅用于受控合成验证，不代表真实模型质量已获资格。</p>
          <p>本批上限：{value.budget.maxMemories} 条记忆、{value.budget.maxScenarios} 个主题、{value.budget.maxParagraphs} 段、{value.budget.maxCharacters} 字符、{value.budget.maxModelCalls} 次模型调用。</p></div>}
      <p>本范围{value.enabled ? '已开启' : '已关闭'} · 更新时间：{time(value.updatedAt)}</p>
      {!value.enabled && <div className="layered-memory-confirm"><label><input type="checkbox" checked={confirmed} disabled={waiting}
        onChange={(event) => setConfirmed(event.target.checked)} />确认仅整理这位联系人的合法已采纳记忆，并同意以上用途与模型接收范围</label>
        <p>仅合格的底层记忆及其时间、引用标识可用于整理；待确认候选与来历未知资料不参与。</p>
        <button className="button" disabled={waiting || !confirmed} onClick={() => void manage('enable', value.settingsGeneration, true)}>确认范围并开启</button></div>}
      {value.enabled && <><button className="button" disabled={waiting} onClick={() => void manage('refresh', value.settingsGeneration)}>刷新主题资料</button>
        <button className="button" disabled={waiting} onClick={() => void manage('disable', value.settingsGeneration)}>停用主题资料</button></>}
      <button className="button" disabled={waiting} onClick={() => setDeleting(true)}>删除整理结果</button>
      {deleting && <div className="memory-section-note" role="group" aria-label="确认删除主题资料">
        <p>删除将关闭本范围并清除整理正文、旧版本及相关副本。底层记忆另行管理；只有重新开启后才会再次整理。</p>
        <button className="button" disabled={waiting} onClick={() => void manage('delete', value.settingsGeneration)}>确认删除整理结果</button>
        <button className="button" disabled={waiting} onClick={() => setDeleting(false)}>取消删除</button></div>}
      {!value.enabled && value.scenarios.length > 0 && <p>已停止整理及回复加载；下方仅供回看来源仍有效的现有文档。</p>}
      {value.scenarios.length === 0 && value.status === 'ready' && <p>本批没有可展示的主题资料。</p>}
      <div className="memory-overview-entries">{value.scenarios.map((scenario) => <article className="memory-card" key={scenario.versionId}>
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
              <button className="button" onClick={facts}>查看或修正底层记忆</button>
            </div>)}
          </details></div>)}
        <details className="memory-details"><summary>查看主题版本</summary><p>主题标识：{scenario.scenarioId}</p><p>版本标识：{scenario.versionId}</p></details>
      </article>)}</div>
      <p className="memory-section-note">来源聊天时间表示当时说过，不证明事件恰在当天发生，也不保证今天仍成立。事实有误请修正底层记忆，再刷新主题资料。</p>
      <button className="button" onClick={facts}>管理底层联系人记忆</button>
    </>}
  </section>;
}
