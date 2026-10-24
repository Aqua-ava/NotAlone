import { useEffect, useRef, useState } from 'react';
import type { UsageBridge, UsageDispatch, UsageOutcome, UsageState, UsageSummary } from '../shared/usage-bridge';
const dispatchLabels: Record<UsageDispatch, string> = { authorized_unconfirmed: '授权未确认', response_observed: '已观察响应',
  http_accepted: 'HTTP 已接纳', not_sent: '未发送', legacy_recorded: '历史已记录' };
const outcomeLabels: Record<UsageOutcome, string> = { pending: '进行中', succeeded: '成功', failed: '失败', cancelled: '已取消',
  unknown: '结果未知', run_failed: '运行失败', rejected_by_validation: '校验拒绝' };
const tokens = (value: number | null) => value === null ? '未知' : String(value);
export function UsageSummaryView({ summary }: { summary: UsageSummary }) {
  return <>
    <dl>
      <dt>已确认调用</dt><dd>{summary.totalCalls}</dd>
      <dt>授权未确认</dt><dd>{summary.authorizedUnconfirmedCalls}</dd>
      <dt>未发送尝试</dt><dd>{summary.notSentAttempts}</dd>
      <dt>全部记录</dt><dd>{summary.totalAttempts}</dd>
      <dt>输入 / 输出 token 总量</dt><dd>{tokens(summary.totalInputTokens)} / {tokens(summary.totalOutputTokens)}</dd>
      <dt>已知部分输入 / 输出 token</dt><dd>{summary.knownInputTokens} / {summary.knownOutputTokens}</dd>
      <dt>已确认调用中用量未知</dt><dd>{summary.unknownUsageCalls}</dd>
      <dt>已确认调用中费用未知</dt><dd>{summary.unknownCostCalls}</dd>
    </dl>
    <p>授权未确认仅表示取得调用许可，尚不能确认实际出站。未知用量和费用保留为未知。</p>
    <h3>已确认调用费用</h3>
    <p>按币种、价格版本和已知／估算状态分别列出；不合并不同口径，不计入授权未确认记录。</p>
    {summary.costTotals.length === 0 ? <p>暂无可汇总的已知或估算费用。</p> : <ul>{summary.costTotals.map((cost, index) =>
      <li key={index}>{cost.status === 'known' ? '已知' : '估算'} · {cost.currency} {cost.amount} · 价格版本 {cost.pricingVersion} · {cost.calls} 次</li>)}</ul>}
    <h3>供应商与结果（已确认调用）</h3>
    <ul>{Object.entries(summary.providerCounts).map(([provider, count]) => <li key={provider}>{provider}：{count}</li>)}</ul>
    <ul>{Object.entries(summary.outcomeCounts).map(([outcome, count]) => <li key={outcome}>{outcomeLabels[outcome as UsageOutcome] ?? '其他结果'}：{count}</li>)}</ul>
    <h3>最近记录（最多 10 条）</h3>
    {summary.recent.length === 0 ? <p>暂无调用记录。</p> : <ol>{summary.recent.map((entry, index) => <li key={index}>
      <p>{entry.scopeKind === 'owner_memory' ? '本人资料' : '联系人范围'} · {entry.provider} · {entry.modelName}</p>
      <p><time dateTime={entry.calledAt}>{entry.calledAt}</time> · {entry.latencyMs === null ? '耗时未知' : `${entry.latencyMs} ms`}
        {' · '}{dispatchLabels[entry.dispatch]} · {outcomeLabels[entry.outcome]} · {entry.source === 'legacy' ? '历史记录' : '物理调用回执'}</p>
      <p>输入 / 输出 token：{tokens(entry.inputTokens)} / {tokens(entry.outputTokens)}；
        供应商缓存读取 / 写入 token：{tokens(entry.cacheReadTokens)} / {tokens(entry.cacheWriteTokens)}</p>
      <p>费用：{!entry.confirmed || entry.costStatus === 'unknown' ? '未知' :
        `${entry.costStatus === 'estimated' ? '估算' : '已知'} ${entry.currency} ${entry.costAmount}（价格版本 ${entry.pricingVersion}）`}</p>
    </li>)}</ol>}
    <p>供应商缓存 token 是调用用量的一部分。业务缓存未调用模型时，不新增模型费用。</p>
  </>;
}
export function UsagePanel({ bridge = window.notalone.usage }: { bridge?: UsageBridge }) {
  const [state, setState] = useState<UsageState>({ revision: -1, phase: 'idle', summary: null, errorCode: null });
  const [error, setError] = useState(false), latest = useRef(-1), active = useRef(false);
  async function refresh() {
    try { await bridge.refresh(); if (active.current) setError(false); }
    catch { if (active.current) setError(true); }
  }
  useEffect(() => {
    active.current = true; latest.current = -1;
    const receive = (next: UsageState) => {
      if (!active.current || next.revision <= latest.current) return;
      latest.current = next.revision; setState(next); setError(false);
    };
    const unsubscribe = bridge.onStateChanged(receive);
    void bridge.getState().then(receive).catch(() => { if (active.current) setError(true); });
    void refresh();
    return () => { active.current = false; unsubscribe(); };
  }, [bridge]);
  return <section className="startup-settings" aria-label="模型用量与调用记录">
    <h2>模型用量与调用记录</h2>
    <p>当前账号的调用台账，包含联系人及本人资料范围；仅显示用量与结果。</p>
    <button className="button" disabled={state.phase === 'loading'} onClick={() => void refresh()}>
      {state.phase === 'loading' ? '正在读取…' : '刷新用量'}</button>
    {(error || state.phase === 'error') && <p role="alert">用量读取失败，请刷新重试。刷新只读取台账，不会重新调用模型。</p>}
    {state.phase === 'offline' && <p role="status">本机服务尚未连接，连接后可刷新用量。</p>}
    {state.phase === 'ready' && state.summary && <UsageSummaryView summary={state.summary} />}
  </section>;
}
