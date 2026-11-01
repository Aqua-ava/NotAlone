import { useEffect, useRef, useState } from 'react';
import type { FixedMemoryProcessingBridge, FixedProcessingRun, FixedProcessingView, FixedProcessingQueue } from '../shared/fixed-memory-processing';

const sharedReasons: Record<string, string> = {
  extraction_model_unconfigured: '模型尚未配置',
  extraction_model_configuration_invalid: '模型配置无效',
  extraction_model_credentials_unavailable: '模型凭据不可用',
  extraction_model_authentication_failed: '模型认证失败',
  extraction_model_provider_unavailable: '模型服务暂不可用',
  extraction_model_scope_invalid: '模型用途范围不可用',
  memory_extraction_model_configuration_invalid: '模型配置无效',
  document_model_unconfigured: '模型尚未配置',
  document_model_configuration_invalid: '模型配置无效',
  document_model_credentials_unavailable: '模型凭据不可用',
  document_model_scope_invalid: '模型用途范围不可用',
};
const blockedReasons: Record<string, string> = {
  model_receipt_unknown: '调用结果待核实',
  interrupted_known_receipts: '上次处理已中断，已完成的进度已保留',
  run_revoked: '范围已失效',
  scope_revoked: '范围已失效',
  later_stages_pending: '提取核验已结束',
  later_stages_failed: '主题整理或长期概览阶段受阻',
  owner_contribution_pending: '本人资料阶段因范围变化未提交，需要新一轮处理',
  contact_failed: '部分联系人处理受阻',
  round_failed: '本轮处理受阻',
  round_incomplete: '本轮尚未完成',
  no_pending_inputs: '当前没有待处理的文字目标',
};
/** 固定原因码由后端给出；界面只做固定文案映射，不把历史失败或数量换算成完成。 */
function reasonText(reason: string | null): string {
  if (!reason) return '处理暂时受阻';
  if (blockedReasons[reason]) return blockedReasons[reason];
  if (sharedReasons[reason]) return `模型配置或服务不可用：${sharedReasons[reason]}。`;
  return '处理暂时受阻';
}
function stageText(run: FixedProcessingRun): string {
  if (run.stage === 'document_scene') return '正在整理主题资料';
  if (run.stage === 'document_profile') return '正在整理长期概览';
  if (run.stage !== 'extraction_verification') return '正在处理后续阶段';
  return '正在提取与核验';
}
function statusText(run: FixedProcessingRun | null, queue?: FixedProcessingQueue): string {
  if (!run) return '等待处理';
  if (run.status === 'paused') return '已暂停';
  if (run.status === 'blocked') return '处理受阻';
  if (run.status === 'completed') {
    if(queue?.pending)return '等待提取与核验';
    if(queue?.later?.pending)return queue.later.stage==='document_profile'?'等待更新长期概览':queue.later.stage==='document_scene'?'等待整理主题资料':'后续阶段待处理';
    return '本轮已完成';
  }
  if (run.status === 'processing') return stageText(run);
  if (run.statusReason === 'later_stages_scheduled') return run.stage === 'document_profile' ? '等待更新长期概览' : '等待整理主题资料';
  return run.total === 0 ? '当前没有待处理的文字目标' : '等待提取与核验';
}

