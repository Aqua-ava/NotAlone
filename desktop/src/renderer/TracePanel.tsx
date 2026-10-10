import { useEffect, useRef, useState } from 'react';
import type { TraceDocument, TraceRecordKind, TraceResource, TraceState } from '../shared/trace-bridge';
import type { ContactSessionView } from './contact-session';
import './traces.css';

const initial: TraceState = { revision: -1, contactId: null, scopeRevision: 0, resource: 'memory-traces', phase: 'idle',
  message: '', batches: [], nextBefore: null, availability: null, detail: null };
const resourceNames = { 'memory-traces': '记忆提取', 'source-processing-traces': '来源处理' };
const recordNames: Record<TraceRecordKind, string> = { message: '消息', candidate: '待确认候选', contact_memory: '联系人记忆',
  owner_memory: '本人记忆', source_document: '导入来源', local_wechat_observation: '微信观察来源', source_ref: '来源引用' };
const stages: Record<string, string> = { window: '实际输入窗口', model_request: '模型请求', provider_request: '供应商实际请求',
  model_response: '模型原始返回', provider_response: '供应商原始返回', candidate_raw: '原始候选', parse: '解析与字段转换',
  source_contract: '来源校验', timing: '时间处理', pragmatics: '语用判断', verification: '来源语义核验', adoption_gates: '采纳门槛',
  similarity: '相似旧记忆', adjudication: '新旧记忆裁决', write_plan: '计划写入', write_result: '实际写入',
  batch_end: '批次结束与水位', recovery_reconciliation: '重试核对', failure: '失败记录' };
const statuses: Record<string, string> = { succeeded: '成功', failed: '失败', running: '处理中', skipped: '已跳过',
  stopped: '已停止', trace_failed: '追踪写入失败', model_failed: '模型失败', business_failed: '业务写入失败', scope_invalidated: '范围失效',
  scope_guard_failed: '范围核对失败', recorded: '已记录', deleted: '已删除', partial: '部分完成' };

export function useTraceReading(session: ContactSessionView) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState('');
  const latest = useRef(initial);
  const active = useRef(true);
  const scope = useRef(session.state); scope.current = session.state;
  useEffect(() => {
    active.current = true;
    const receive = (next: TraceState) => {
      if (!active.current || next.revision < latest.current.revision) return;
      latest.current = next; setState(next);
    };
    const unsubscribe = window.notalone.traces.onStateChanged(receive);
    void window.notalone.traces.getState().then(receive).catch(() => setError('过程读取暂不可用。'));
    return () => { active.current = false; unsubscribe(); };
  }, []);
  useEffect(() => setError(''), [session.state.selectedContactId, session.state.scopeRevision]);
  async function perform(action: (contactId: string, scopeRevision: number) => Promise<void>) {
    const { selectedContactId, scopeRevision } = scope.current;
    if (!selectedContactId) return;
    setError('');
    try { await action(selectedContactId, scopeRevision); }
    catch {
      if (active.current && selectedContactId === scope.current.selectedContactId && scopeRevision === scope.current.scopeRevision) setError('过程范围或操作已变化，请重新读取。');
    }
  }
  const matches = state.contactId === session.state.selectedContactId && state.scopeRevision === session.state.scopeRevision;
  return { state: matches ? state : initial, error,
    list: (resource: TraceResource, older = false) => perform((contactId, scopeRevision) => window.notalone.traces.list({ contactId, scopeRevision, resource, older })),
    find: (resource: TraceResource, kind: TraceRecordKind, recordId: string) => perform((contactId, scopeRevision) => window.notalone.traces.find({ contactId, scopeRevision, resource, kind, recordId })),
    show: (resource: TraceResource, batchId: string) => perform((contactId, scopeRevision) => window.notalone.traces.show({ contactId, scopeRevision, resource, batchId })),
    remove: (resource: TraceResource, batchId: string) => perform((contactId, scopeRevision) => window.notalone.traces.remove({ contactId, scopeRevision, resource, batchId })),
  };
}
type TraceReading = ReturnType<typeof useTraceReading>;
function Snapshot({ title, value }: { title: string; value: unknown }) {
  return <details className="trace-snapshot"><summary>{title}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}
