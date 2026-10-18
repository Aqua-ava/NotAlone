import { useEffect, useRef, useState, type ClipboardEvent } from 'react';
import type { ReplySessionView } from './RewritePanel';
import type { StyleSampleState } from '../shared/style-sample-bridge';
import { useRevisionedSession } from './use-revisioned-session';

export function StyleSamples({ replies }: { replies: ReplySessionView }) {
  const view = useRevisionedSession<StyleSampleState>({ revision: -1, contactId: null, scopeRevision: 0, erasureRevision: 0,
    phase: 'idle', samples: [], busy: false, error: null }, window.notalone.styleSamples);
  const [manual, setManual] = useState('');
  const editRevision = useRef(0);
  const pendingPasteId = useRef<string | undefined>(undefined);
  const selection = { contactId: replies.state.contactId!, scopeRevision: replies.state.scopeRevision };
  const currentSelection = useRef(selection);
  currentSelection.current = selection;
  const enabled = Boolean(selection.contactId) && !view.state.busy;
  const usedIds = replies.state.sourceAvailability === undefined
    && view.state.contactId === selection.contactId && view.state.scopeRevision === selection.scopeRevision
    ? replies.state.result?.styleSampleIds ?? [] : [];
  async function operate(action: () => Promise<void>) {
    const revision = replies.state.scopeRevision;
    try { await action(); if (view.active.current && revision === view.latest.current.scopeRevision) view.setError(''); }
    catch { if (view.active.current && revision === view.latest.current.scopeRevision) view.setError('样本操作暂时不可用，请核对联系人并刷新。'); }
  }
  useEffect(() => { ++editRevision.current; pendingPasteId.current = undefined; setManual(''); if (selection.contactId) void operate(async () => {
    await window.notalone.styleSamples.updateManualText({ ...selection, text: '' });
    await window.notalone.styleSamples.refresh(selection);
  }); }, [selection.contactId, selection.scopeRevision]);
  useEffect(() => { ++editRevision.current; pendingPasteId.current = undefined; setManual(''); }, [view.state.erasureRevision]);
  async function pasteManual(event: ClipboardEvent<HTMLTextAreaElement>) {
    event.preventDefault();
    const previousPasteId = pendingPasteId.current;
    pendingPasteId.current = undefined;
    const text = event.clipboardData.getData('text/plain');
    const input = event.currentTarget;
    const before = manual.slice(0, input.selectionStart), after = manual.slice(input.selectionEnd);
    const insertedText = text.slice(0, Math.max(0, 4096 - before.length - after.length));
    const next = before + insertedText + after;
    const edit = ++editRevision.current;
    const revision = view.latest.current.revision;
    const current = () => view.active.current && edit === editRevision.current
      && currentSelection.current.contactId === selection.contactId
      && currentSelection.current.scopeRevision === selection.scopeRevision
      && view.latest.current.revision === revision;
    try {
      if (previousPasteId) await window.notalone.styleSamples.updateManualText({ ...selection, text: manual, cancelPasteId: previousPasteId });
      if (!current()) return;
      if (!insertedText.trim() || text.length > 65_536 || next.length > 4096) {
        view.setError('粘贴内容为空、过长或输入框已满，请缩小选区后再试。'); return;
      }
      const receipt = await window.notalone.styleSamples.noteManualPaste({ ...selection, text });
      if (!current()) return;
      pendingPasteId.current = receipt.pasteId;
      // 再读主进程发布序号，覆盖连接切换事件尚未送达页面的窗口。
      const verified = await window.notalone.styleSamples.getState();
      if (!current() || verified.revision !== revision) return;
      await window.notalone.styleSamples.updateManualText({ ...selection, text: next, pasteId: receipt.pasteId, pastedText: text, insertedText });
      const committed = await window.notalone.styleSamples.getState();
      if (current() && committed.revision === revision) {
        pendingPasteId.current = undefined;
        setManual(next); view.setError('');
        await window.notalone.styleSamples.updateManualText({ ...selection, text: next });
      }
    } catch {
      if (current() && !manual.trim()) {
        await window.notalone.styleSamples.updateManualText({ ...selection, text: '' }).catch(() => {});
      }
      if (current()) view.setError('无法核验粘贴来源，请清空后直接输入，或从明确候选、本人消息入口保存。');
    } finally {
      if (edit === editRevision.current && pendingPasteId.current) {
        const cancelPasteId = pendingPasteId.current; pendingPasteId.current = undefined;
        await window.notalone.styleSamples.updateManualText({ ...selection, text: manual, cancelPasteId }).catch(() => {});
      }
    }
  }
  function noteSampleCopy(event: ClipboardEvent<HTMLElement>) {
    const copied = window.getSelection(); const text = copied?.toString() ?? '';
    if (!text.trim() || !copied || (!event.currentTarget.contains(copied.anchorNode) && !event.currentTarget.contains(copied.focusNode))) return;
    const element = copied.anchorNode?.parentElement?.closest('[data-style-sample-id]');
    const sampleId = element?.getAttribute('data-style-sample-id') ?? view.state.samples[0]?.sampleId;
    if (sampleId) void operate(() => window.notalone.styleSamples.noteSavedSampleCopy({ ...selection, sampleId,
      // 超长跨项复制只登记不可归属标记，后续粘贴不得丢来源。
      text: text.length <= 65_536 ? text : '' }));
  }
  return <details id="assistant-expression-samples" className="style-samples"><summary>我的表达样本</summary>
    <p>只在你明确保存后作为这位联系人的说法参考。保存不表示已发送；当前意图优先。删除助手会话保留已保存样本，删除原始来源仍会清理依赖样本。</p>
    {usedIds.length > 0 && <section aria-label="本次表达参考"><p>本次使用的样本只参考说法，不作为事实依据：</p>
      <ul onCopy={noteSampleCopy}>{usedIds.map((id) => {
        const sample = view.state.samples.find((item) => item.sampleId === id);
        return <li key={id} data-style-sample-id={id}>{sample ? sample.text : '样本暂不可读，请刷新表达样本。'}</li>;
      })}</ul></section>}
    <button disabled={!enabled} onClick={() => void operate(() => window.notalone.styleSamples.refresh(selection))}>刷新表达样本</button>
    <div className="expression-manual"><h3>添加自己的说法</h3><label>手工表达样本<textarea aria-label="手工表达样本" maxLength={4096} value={manual} disabled={!enabled}
      onPaste={(event) => void pasteManual(event)}
      onChange={(event) => { ++editRevision.current; const text = event.target.value; setManual(text);
        const cancelPasteId = pendingPasteId.current; pendingPasteId.current = undefined;
        void operate(() => window.notalone.styleSamples.updateManualText({ ...selection, text,
          ...(cancelPasteId ? { cancelPasteId } : {}) })); }} /></label>
    <button disabled={!enabled || !manual.trim()} onClick={() => void operate(async () => {
      ++editRevision.current;
      const cancelPasteId = pendingPasteId.current; pendingPasteId.current = undefined;
      if (cancelPasteId) await window.notalone.styleSamples.updateManualText({ ...selection, text: manual, cancelPasteId });
      await window.notalone.styleSamples.saveManual({ ...selection, text: manual });
      const saved = await window.notalone.styleSamples.getState();
      if (saved.contactId === selection.contactId && saved.scopeRevision === selection.scopeRevision && saved.phase === 'ready' && !saved.error) {
        ++editRevision.current; setManual(''); await window.notalone.styleSamples.updateManualText({ ...selection, text: '' });
      }
    })}>主动保存手工文字</button></div>
    {replies.state.result?.input.mode === 'rewrite_draft' && replies.state.result.candidates.map(({ original, editedText }, index) => <button key={original.candidateId}
      disabled={!enabled || !editedText.trim() || editedText.length > 4096 || replies.state.sourceAvailability !== undefined}
      onClick={() => void operate(() => window.notalone.styleSamples.saveCandidate({ ...selection, replyRequestId: replies.state.result!.replyRequestId, candidateId: original.candidateId }))}>主动保存说法{index + 1}为样本</button>)}
    <div className="expression-message-options"><h3>从本人消息中选取</h3><p>点击一条消息，将它保存为表达样本。</p>
    {replies.state.messages.items.filter((message) => message.speaker === 'user' && message.text?.trim()).map((message) =>
      <button key={message.messageId} disabled={!enabled || (message.text?.length ?? 0) > 4096}
        onClick={() => void operate(() => window.notalone.styleSamples.saveMessage({ ...selection, messageId: message.messageId }))}>主动保存本人消息为样本：{message.text?.slice(0, 24)}</button>)}
    </div>
    {view.state.phase === 'loading' && <p role="status">正在读取表达样本…</p>}
    <h3>已保存的样本</h3>
    {!view.state.samples.length && <p className="section-empty">还没有保存表达样本。</p>}
    <ul aria-label="表达样本目录" onCopy={noteSampleCopy}>{view.state.samples.map((sample) => <li key={sample.sampleId} data-style-sample-id={sample.sampleId}><p>{sample.text}</p>
      <small>{sample.originKind === 'manual' ? '手工保存' : sample.originKind === 'candidate' ? '候选衍生，保留来源依赖' : '本人消息衍生，保留来源依赖'} · 发送状态未知</small>
      <button disabled={!enabled} aria-label={`删除表达样本：${sample.text}`} onClick={() => void operate(() => window.notalone.styleSamples.deleteSample({ ...selection, sampleId: sample.sampleId }))}>删除样本</button></li>)}</ul>
    {(view.state.error || view.error) && <p role="alert">{view.state.error ?? view.error}</p>}
  </details>;
}
