import { useEffect, useRef, useState } from 'react';
import type { FixedMemoryProcessingBridge, FixedProcessingRun, FixedProcessingTrace, FixedProcessingView } from '../shared/fixed-memory-processing';

function status(run: FixedProcessingRun | null): string {
  if (!run) return '尚未开始';
  if (run.unknown > 0) return '调用结果待核实';
  if (run.state === 'incomplete' && run.succeeded === run.total && run.total > 0) return '提取核验已结束';
  return { pending: '等待提取与核验', running: '正在提取与核验', paused: '已暂停', failed: '提取核验失败',
    incomplete: '本轮尚未完成', revoked: '范围已失效' }[run.state];
}

/** 由记忆页面传入具名桥；scopeKey变化或失效事件先撤下全部本地快照。 */
export function FixedMemoryProcessingPanel({ bridge, scopeKey = '' }: { bridge: FixedMemoryProcessingBridge; scopeKey?: string | number }) {
  const [view, setView] = useState<FixedProcessingView | null>(null);
  const [trace, setTrace] = useState<FixedProcessingTrace | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const active = useRef(false), revision = useRef(0), startRequest = useRef<string | null>(null);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const receive = async (operation: () => Promise<FixedProcessingView>) => {
    const accepted = ++revision.current;
    setBusy(true); setError(''); setView(null); setTrace(null);
    try {
      const next = await operation();
      if (active.current && accepted === revision.current) { setView(next); return next; }
      return null;
    } catch {
      if (active.current && accepted === revision.current) {
        setView(null); setTrace(null); setError('处理状态暂不可用，请刷新后重试。');
      }
      return null;
    } finally { if (active.current && accepted === revision.current) setBusy(false); }
  };
  refresh.current = () => receive(() => bridge.readCurrent()).then(() => {});
  useEffect(() => {
    active.current = true;
    const unsubscribe = bridge.onInvalidated(() => {
      revision.current++; setView(null); setTrace(null); setBusy(false);
      setError('资料资格或连接已变化，已撤下原快照，请重新读取。');
    });
    void refresh.current();
    return () => {
      active.current = false; revision.current++; unsubscribe();
      void bridge.release().catch(() => {});
    };
  }, [bridge, scopeKey]);
  useEffect(() => {
    if (!view?.run || !['pending', 'running'].includes(view.run.state)) return;
    const timer = setTimeout(() => { if (!document.hidden) void refresh.current(); }, 2000);
    const visible = () => { if (!document.hidden) void refresh.current(); };
    document.addEventListener('visibilitychange', visible);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [view]);
  async function start() {
    if (!view || busy) return;
    const requestKey = startRequest.current ??= crypto.randomUUID();
    const next = await receive(() => bridge.start({ requestKey, connectionGeneration: view.connectionGeneration }));
    if (next) startRequest.current = null;
  }
  async function control(action: 'pause' | 'continue') {
    if (!view?.run || busy) return;
    const request = { runId: view.run.runId, connectionGeneration: view.connectionGeneration };
    await receive(() => bridge[action](request));
  }
  async function readTrace(taskId: string) {
    if (!view || busy) return;
    const accepted = ++revision.current;
    setBusy(true); setTrace(null); setError('');
    try {
      const next = await bridge.trace({ taskId, connectionGeneration: view.connectionGeneration });
      if (active.current && accepted === revision.current) setTrace(next);
    } catch {
      if (active.current && accepted === revision.current) {
        setView(null); setTrace(null); setError('过程资料暂不可用，已撤下原快照，请重新读取。');
      }
    } finally { if (active.current && accepted === revision.current) setBusy(false); }
  }
  const run = view?.run ?? null;
  const allExtracted = run && run.total > 0 && run.succeeded === run.total;
  const canContinue = run && !['pending', 'running', 'revoked'].includes(run.state) && run.succeeded < run.total
    && run.tasks.some(task => task.scopeKind === 'contact' && ['failed', 'paused', 'pending'].includes(task.state)
      && task.succeeded < task.total && !['targets_completed_elsewhere', 'memory_extraction_targets_completed_elsewhere'].includes(task.errorCode ?? ''));
  return <section className="memory-processing-card" aria-label="固定范围记忆处理">
    <h2>记忆处理</h2>
    <p>处理当前勾选联系人已保存的有效文字。关闭微信读取后仍可手动处理。</p>
    {error && <p role="alert">{error}</p>}
    {view && <p role="status">{status(run)}</p>}
    {busy && <p aria-live="polite">正在核对处理状态…</p>}
    {run && <>
      <p>已处理 {run.succeeded} / {run.total} 条文字目标</p>
      {allExtracted && run.candidates.length === 0 && <p>已处理，未产生新记忆</p>}
      {run.failed > 0 && <p>有 {run.failed} 条目标尚未通过提取核验。</p>}
      {run.unknown > 0 && <p>有 {run.unknown} 条目标调用结果未知，核实前不会重新发送。</p>}
      <p>主题整理、长期概览尚未执行，本轮未完成。</p>
      {run.candidates.length > 0 && <section aria-label="本轮已核验候选">
        <h3>来源已核验的候选</h3>
        <p>以下候选来自自动提取，等待正式记忆裁决。</p>
        {run.candidates.map(candidate => <article key={candidate.id}><p>{candidate.body}</p>
          <p>{candidate.scopeKind === 'self' ? '本人资料' : '联系人关系资料'} · 自动提取</p></article>)}
      </section>}
      <details><summary>查看本轮任务</summary>
        <p>固定目标 {run.inputs.filter(input => input.role === 'target').length} 项；有界前文 {run.inputs.filter(input => input.role === 'context').length} 项。</p>
        {run.tasks.map((task, index) => <article key={task.taskId}>
          <h3>{task.scopeKind === 'self' ? '本人贡献' : `联系人处理 ${index + 1}`}</h3>
          <p>已处理 {task.succeeded} / {task.total} 条文字目标</p>
          {task.errorCode && <p>本任务受阻，其他有效联系人可继续。</p>}
          <button type="button" disabled={busy} onClick={() => void readTrace(task.taskId)}>查看{task.scopeKind === 'self' ? '本人' : `联系人 ${index + 1}`}过程</button>
        </article>)}
      </details>
      {trace && <details open><summary>提取核验过程</summary>
        <p>此处展示本次实际输入、返回和来源记录。</p>
        {trace.calls.map(call => <p key={call.callId}>{call.purpose === 'extraction' ? '提取' : call.purpose === 'verification' ? '来源核验' : '模型调用'} · {{ prepared: '准备', sending: '已发送，等待回执', succeeded: '已知返回', failed: '失败', unknown: '结果未知' }[call.state]}</p>)}
        {trace.events.map(event => <details key={event.eventId}><summary>{event.kind}</summary><pre>{JSON.stringify(event.payload, null, 2)}</pre>
          <p>实际输入编号：{event.inputNos.join('、') || '无'}；实际参与来源 {event.sources.length} 项。</p></details>)}
      </details>}
    </>}
    <div className="memory-processing-actions">
      <button type="button" disabled={busy} onClick={() => void refresh.current()}>刷新处理状态</button>
      <button type="button" disabled={busy || !view || run?.state === 'running' || run?.state === 'pending'} onClick={() => void start()}>开始记忆处理</button>
      {run && ['pending', 'running'].includes(run.state) && <button type="button" disabled={busy} onClick={() => void control('pause')}>暂停记忆处理</button>}
      {canContinue && <button type="button" disabled={busy} onClick={() => void control('continue')}>继续原任务</button>}
    </div>
  </section>;
}