function TraceDetail({ detail, resource }: { detail: TraceDocument; resource: TraceResource }) {
  const rows = (resource === 'memory-traces' ? detail.events : detail.records) as TraceDocument[];
  const metadata = { ...detail }; delete metadata.events; delete metadata.records;
  for (const name of ['calls', 'links', 'write_receipts', 'candidates']) delete metadata[name];
  return <div aria-label="过程详情" role="group">
    <Snapshot title="批次、重试与执行状态" value={metadata} />
    {rows.map((row, index) => <Snapshot key={index} title={`${index + 1}. ${resource === 'memory-traces'
      ? stages[String(row.stage)] ?? `阶段：${String(row.stage)}` : `原始记录与规范化：${String(row.outcome)}`}`} value={row} />)}
    {resource === 'memory-traces' && <>
      <Snapshot title="模型调用与实际收据" value={detail.calls} /><Snapshot title="候选处理结果" value={detail.candidates} />
      <Snapshot title="记录关联" value={detail.links} /><Snapshot title="权威写入核对" value={detail.write_receipts} />
    </>}
  </div>;
}
export function TracePanel({ traces }: { traces: TraceReading }) {
  const { state } = traces;
  const [resource, setResource] = useState<TraceResource>('memory-traces');
  const [kind, setKind] = useState<TraceRecordKind>('message');
  const [recordId, setRecordId] = useState('');
  const [confirming, setConfirming] = useState(false);
  useEffect(() => { setConfirming(false); setRecordId(''); }, [state.contactId, state.scopeRevision]);
  useEffect(() => { setConfirming(false); }, [state.detail]);
  const kinds: TraceRecordKind[] = resource === 'memory-traces' ? ['message', 'candidate', 'contact_memory', 'owner_memory']
    : ['message', 'source_ref', 'source_document', 'local_wechat_observation'];
  const busy = state.phase === 'loading';
  const detailId = state.detail?.[state.resource === 'memory-traces' ? 'trace_id' : 'batch_id'];
  return <section className="memory-section trace-panel" aria-label="提取与来源处理过程">
    <header><div><h2>提取与来源处理过程</h2><p>主动查看当前联系人的已保存过程，包括没有形成记忆的批次。</p></div></header>
    <p>只展示当时保存的资料。模型返回的理由不等于内部推理；缺失的请求或历史不会事后补造。此页含敏感正文，当前存储未加密。</p>
    <div className="trace-controls">
      <label>过程类型<select aria-label="过程类型" value={resource} disabled={busy} onChange={(event) => {
        setResource(event.target.value as TraceResource); setKind('message');
      }}>{Object.entries(resourceNames).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
      <button className="button" disabled={busy} onClick={() => void traces.list(resource)}>查看批次列表</button>
    </div>
    <form className="trace-controls" aria-label="按记录查看过程" onSubmit={(event) => { event.preventDefault(); void traces.find(resource, kind, recordId); }}>
      <label>记录类型<select aria-label="记录类型" value={kind} disabled={busy} onChange={(event) => setKind(event.target.value as TraceRecordKind)}>
        {kinds.map((id) => <option key={id} value={id}>{recordNames[id]}</option>)}</select></label>
      <label>记录标识<input aria-label="记录标识" value={recordId} disabled={busy} onChange={(event) => setRecordId(event.target.value)} /></label>
      <button className="button" disabled={busy || !recordId.trim()} type="submit">查找记录过程</button>
    </form>
    {busy && <p role="status">正在读取或删除过程记录…</p>}
    {state.message && <p role={state.phase === 'error' ? 'alert' : 'status'}>{state.message}</p>}
    {traces.error && <p role="alert">{traces.error}</p>}
    {state.phase === 'ready' && <>
      <p>当前结果：{resourceNames[state.resource]}</p>
      {state.availability === 'not_recorded' && <p>这条资料没有已保存的过程记录。</p>}
      {state.availability === 'not_applicable' && <p>手动录入资料不适用模型提取过程。</p>}
      {state.availability === 'deleted' && <p>过程正文已删除，仅保留实际存在的状态与标识。</p>}
      {!state.batches.length && !state.availability && <p>当前联系人没有已保存的批次。</p>}
      <ul className="trace-batches" aria-label="过程批次">{state.batches.map((batch) => <li key={batch.batchId}>
        <span>{statuses[batch.status] ?? batch.status} · {new Date(batch.recordedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}（UTC+8）</span>
        <span>批次标识：{batch.batchId}</span>{batch.retryOf && <span>重试来源：{batch.retryOf}</span>}
        <button className="button" aria-label={`查看批次：${batch.batchId}`} onClick={() => void traces.show(state.resource, batch.batchId)}>查看详情</button>
      </li>)}</ul>
      {state.nextBefore && <button className="button" onClick={() => void traces.list(state.resource, true)}>读取更早批次</button>}
      {state.detail && <><TraceDetail detail={state.detail} resource={state.resource} />
        {state.availability === 'recorded' && typeof detailId === 'string' && <>
          <button className="button" onClick={() => setConfirming(true)}>删除这份过程记录</button>
          {confirming && <div role="group" aria-label="确认删除过程"><p>清除这份敏感过程正文，权威记忆仍保留。删除后不能恢复原请求与返回。</p>
            <button className="button" onClick={() => void traces.remove(state.resource, detailId)}>确认删除过程</button>
            <button className="button" onClick={() => setConfirming(false)}>取消删除过程</button></div>}
        </>}
      </>}
    </>}
  </section>;
}
