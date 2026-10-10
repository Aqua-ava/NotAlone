import { useEffect, useState, type ClipboardEvent } from 'react';
import type { ReplySessionView } from './RewritePanel';
import type { StyleSampleState } from '../shared/style-sample-bridge';
import { useRevisionedSession } from './use-revisioned-session';

export function StyleSamples({ replies }: { replies: ReplySessionView }) {
  const view = useRevisionedSession<StyleSampleState>({ revision: -1, contactId: null, scopeRevision: 0, erasureRevision: 0,
    phase: 'idle', samples: [], busy: false, error: null }, window.notalone.styleSamples);
  const [manual, setManual] = useState('');
  const selection = { contactId: replies.state.contactId!, scopeRevision: replies.state.scopeRevision };
  const enabled = Boolean(selection.contactId) && !view.state.busy;
  const usedIds = replies.state.sourceAvailability === undefined
    && view.state.contactId === selection.contactId && view.state.scopeRevision === selection.scopeRevision
    ? replies.state.result?.styleSampleIds ?? [] : [];
  async function operate(action: () => Promise<void>) {
    const revision = replies.state.scopeRevision;
    try { await action(); if (view.active.current && revision === view.latest.current.scopeRevision) view.setError(''); }
    catch { if (view.active.current && revision === view.latest.current.scopeRevision) view.setError('样本操作暂时不可用，请核对联系人并刷新。'); }
  }
  useEffect(() => { setManual(''); if (selection.contactId) void operate(async () => {
    await window.notalone.styleSamples.updateManualText({ ...selection, text: '' });
    await window.notalone.styleSamples.refresh(selection);
  }); }, [selection.contactId, selection.scopeRevision]);
  useEffect(() => { setManual(''); }, [view.state.erasureRevision]);
  function noteSampleCopy(event: ClipboardEvent<HTMLElement>) {
    const copied = window.getSelection(); const text = copied?.toString() ?? '';
    if (!text.trim() || !copied || (!event.currentTarget.contains(copied.anchorNode) && !event.currentTarget.contains(copied.focusNode))) return;
    const element = copied.anchorNode?.parentElement?.closest('[data-style-sample-id]');
    const sampleId = element?.getAttribute('data-style-sample-id') ?? view.state.samples[0]?.sampleId;
    if (sampleId) void operate(() => window.notalone.styleSamples.noteSavedSampleCopy({ ...selection, sampleId,
      // 超长跨项复制只登记不可归属标记，后续粘贴不得丢来源。
      text: text.length <= 65_536 ? text : '' }));
  }
  return <details className="style-samples"><summary>我的表达样本</summary>
    <p>只在你明确保存后作为这位联系人的说法参考。保存不表示已发送；当前意图优先。删除助手会话保留已保存样本，删除原始来源仍会清理依赖样本。</p>
    {usedIds.length > 0 && <section aria-label="本次表达参考"><p>本次使用的样本只参考说法，不作为事实依据：</p>
      <ul onCopy={noteSampleCopy}>{usedIds.map((id) => {
        const sample = view.state.samples.find((item) => item.sampleId === id);
        return <li key={id} data-style-sample-id={id}>{sample ? sample.text : '样本暂不可读，请刷新表达样本。'}</li>;
      })}</ul></section>}
    <button disabled={!enabled} onClick={() => void operate(() => window.notalone.styleSamples.refresh(selection))}>刷新表达样本</button>
    <label>手工表达样本<textarea aria-label="手工表达样本" maxLength={4096} value={manual} disabled={!enabled}
      onPaste={(event) => { const text = event.clipboardData.getData('text/plain');
        if (text.trim()) void operate(() => window.notalone.styleSamples.noteManualPaste({ ...selection, text: text.slice(0, 65_536) })); }}
      onChange={(event) => { const text = event.target.value; setManual(text);
        void operate(() => window.notalone.styleSamples.updateManualText({ ...selection, text })); }} /></label>
    <button disabled={!enabled || !manual.trim()} onClick={() => void operate(async () => {
      await window.notalone.styleSamples.saveManual({ ...selection, text: manual });
      const saved = await window.notalone.styleSamples.getState();
      if (saved.contactId === selection.contactId && saved.scopeRevision === selection.scopeRevision && saved.phase === 'ready' && !saved.error) {
        setManual(''); await window.notalone.styleSamples.updateManualText({ ...selection, text: '' });
      }
    })}>主动保存手工文字</button>
    {replies.state.result?.candidates.map(({ original, editedText }, index) => <button key={original.candidateId}
      disabled={!enabled || !editedText.trim() || editedText.length > 4096 || replies.state.sourceAvailability !== undefined}
      onClick={() => void operate(() => window.notalone.styleSamples.saveCandidate({ ...selection, replyRequestId: replies.state.result!.replyRequestId, candidateId: original.candidateId }))}>主动保存说法{index + 1}为样本</button>)}
    {replies.state.messages.items.filter((message) => message.speaker === 'user' && message.text?.trim()).map((message) =>
      <button key={message.messageId} disabled={!enabled || (message.text?.length ?? 0) > 4096}
        onClick={() => void operate(() => window.notalone.styleSamples.saveMessage({ ...selection, messageId: message.messageId }))}>主动保存本人消息为样本：{message.text?.slice(0, 24)}</button>)}
    {view.state.phase === 'loading' && <p role="status">正在读取表达样本…</p>}
    <ul aria-label="表达样本目录" onCopy={noteSampleCopy}>{view.state.samples.map((sample) => <li key={sample.sampleId} data-style-sample-id={sample.sampleId}><p>{sample.text}</p>
      <small>{sample.originKind === 'manual' ? '手工保存' : sample.originKind === 'candidate' ? '候选衍生，保留来源依赖' : '本人消息衍生，保留来源依赖'} · 发送状态未知</small>
      <button disabled={!enabled} aria-label={`删除表达样本：${sample.text}`} onClick={() => void operate(() => window.notalone.styleSamples.deleteSample({ ...selection, sampleId: sample.sampleId }))}>删除样本</button></li>)}</ul>
    {(view.state.error || view.error) && <p role="alert">{view.state.error ?? view.error}</p>}
  </details>;
}
