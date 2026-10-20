import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MemoryProcessing, MemoryProcessingRequest, MemoryProcessingTask } from '../shared/memory-processing';
import { MemoryList } from './MemoryList';
import { needsAttention, summarizeProcessing } from './memory-processing-summary';

const names = { queued: '等待生成记忆', extracting: '正在生成记忆', organizing: '正在整理记忆', completed: '本次处理完成',
  interrupted: '记忆生成已中断', failed: '记忆生成失败', stopped: '记忆生成已停止' };
function reason(task: MemoryProcessingTask) {
  if (task.reasonCode === 'model_configuration_unavailable') return '模型配置不可用，请在设置中核对后继续。';
  if (task.reasonCode === 'execution_resources_unavailable') return '执行资源暂不可用，请稍后继续。';
  if (task.reasonCode === 'processing_outcome_unknown') return '部分历史处理结果无法核实，请查看处理详情。';
  if (task.reasonCode === 'batches_skipped') return '部分批次未成功提取，已跳过；处理结束不代表全部聊天均已成功提取。';
  if (task.reasonCode === 'source_unavailable') return '来源已删除或不可用，无法继续此任务。';
  if (task.reasonCode === 'execution_interrupted') return '上次执行已中断，已保存的处理进度仍保留。';
  if (task.reasonCode === 'memory_extraction_failed') return '上次未能从聊天中生成记忆，具体原因未记录。';
  if (task.reasonCode === 'task_cancelled') return '任务已停止，重新开始会重新核对这次资料。';
  if (task.status === 'failed') return '后台未能完成处理，请核对配置或稍后继续。';
  return '';
}
function timestamp(value: string) { return new Date(value).toLocaleString('zh-CN', { hour12: false }); }
function TaskProgress({ task, historical = false }: { task: MemoryProcessingTask; historical?: boolean }) {
  return <>
    <p className="memory-processing-count">{task.processedCount === null ? (historical ? '旧记录，暂无统计' : '暂无进度统计')
      : task.totalCount === null ? `已处理 ${task.processedCount} 条聊天 · 总量暂不可用`
        : `已处理 ${task.processedCount} / ${task.totalCount} 条聊天`}</p>
    {!historical && task.processedCount !== null && task.totalCount !== null && task.totalCount > 0 &&
      <progress aria-label="聊天处理进度" value={task.processedCount} max={task.totalCount} />}
    {(task.createdCount !== null || task.updatedCount !== null) && <p>{[
      task.createdCount !== null ? `新增 ${task.createdCount} 条记忆` : null,
      task.updatedCount !== null ? `更新 ${task.updatedCount} 条记忆` : null,
    ].filter(Boolean).join(' · ')}</p>}
    <p className="memory-section-note">更新时间：{timestamp(task.updatedAt)}</p>
  </>;
}

type ProcessingProps = {
  request: MemoryProcessingRequest; contactNames: Record<string, string>;
  onProgress?: () => Promise<void>; children?: ReactNode;
};

export function MemoryProcessingCard(props: Omit<ProcessingProps, 'request'> & { request?: MemoryProcessingRequest }) {
  const request = props.request;
  return request ? <MemoryProcessingContent {...props} request={request}
    key={request.scope === 'owner' ? 'owner' : `${request.contactId}:${request.scopeRevision}`} /> : <>{props.children}</>;
}

