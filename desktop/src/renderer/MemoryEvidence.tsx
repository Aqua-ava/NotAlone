import { useEffect, useRef, useState } from 'react';
import type { TraceBatch, TraceRecordKind, TraceState } from '../shared/trace-bridge';
import type { ContactSessionView } from './contact-session';
import { useTraceReading } from './TracePanel';
import { readMemoryEvidence } from './memory-evidence';

export function MemoryEvidence({ session, kind, recordId, text, onClose }: {
  session: ContactSessionView; kind: TraceRecordKind; recordId: string; text?: string; onClose: () => void;
}) {
  const traces = useTraceReading(session);
  const [batches, setBatches] = useState<TraceBatch[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [availability, setAvailability] = useState<TraceState['availability']>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const contactId = session.state.selectedContactId;
  const scopeRevision = session.state.scopeRevision;

  useEffect(() => {
    const ticket = ++generation.current;
    let active = true;
    const current = () => active && ticket === generation.current;
    const matches = (next: TraceState) => next.contactId === contactId && next.scopeRevision === scopeRevision
      && next.resource === 'memory-traces';
    setBatches([]); setBatchId(null); setAvailability(null); setError(''); setLoading(true);
    // 主进程在来源删除、断线或范围变化时先清空状态；立即阻止后续异步请求和旧正文回显。
    const unsubscribe = window.notalone.traces.onStateChanged((next) => {
      if (!current()) return;
      if (!matches(next) || next.phase === 'idle' || next.phase === 'error') {
        ++generation.current;
        setBatches([]); setBatchId(null); setAvailability(null); setLoading(false);
        setError(next.phase === 'error' ? '依据暂时无法读取，请重试。' : '资料或连接已变化，请重新查看依据。');
      }
    });
    async function read() {
      if (!contactId) { setLoading(false); return; }
      const request = { contactId, scopeRevision, resource: 'memory-traces' as const };
      try {
        await window.notalone.traces.find({ ...request, kind, recordId });
        if (!current()) return;
        const found = await window.notalone.traces.getState();
        if (!current() || !matches(found) || found.phase !== 'ready') return;
        setBatches(found.batches); setAvailability(found.availability);
        const first = found.batches.find((batch) => batch.status !== 'deleted');
        if (first) {
          setBatchId(first.batchId);
          await window.notalone.traces.show({ ...request, batchId: first.batchId });
        }
        if (current()) setLoading(false);
      } catch {
        if (current()) { setLoading(false); setError('依据暂时无法读取，请重试。'); }
      }
    }
    void read();
    return () => { active = false; ++generation.current; unsubscribe(); };
  }, [contactId, scopeRevision, kind, recordId, attempt]);

  async function show(id: string) {
    if (!contactId) return;
    const ticket = generation.current;
    setBatchId(id); setLoading(true); setError('');
    try { await window.notalone.traces.show({ contactId, scopeRevision, resource: 'memory-traces', batchId: id }); }
    catch { if (ticket === generation.current) setError('依据暂时无法读取，请重试。'); }
    finally { if (ticket === generation.current) setLoading(false); }
  }
  const ready = !loading && !error && contactId !== null && traces.state.contactId === contactId
    && traces.state.scopeRevision === scopeRevision && traces.state.phase === 'ready' && traces.state.resource === 'memory-traces';
  const detail = ready && traces.state.detail?.trace_id === batchId ? traces.state.detail : null;
  const evidence = detail && contactId ? readMemoryEvidence(detail, contactId, kind, recordId) : null;
  const deleted = availability === 'deleted' || traces.state.availability === 'deleted' || detail?.status === 'deleted';
  return <section className="memory-section memory-evidence" aria-label="记忆依据">
    <header><h2>记忆依据</h2><button className="button" onClick={onClose}>收起依据</button></header>
    {ready && !deleted && text && <p className="memory-text">{text}</p>}
    <p>这里只展示这条记忆已记录的来源聊天。缺失的原话不会补造。</p>
    {(loading || traces.state.phase === 'loading') && <p role="status">正在读取依据…</p>}
    {error && <p role="alert">{error}</p>}
    {ready && <>
      {availability === 'not_applicable' && <p>这条资料由手动录入，没有模型提取的聊天依据。</p>}
      {availability === 'not_recorded' && <p>这条记忆未保存可查看的来源原话。</p>}
      {deleted && <p>这条记忆的过程记录已删除，无法从中查看原话。</p>}
      {batches.length > 1 && <label>已保存的依据记录<select aria-label="已保存的依据记录" value={batchId ?? ''} onChange={(event) => void show(event.target.value)}>
        {batches.map((batch, index) => <option key={batch.batchId} value={batch.batchId}>
          {index + 1} · {new Date(batch.recordedAt).toLocaleString('zh-CN')}{batch.status === 'deleted' ? '（已删除）' : ''}
        </option>)}
      </select></label>}
      {!deleted && evidence && <>
        {!evidence.messages.length && <p>已保存的记录中，没有能与这条记忆明确对应的来源原话。</p>}
        {evidence.messages.map((message) => <article className="memory-evidence-message" key={message.id}>
          <p><strong>{message.sender === 'self' ? '我' : message.sender === 'contact' ? '对方' : '说话人未知'}</strong>
            {' · '}{message.occurredAt ? new Date(message.occurredAt).toLocaleString('zh-CN') : '时间未知'}</p>
          <blockquote style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{message.text}</blockquote>
          {message.representation !== 'text' && <p>{message.representation === 'placeholder'
            ? '这是媒体占位信息，没有保存媒体原话。' : '这是当时保存的消息文字，未确认是否为原始文字。'}</p>}
        </article>)}
        {evidence.missingCount > 0 && <p>另有 {evidence.missingCount} 项来源未保存可核对的消息文字。</p>}
      </>}
    </>}
    {!loading && <button className="button" onClick={() => setAttempt((value) => value + 1)}>重新读取依据</button>}
  </section>;
}
