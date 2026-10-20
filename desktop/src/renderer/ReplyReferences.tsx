import { useEffect, useState, type ReactNode } from 'react';
import type { ReplyCandidate, ReplyCandidateSelection, ReplyUsedSkill } from '../shared/reply-bridge';
import type { ExpressionPreferenceReceipt } from '../shared/expression-preference-bridge';
import type { MemoryTiming } from '../shared/memory-bridge';
import type { ReplyEvidenceItem, ReplyLayeredContext, ReplyLayeredScenarioRead } from '../shared/reply-evidence';
import { ReplyEvidenceTechnicalDetails, type useReplyEvidence } from './ReplyEvidence';
import { MemoryTemporalStatus } from './MemoryTemporalStatus';
import { MemoryEventDetails } from './MemoryEventDetails';
import { MemoryConditionsDetails } from './MemoryConditionsDetails';
import { MemoryEvolutionDetails } from './MemoryEvolutionDetails';
import { memoryTimeText } from './memory-time-format';
import { PersonalBackgroundDetails } from './PersonalBackgroundDetails';
import { ReplyBasisChangeNotice } from './ReplyBasisChangeNotice';
import './reply-references.css';

function SourceTime({ timing }: { timing?: MemoryTiming }) {
  if (!timing) return <p>本次快照未记录来源时间。</p>;
  return <><p>来源时间：{memoryTimeText(timing.sourceStartedAt)}{timing.sourceEndedAt && timing.sourceEndedAt !== timing.sourceStartedAt ? ` 至 ${memoryTimeText(timing.sourceEndedAt)}` : ''}{timing.sourceTimeComplete ? '' : '（不完整）'}</p>
    <p>保存时间：{memoryTimeText(timing.recordedAt)}</p></>;
}
function TemporalDetails({ material }: { material: Pick<ReplyEvidenceItem, 'event' | 'conditions' | 'evolution'> }) {
  return <><MemoryEventDetails event={material.event} /><MemoryConditionsDetails conditions={material.conditions} />
    <MemoryEvolutionDetails evolution={material.evolution} /></>;
}
const inputNames = { user_draft: '你的草稿', user_current_chat: '你补充的聊天（未经渠道核验）', user_purpose: '本次表达目的', continued_candidate: '继续修改的候选' };
function Material({ item }: { item: ReplyEvidenceItem }) {
  return <article className="reference-card">
    {item.kind in inputNames && <strong>{inputNames[item.kind as keyof typeof inputNames]}</strong>}
    {item.kind === 'pending_candidate' && <strong className="reference-caution">未确认参考，不作为确定事实</strong>}
    <p className="reference-text">{item.text}</p>
    {['confirmed_memory', 'owner_memory', 'pending_candidate'].includes(item.kind) && <MemoryTemporalStatus timing={item.timing} validAt={item.validAt} invalidAt={item.invalidAt} snapshot compact />}
    <details className="record-metadata"><summary>来源与时间</summary>{item.navigation && <p>{item.navigation.scopeKind === 'contact' ? '由联系人概览定位' : '由本人概览定位'}，底层资料来历：{item.navigation.provenanceKind === 'manual_entry' ? '手动录入' : '来源支持'}。</p>}<p>入选原因：{item.selectionReason}</p><SourceTime timing={item.timing} />
      {['confirmed_memory', 'owner_memory', 'pending_candidate'].includes(item.kind) && <><TemporalDetails material={item} />{item.timing.currentStatusReason && <p>{item.timing.currentStatusReason}</p>}</>}
    </details>
  </article>;
}
function Group({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return count ? <section className="reference-group" aria-label={title}><h4>{title}<span>{count} 条</span></h4>{children}</section> : null;
}
function successfulReads(reads?: ReplyLayeredScenarioRead[]) {
  return (reads ?? []).filter(read => read.status === 'succeeded');
}
function LayeredMaterials({ context, reads }: { context?: ReplyLayeredContext | null; reads?: ReplyLayeredScenarioRead[] }) {
  return <>
    {context?.profileEntries.map((entry, index) => <article className="reference-card" key={`profile-${index}`}>
      <strong>长期背景</strong><PersonalBackgroundDetails item={entry} /><p className="reference-text">{entry.text}</p>
      <p>{({ stable: '稳定事实或明确偏好', historical: '历史资料', uncertain: '不确定' })[entry.temporalStatus]}</p>
      {entry.uncertainty && <p className="reference-caution">{entry.uncertainty}</p>}
      <details className="record-metadata"><summary>来源与时间</summary>{entry.references.map((ref, i) => <div key={i}><p>{ref.provenanceKind === 'manual_entry' ? '手动录入' : '来源支持'}</p><SourceTime timing={ref.timing} /><MemoryTemporalStatus timing={ref.timing} validAt={ref.validAt} invalidAt={ref.invalidAt} snapshot compact /><TemporalDetails material={ref} /></div>)}</details>
    </article>)}
    {successfulReads(reads).flatMap((read, index) => read.document.paragraphs.map((paragraph, paragraphIndex) => <article className="reference-card" key={`read-${index}-${paragraphIndex}`}>
      <strong>{read.document.title} · 已读正文</strong><PersonalBackgroundDetails item={paragraph} /><p className="reference-text">{paragraph.text}</p>
      {paragraph.uncertainty && <p className="reference-caution">{paragraph.uncertainty}</p>}
      <details className="record-metadata"><summary>来源与时间</summary>{paragraph.references.map((ref, i) => <div key={i}><p>{ref.provenanceKind === 'manual_entry' ? '手动录入' : ref.provenanceKind === 'source_supported' ? '来源支持' : '来源来历未记录'}</p><SourceTime timing={ref.timing} />{ref.timing && <MemoryTemporalStatus timing={ref.timing} validAt={ref.validAt} invalidAt={ref.invalidAt} snapshot compact />}<TemporalDetails material={ref} /></div>)}</details>
    </article>))}
  </>;
}

export function ReplyReferences({ evidence, selection, candidates, expressionPreferences, usedSkill, waiting }: {
  evidence: ReturnType<typeof useReplyEvidence>; selection: ReplyCandidateSelection; candidates: ReplyCandidate[];
  expressionPreferences?: ExpressionPreferenceReceipt[]; usedSkill?: ReplyUsedSkill | null; waiting: boolean;
}) {
  const { state } = evidence;
  const identity = JSON.stringify([selection.contactId, selection.scopeRevision, selection.replyRequestId, selection.candidateId]);
  const [openIdentity, setOpenIdentity] = useState<string | null>(null);
  const [failureIdentity, setFailureIdentity] = useState<string | null>(null);
  const matches = state.contactId === selection.contactId && state.scopeRevision === selection.scopeRevision
    && state.replyRequestId === selection.replyRequestId && state.candidateId === selection.candidateId;
  const ready = matches && state.phase === 'ready' && !waiting && failureIdentity !== identity;
  const open = openIdentity === identity;
  useEffect(() => {
    let active = true;
    setOpenIdentity(null);
    setFailureIdentity(null);
    if (waiting) return () => { active = false; };
    void window.notalone.replies.loadEvidence(selection).catch(() => { if (active) setFailureIdentity(identity); });
    return () => { active = false; };
  }, [identity, waiting]);
  const items = ready ? state.items : [];
  const chat = items.filter(item => item.kind === 'message');
  const relationship = items.filter(item => item.kind === 'confirmed_memory' || item.kind === 'pending_candidate');
  const owner = items.filter(item => item.kind === 'owner_memory');
  const inputs = items.filter(item => item.kind in inputNames);
  const context = ready ? state.layeredContext : null;
  const ownerContext = ready ? state.ownerLayeredContext : null;
  const reads = ready ? state.layeredScenarioReads : undefined;
  const ownerReads = ready ? state.ownerLayeredScenarioReads : undefined;
  const relationCount = relationship.length + (context?.profileEntries.length ?? 0) + successfulReads(reads).reduce((n, read) => n + read.document.paragraphs.length, 0);
  const ownerCount = owner.length + (ownerContext?.profileEntries.length ?? 0) + successfulReads(ownerReads).reduce((n, read) => n + read.document.paragraphs.length, 0);
  const directories = [...(context?.directory ?? []).map(entry => ({ ...entry, scope: '联系人', reads })), ...(ownerContext?.directory ?? []).map(entry => ({ ...entry, scope: '本人', reads: ownerReads }))];
  const preferences = ready ? expressionPreferences ?? [] : [];
  const skill = ready ? usedSkill : undefined;
  const summary = [chat.length && `聊天 ${chat.length} 条`, relationCount && `关系资料 ${relationCount} 条`, ownerCount && `本人资料 ${ownerCount} 条`, directories.length && `主题目录 ${directories.length} 项`, preferences.length && `表达偏好 ${preferences.length} 条`, skill && '回复方法 1 项', inputs.length && `本次输入 ${inputs.length} 条`].filter(Boolean).join(' · ');
  const failed = failureIdentity === identity || (matches && state.phase === 'failed');
  const missing = matches && state.phase === 'missing';
  const status = ready ? summary || '本次快照没有可展示的材料' : failed ? '本次参考读取失败' : missing ? '本次参考不存在或已删除' : '正在读取本次参考…';
  return <div className="reply-references">
    <button className="reference-toggle" type="button" aria-label="本次参考" aria-expanded={open} onClick={() => setOpenIdentity(open ? null : identity)}>
      <span className="reference-toggle-title">本次参考</span><span className="reference-summary">{status}</span><span aria-hidden="true">{open ? '⌃' : '⌄'}</span>
    </button>
    {open && <section className="reference-content" aria-label="本次参考内容">
      {!ready && <p role={failed ? 'alert' : 'status'}>{status}{missing ? '，无法恢复原正文。' : ''}</p>}
      {failed && !waiting && <button type="button" aria-label="重试本次参考" onClick={() => { setFailureIdentity(null); void window.notalone.replies.loadEvidence(selection).catch(() => setFailureIdentity(identity)); }}>重试读取参考</button>}
      {ready && <>
        <p className="reference-help">以下材料实际提供给了模型，不代表每条候选都引用了每一项。</p>
        <ReplyBasisChangeNotice changes={state.basisChanges} />
        <Group title="聊天记录" count={chat.length}>{chat.map(item => <Material key={item.evidenceId} item={item} />)}</Group>
        <Group title="关系资料" count={relationCount}>{relationship.map(item => <Material key={item.evidenceId} item={item} />)}<LayeredMaterials context={context} reads={reads} /></Group>
        <Group title="本人资料" count={ownerCount}>{owner.map(item => <Material key={item.evidenceId} item={item} />)}<LayeredMaterials context={ownerContext} reads={ownerReads} /></Group>
        {directories.length > 0 && <section className="reference-group" aria-label="主题目录"><h4>主题目录<span>{directories.length} 项</span></h4>{directories.map((entry, index) => <article className="reference-card" key={index}><strong>{entry.title}</strong><p>{entry.hint}</p><p className="reference-help">{entry.scope}资料 · {successfulReads(entry.reads).some(read => read.scenarioId === entry.scenarioId) ? '本次已读正文见上方资料' : '仅提供目录，未读正文'}</p></article>)}</section>}
        <Group title="表达偏好" count={preferences.length}>{preferences.map(preference => <article className="reference-card" key={preference.preferenceId}><p className="reference-text">{preference.text}</p></article>)}</Group>
        <Group title="回复方法" count={skill ? 1 : 0}>{skill && <article className="reference-card"><p>{skill.name}</p>{skill.loadState === 'resource_failed' && <p className="reference-caution">部分资源读取失败，不能视为完整加载。</p>}</article>}</Group>
        {usedSkill === undefined && <p className="reference-help">本次快照未记录回复方法，无法确认是否使用。</p>}
        <Group title="本次输入" count={inputs.length}>{inputs.map(item => <Material key={item.evidenceId} item={item} />)}</Group>
        <details className="reference-technical evidence-technical"><summary>检索过程与技术详情</summary><p>本轮 {candidates.length} 条候选共用这份生成材料。</p><p>请求：{selection.replyRequestId}</p><p>系统整理资料：联系人 {state.layeredStatus ?? '未记录'}；本人 {state.ownerLayeredStatus ?? '未记录'}。</p><ReplyEvidenceTechnicalDetails state={state} /></details>
      </>}
    </section>}
  </div>;
}