function MemoryProcessingContent({ request, contactNames, onProgress, children }: ProcessingProps) {
  const [value, setValue] = useState<MemoryProcessing | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [resultError, setResultError] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const refresh = useRef<() => Promise<void>>(async () => {});
  const alive = useRef(true), busy = useRef(false), progressCallback = useRef(onProgress);
  progressCallback.current = onProgress;
  const scopeKey = request.scope === 'owner' ? 'owner' : `${request.contactId}:${request.scopeRevision}`;
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined, inFlight: Promise<void> | undefined, lastProgress: string | undefined;
    alive.current = true;
    const schedule = () => {
      clearTimeout(timer);
      if (active && !document.hidden && !busy.current) timer = setTimeout(() => void read(true), 2000);
    };
    const read = (silent = false): Promise<void> => {
      if (inFlight) return inFlight;
      if (!active || document.hidden || busy.current) return Promise.resolve();
      if (!silent) setLoading(true);
      const operation = (async () => {
        try {
          const next = await window.notalone.memory.readProcessing(request);
          if (!active || document.hidden) return;
          setValue(next); setError('');
          const signature = JSON.stringify(next.tasks.map(task => [task.taskId, task.status, task.processedCount, task.createdCount, task.updatedCount]));
          if (lastProgress !== undefined && lastProgress !== signature) {
            try { await progressCallback.current?.(); if (active) setResultError(''); }
            catch { if (active) setResultError('处理进度已更新，记忆内容暂未刷新；当前显示上次读取的资料。'); return; }
          }
          lastProgress = signature;
        } catch { if (active && !document.hidden) { setValue(null); setError('处理状态暂时读取失败，请刷新重试。'); } }
        finally { if (active) setLoading(false); }
      })();
      inFlight = operation;
      void operation.finally(() => { if (inFlight === operation) inFlight = undefined; schedule(); });
      return operation;
    };
    refresh.current = read;
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) void window.notalone.memory.cancelProcessingRead(request).catch(() => {});
      else void read(true);
    };
    document.addEventListener('visibilitychange', visibility);
    void read();
    return () => {
      active = false; alive.current = false; clearTimeout(timer); document.removeEventListener('visibilitychange', visibility);
      void window.notalone.memory.cancelProcessingRead(request).catch(() => {});
    };
  }, [scopeKey]);
  async function resume(selected: MemoryProcessingTask[]) {
    if (busy.current || selected.length === 0) return;
    busy.current = true; setWorking(true); setActionError('');
    try {
      // busy 阻止新查询；先等待已有查询完成，避免旧响应覆盖恢复后的状态。
      await refresh.current();
      for (const task of selected) {
        if (!alive.current) return;
        // 每次恢复都会使桥接层快照失效；逐项重读，且不恢复状态已变化的任务。
        const next = await window.notalone.memory.readProcessing(request);
        if (!alive.current) return;
        setValue(next);
        const current = next.tasks.find(item => item.taskId === task.taskId);
        if (current?.action && current.action === task.action) {
          await window.notalone.memory.resumeProcessing({ ...request, taskId: current.taskId, action: current.action });
        }
      }
    } catch { if (alive.current) setActionError('操作结果未确认，已重新读取状态；请核对后再试。'); }
    finally {
      busy.current = false;
      if (alive.current) { setWorking(false); await refresh.current(); }
    }
  }
  const tasks = value?.tasks ?? [];
  const currentTasks = tasks.filter(task => (task.status !== 'completed' && task.status !== 'stopped') || needsAttention(task));
  const history = tasks.filter(task => !currentTasks.includes(task));
  const overall = value ? summarizeProcessing(value) : null;
  const progress = tasks.length === 1 ? tasks[0] : null;
  const button = (task: MemoryProcessingTask) => task.action && <button className="button" disabled={working || loading}
    onClick={() => void resume([task])}>{working ? '提交中…' : task.action === 'restart' ? '重新开始' : '继续'}</button>;
  const summary = error ? '状态读取失败，请重试' : !value ? '正在读取状态…' : overall?.title;
  const refreshButton = <button className="button" disabled={loading || working} onClick={() => void refresh.current()}>刷新进度</button>;
  const taskEntry = (task: MemoryProcessingTask, historical = false) => <article key={task.taskId}>
    <h3>{task.taskType === 'import' ? '历史导入' : '同步聊天资料'} · {names[task.status]}</h3>
    {request.scope === 'owner' && <p className="memory-section-note">{contactNames[task.contactId] ?? '其他联系人'}的聊天</p>}
    <TaskProgress task={task} historical={historical} />
    {reason(task) && <p>{reason(task)}</p>}{button(task)}
  </article>;
  return <>
    {(tasks.length > 0 || value?.hasMore || !value || error || actionError || resultError) && <section className="memory-processing-card" aria-label="记忆处理状态" aria-busy={working}>
      <div className="memory-processing-bar">
        <div className="memory-processing-brief">{summary && <strong role={error || overall?.incomplete ? 'alert' : 'status'}>
          {summary}</strong>}
          {!error && overall && <span className="memory-section-note">{overall.note}</span>}
          {!error && progress?.processedCount !== null && progress?.processedCount !== undefined && <span className="memory-processing-count">
            {progress.totalCount === null ? `已处理 ${progress.processedCount} 条聊天` : `已处理 ${progress.processedCount} / ${progress.totalCount} 条聊天`}</span>}
        </div>
        <div className="memory-processing-actions">{!error && overall && overall.actions.length > 0 &&
          <button className="button" disabled={working || loading} onClick={() => void resume(overall.actions)}>
            {working ? '提交中…' : overall.actionLabel}</button>}
          <button className="memory-processing-details-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>{detailsOpen ? '收起' : '查看详情'}</button>
        </div>
      </div>
      {actionError && <p role="alert">操作未确认，请查看详情。</p>}
      {resultError && <p role="alert">内容暂未刷新，请查看详情。</p>}
      {detailsOpen && <div className="memory-processing-details">
        {refreshButton}
        {error && <p role="alert">{error}</p>}{actionError && <p>{actionError}</p>}{resultError && <p>{resultError}</p>}
        {currentTasks.length > 1 && <p className="memory-section-note">以下是各项处理记录；聊天资料可能重叠，进度不相加。</p>}
        {currentTasks.map(task => taskEntry(task))}
        {(history.length > 0 || value?.hasMore) && <details className="memory-disclosure memory-secondary memory-processing-history" aria-label="处理历史">
          <summary>处理历史{history.length > 0 ? `（${history.length}）` : ''}</summary>
          <div className="memory-processing-details">
            <p className="memory-section-note">这里记录聊天的处理结果，记忆内容在资料列表中。</p>
            <MemoryList items={history} label="处理历史" className="memory-processing-history-list">
              {task => taskEntry(task, true)}
            </MemoryList>
            {value?.hasMore && <p className="memory-section-note">仅显示最近记录，较早记录未列出。</p>}
          </div>
        </details>}
      </div>}
    </section>}
    {children}
  </>;
}