/** 由记忆页面传入具名桥；scopeKey变化或失效事件先撤下全部本地快照。 */
export function FixedMemoryProcessingPanel({ bridge, scopeKey = '', onRunUpdated }: { bridge: FixedMemoryProcessingBridge; scopeKey?: string | number; onRunUpdated?:(run:FixedProcessingRun|null)=>void }) {
  const [snapshot, setSnapshot] = useState<{ bridge: FixedMemoryProcessingBridge; scopeKey: string | number; view: FixedProcessingView } | null>(null);
  const [error, setError] = useState('');
  const updated = useRef(onRunUpdated);
  updated.current = onRunUpdated;
  const view = snapshot?.bridge === bridge && snapshot.scopeKey === scopeKey ? snapshot.view : null;
  useEffect(() => {
    let active = true, revision = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setSnapshot(null); setError('');
    const schedule = (delay: number) => {
      clearTimeout(timer);
      if (active && !document.hidden) timer = setTimeout(() => void read(), delay);
    };
    const read = async () => {
      clearTimeout(timer);
      const accepted = ++revision;
      try {
        const next = await bridge.readCurrent();
        if (!active || accepted !== revision) return;
        setSnapshot({ bridge, scopeKey, view: next }); setError('');
        updated.current?.(next.run);
        schedule(next.run?.status === 'processing' ? 2000 : 10000);
      } catch {
        if (!active || accepted !== revision) return;
        setSnapshot(null); setError('处理状态暂不可用，正在自动重试。');
        schedule(10000);
      }
    };
    const unsubscribe = bridge.onInvalidated(() => {
      revision++; setSnapshot(null);
      setError('资料资格或连接已变化，正在重新核对处理状态。');
      schedule(2000);
    });
    const visible = () => {
      if (document.hidden) clearTimeout(timer);
      else void read();
    };
    document.addEventListener('visibilitychange', visible);
    void read();
    return () => {
      active = false; revision++; clearTimeout(timer); unsubscribe();
      document.removeEventListener('visibilitychange', visible);
      void bridge.release().catch(() => {});
    };
  }, [bridge, scopeKey]);
  const run = view?.run ?? null;
  const allTargetsDone = run && run.total > 0 && run.succeeded === run.total && run.pending === 0;
  const noNewMemory = allTargetsDone && run.candidates.length === 0
    && run.tasks.length > 0 && run.tasks.every(task => ['succeeded', 'awaiting_decision'].includes(task.state));
  return <section className="memory-processing-card fixed-memory-processing" aria-label="固定范围记忆处理">
    <header className="memory-processing-bar"><h2>记忆处理</h2>
      {view && <p role="status">{statusText(run,view.queue)}</p>}
    </header>
    <p className="memory-section-note">全部已确认读取范围的后台队列，以及最近一轮提取进度</p>
    {error && <p role="alert">{error}</p>}
    {!view && !error && <p aria-live="polite">正在核对处理状态…</p>}
    {view && !run && <><p>暂无处理记录</p><p>新增文字会先积累，在会话静默或达到批量条件后自动处理；已有历史单独初始化。</p></>}
    {view?.queue && view.queue.pending > 0 && <p>新增待提取文字 {view.queue.pending} 条。{view.queue.nextDueAt != null ? `预计 ${new Date(view.queue.nextDueAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 检查批量条件。` : ''}{view.queue.blockedContacts > 0 ? '部分联系人已暂停或受阻，待处理文字会保留。' : ''}</p>}
    {view?.queue?.later && view.queue.later.pending > 0 && <p>主题与长期概览仍有 {view.queue.later.pending} 项待处理。{view.queue.later.nextDueAt != null && run?.statusReason !== 'later_stages_scheduled' ? `预计 ${new Date(view.queue.later.nextDueAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 继续。` : ''}</p>}
    {run && <>
      {run.status === 'blocked' && <p>{reasonText(run.statusReason)}</p>}
      {run.statusReason === 'later_stages_scheduled' && run.nextDueAt != null && <p>预计 {new Date(run.nextDueAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 开始，执行前会重新核对资料。</p>}
      <p>提取与核验：已处理 {run.succeeded} / {run.total} 条文字目标</p>
      {run.total > 0 && <progress className="memory-processing-progress" aria-label="文字提取与核验进度" max={run.total} value={run.succeeded}/>}
      {run.pending > 0 && <p>待处理 {run.pending} 条文字目标</p>}
      {run.revoked > 0 && <p>有 {run.revoked} 条目标因取消勾选或来源删除失效，不计入待处理。</p>}
      {noNewMemory && <p>已处理，未产生新记忆</p>}
      {run.failed > 0 && <p>有 {run.failed} 条目标尚未通过提取核验。</p>}
      {run.unknown > 0 && <p>有 {run.unknown} 条目标调用结果未知，核实前不会重新发送。</p>}
      {run.sharedFaultCode && run.sharedFaultCode !== run.statusReason && <p>模型配置或服务不可用：{sharedReasons[run.sharedFaultCode] ?? '通用模型故障'}。</p>}
      {run.laterStages==='completed'?<p>主题整理与长期概览已完成。</p>:<p>主题整理、长期概览尚未全部完成。</p>}
    </>}
  </section>;
}
