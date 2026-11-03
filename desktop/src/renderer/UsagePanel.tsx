import { useEffect, useRef, useState } from 'react';
import type { UsageBridge, UsageDispatch, UsageOutcome, UsageState, UsageSummary } from '../shared/usage-bridge';
const dispatchLabels: Record<UsageDispatch, string> = { authorized_unconfirmed: '授权未确认', response_observed: '已观察响应',
  http_accepted: 'HTTP 已接纳', not_sent: '未发送', legacy_recorded: '历史已记录' };
const outcomeLabels: Record<UsageOutcome, string> = { pending: '进行中', succeeded: '成功', failed: '失败', cancelled: '已取消',
  unknown: '结果未知', run_failed: '运行失败', rejected_by_validation: '校验拒绝' };
const numberFormat = new Intl.NumberFormat('zh-CN');
const tokens = (value: number | null) => value === null ? '未知' : numberFormat.format(value);
const timeFormat = new Intl.DateTimeFormat('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});
function readableTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : timeFormat.format(date);
}
function outcomeTone(outcome: string) {
  if (outcome === 'succeeded') return 'success';
  if (['failed', 'run_failed', 'rejected_by_validation'].includes(outcome)) return 'warning';
  return 'neutral';
}
export function UsageSummaryView({ summary }: { summary: UsageSummary }) {
  const partialUsage = summary.totalInputTokens === null || summary.totalOutputTokens === null;
  // 仅合并展示名称；原始台账和最近记录保留各调用路径的供应商标识。
  const providerCounts = new Map<string, number>();
  for (const [provider, count] of Object.entries(summary.providerCounts)) {
    const name = provider === 'deepseek' || provider === 'notalone-deepseek' ? 'DeepSeek' : provider;
    providerCounts.set(name, (providerCounts.get(name) ?? 0) + count);
  }
  return <div className="usage-summary">
    <dl className="usage-stats">
      <div className="usage-stat usage-stat-primary"><dt>已确认调用</dt><dd>{tokens(summary.totalCalls)}<small>次</small></dd><p>已确认请求发出，包含成功与失败</p></div>
      <div className="usage-stat"><dt>授权未确认</dt><dd>{tokens(summary.authorizedUnconfirmedCalls)}<small>次</small></dd><p>已获许可，尚未确认是否发出</p></div>
      <div className="usage-stat"><dt>未发送尝试</dt><dd>{tokens(summary.notSentAttempts)}<small>次</small></dd><p>准备调用，但请求未发出</p></div>
    </dl>
    <p className="usage-footnote">全部记录 {tokens(summary.totalAttempts)} 条 · 以下用量与费用仅统计已确认调用</p>

    <div className="usage-columns">
      <section className="usage-card" aria-label="Token 用量">
        <div className="usage-section-heading"><h3>Token 用量</h3><span className="usage-badge">{partialUsage ? '部分已知' : '完整用量'}</span></div>
        <p className="usage-caption">AI 读入与生成文字的计量单位</p>
        <dl className="usage-token-pair">
          <div><dt>输入{summary.totalInputTokens === null ? ' · 已知部分' : ' · 总量'}</dt><dd>{tokens(summary.totalInputTokens ?? summary.knownInputTokens)}</dd></div>
          <div><dt>输出{summary.totalOutputTokens === null ? ' · 已知部分' : ' · 总量'}</dt><dd>{tokens(summary.totalOutputTokens ?? summary.knownOutputTokens)}</dd></div>
        </dl>
      </section>
      <section className="usage-card" aria-label="已确认调用费用">
        <div className="usage-section-heading"><h3>已确认调用费用</h3><span className="usage-badge">{summary.costTotals.length === 0 ? '暂无费用数据' : '分组汇总'}</span></div>
        {summary.costTotals.length === 0 ? <div className="usage-cost-empty"><strong>费用未知</strong><p>尚无可汇总的费用数据，未知不代表免费。</p></div> :
          <ul className="usage-cost-list">{summary.costTotals.map((cost, index) => <li key={index}>
            <div><strong>{cost.currency} {cost.amount}</strong><span className="usage-badge">{cost.status === 'known' ? '已知' : '估算'}</span></div>
            <p>价格版本 {cost.pricingVersion} · {tokens(cost.calls)} 次调用</p>
          </li>)}</ul>}
      </section>
    </div>

    <section className="usage-breakdown" aria-label="供应商与结果（已确认调用）">
      <div><h3>供应商分布</h3><ul className="usage-provider-list">{Array.from(providerCounts, ([provider, count]) => <li key={provider}>
        <div><span>{provider}</span><strong>{tokens(count)}<small> 次</small></strong></div>
        <div className="usage-provider-track" aria-hidden="true"><span style={{ width: `${summary.totalCalls > 0 ? Math.min(100, count / summary.totalCalls * 100) : 0}%` }} /></div>
      </li>)}</ul>{providerCounts.size === 0 && <p className="usage-caption">暂无已确认调用。</p>}</div>
      <div><h3>调用结果</h3><ul className="usage-outcomes">{Object.entries(summary.outcomeCounts).map(([outcome, count]) =>
        <li key={outcome}><span className={`usage-badge usage-badge-${outcomeTone(outcome)}`}>{outcomeLabels[outcome as UsageOutcome] ?? '其他结果'}</span><strong>{tokens(count)}</strong></li>)}</ul>
        {Object.keys(summary.outcomeCounts).length === 0 && <p className="usage-caption">暂无调用结果。</p>}</div>
    </section>

    <section className="usage-recent" aria-label="最近记录">
      <div className="usage-section-heading"><h3>最近记录</h3><span className="usage-caption">最多 10 条 · 时间为本机时区</span></div>
      {summary.recent.length === 0 ? <p className="usage-empty">暂无调用记录，使用 AI 后会显示在这里。</p> : <ol className="usage-records">{summary.recent.map((entry, index) => <li key={index}>
        <details className="usage-record"><summary>
          <span className="usage-record-main"><strong>{entry.modelName}</strong><span>{entry.provider} · {entry.scopeKind === 'owner_memory' ? '本人资料' : '联系人范围'}</span></span>
          <span className="usage-record-time"><time dateTime={entry.calledAt} title={entry.calledAt}>{readableTime(entry.calledAt)}</time><span>{entry.latencyMs === null ? '耗时未知' : `${(entry.latencyMs / 1000).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} 秒`}</span></span>
          <span className={`usage-badge usage-badge-${outcomeTone(entry.outcome)}`}>{outcomeLabels[entry.outcome]}</span>
          <span className="usage-record-chevron" aria-hidden="true">⌄</span>
        </summary>
          <dl className="usage-detail-grid">
            <div><dt>发送证据</dt><dd>{dispatchLabels[entry.dispatch]}</dd></div>
            <div><dt>精确耗时</dt><dd>{entry.latencyMs === null ? '未知' : `${tokens(entry.latencyMs)} ms`}</dd></div>
            <div><dt>记录来源</dt><dd>{entry.source === 'legacy' ? '历史记录' : '物理调用回执'}</dd></div>
            <div><dt>输入 / 输出 token</dt><dd>{tokens(entry.inputTokens)} / {tokens(entry.outputTokens)}</dd></div>
            <div><dt>供应商缓存读取 / 写入 token</dt><dd>{tokens(entry.cacheReadTokens)} / {tokens(entry.cacheWriteTokens)}</dd></div>
            <div><dt>费用</dt><dd>{!entry.confirmed || entry.costStatus === 'unknown' ? '未知' : `${entry.costStatus === 'estimated' ? '估算' : '已知'} ${entry.currency} ${entry.costAmount}（价格版本 ${entry.pricingVersion}）`}</dd></div>
            <div><dt>调用时间</dt><dd><time dateTime={entry.calledAt}>{entry.calledAt}</time></dd></div>
          </dl>
        </details>
      </li>)}</ol>}
    </section>
  </div>;
}
export function UsagePanel({ bridge = window.notalone.usage, active = true }: { bridge?: UsageBridge; active?: boolean }) {
  const [state, setState] = useState<UsageState>({ revision: -1, phase: 'idle', summary: null, errorCode: null });
  const [error, setError] = useState(false), latest = useRef(-1), mounted = useRef(false);
  async function refresh() {
    try { await bridge.refresh(); if (mounted.current) setError(false); }
    catch { if (mounted.current) setError(true); }
  }
  useEffect(() => {
    mounted.current = true; latest.current = -1;
    const receive = (next: UsageState) => {
      if (!mounted.current || next.revision <= latest.current) return;
      latest.current = next.revision; setState(next); setError(false);
    };
    const unsubscribe = bridge.onStateChanged(receive);
    void bridge.getState().then(receive).catch(() => { if (mounted.current) setError(true); });
    return () => { mounted.current = false; unsubscribe(); };
  }, [bridge]);
  // 隐藏时保留快照和失效订阅；再次显示才发起只读后台更新。
  useEffect(() => { if (active) void refresh(); }, [bridge, active]);
  return <section className="usage-panel" aria-label="模型用量与调用记录">
    <header className="usage-header"><div><h2>模型用量与调用记录</h2>
    <p>当前账号 · 联系人及本人资料范围</p></div>
    <button className="button" disabled={state.phase === 'loading'} onClick={() => void refresh()}>
      {state.phase === 'loading' && !state.summary ? '正在读取…' : '刷新用量'}</button></header>
    {(error || state.phase === 'error') && <p role="alert">用量读取失败，请刷新重试。刷新只读取台账，不会重新调用模型。</p>}
    {state.phase === 'offline' && <p role="status">当前暂时无法读取用量。</p>}
    {state.summary && <UsageSummaryView summary={state.summary} />}
  </section>;
}
