import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { MemoryProcessing, MemoryProcessingControlAction, MemoryProcessingRequest, MemoryProcessingTask, MemoryProcessingUnit } from '../shared/memory-processing';

const names = { waiting: '等待处理', processing: '处理中', completed: '已完成', paused: '已暂停', blocked: '处理受阻' };
const phases = { extraction: '提取记忆', verification: '核验保存', topics: '整理主题', profile: '更新画像', retry: '等待自动重试' };
const taskNames = { import: '历史导入', observation: '聊天资料提取', layered_memory: '主题与画像整理' };
const taskStatuses: Record<string, string> = { queued: '等待执行', running: '执行中', verifying: '核验中', succeeded: '已完成',
  failed: '失败', cancelled: '已停止', paused: '原任务暂停', interrupted: '执行中断' };
const units: Record<MemoryProcessingUnit, string> = { messages: '条聊天', memories: '条记忆', steps: '个步骤' };
function quantity(processed: number | null, total: number | null, unit: MemoryProcessingUnit | null) {
  if (processed === null || unit === null) return null;
  return `已处理 ${processed}${total === null ? '' : ` / ${total}`} ${units[unit]}`;
}
function HistoryEntry({ task }: { task: MemoryProcessingTask }) {
  return <article>
    <h3>{taskNames[task.taskType]} · {taskStatuses[task.status] ?? '历史记录'}</h3>
    <p>{quantity(task.processedCount, task.totalCount, task.unit) ?? '暂无可靠处理量统计'}</p>
    <p className="memory-section-note">更新时间：{new Date(task.updatedAt).toLocaleString('zh-CN', { hour12: false })}</p>
    {task.attribution === 'legacy' && <p>旧记录的轮次归属尚无法核实，保留原结果，不据此自动继续。</p>}
    <p className="memory-section-note">任务编号：{task.taskId}</p>
    {task.reasonCode && <p className="memory-section-note">原始原因：{task.reasonCode}</p>}
  </article>;
}

type ProcessingProps = {
  request: MemoryProcessingRequest;
  onProgress?: () => Promise<void>;
  children?: ReactNode;
};
export function MemoryProcessingCard(props: Omit<ProcessingProps, 'request'> & { request?: MemoryProcessingRequest }) {
  return props.request ? <MemoryProcessingContent {...props} request={props.request}
    key={props.request.scope === 'owner' ? 'owner' : `${props.request.contactId}:${props.request.scopeRevision}`} /> : <>{props.children}</>;
}
function MemoryProcessingContent({ request, onProgress, children }: ProcessingProps) {
  const [value, setValue] = useState<MemoryProcessing | null>(null);
  const [history, setHistory] = useState<MemoryProcessingTask[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [error, setError] = useState('');
  const [resultError, setResultError] = useState('');
  const [actionError, setActionError] = useState('');
  const [acting, setActing] = useState<MemoryProcessingControlAction | null>(null);
  const [loading, setLoading] = useState(true);
  const [epoch, setEpoch] = useState(0);
  const active = useRef(false), historyReading = useRef(false), revision = useRef(0);
  const actionReading = useRef(false);
  const controlAttempt = useRef<{ action: MemoryProcessingControlAction; actionVersion: number; operationId: string } | null>(null);
  const refresh = useRef<(force?: boolean) => Promise<void>>(async () => {}), progressCallback = useRef(onProgress);
  progressCallback.current = onProgress;
  const scopeKey = request.scope === 'owner' ? 'owner' : `${request.contactId}:${request.scopeRevision}`;
  useEffect(() => window.notalone.memory.onProcessingInvalidated(event => {
    if (event.scope === 'contact' && request.scope === 'owner') return;
    revision.current++; active.current = false; actionReading.current = false; controlAttempt.current = null; setActing(null); setActionError('');
    setValue(null); setHistory([]); setNextCursor(null); setLoading(true); setHistoryLoading(false);
    setError(''); setHistoryError(''); setResultError(''); setEpoch(value => value + 1);
  }), [scopeKey]);
  useEffect(() => {
    let alive = true, timer: ReturnType<typeof setTimeout> | undefined, inFlight: Promise<void> | undefined;
    let signature: string | undefined, firstHistory: string | undefined;
    active.current = true;
    const read = (silent = false, force = false): Promise<void> => {
      if (actionReading.current && !force) return Promise.resolve();
      if (inFlight && !force) return inFlight;
      if (!alive || document.hidden) return Promise.resolve();
      if (!silent) setLoading(true);
      const operationRevision = revision.current;
      const operation = (async () => {
        try {
          const next = await window.notalone.memory.readProcessing(request);
          if (!alive || !active.current || operationRevision !== revision.current || document.hidden) return;
          setValue(next); setError('');
          const nextHistory = JSON.stringify(next.history);
          if (nextHistory !== firstHistory) { setHistory(next.history.entries); setNextCursor(next.history.nextCursor); setHistoryError(next.history.error ?? ''); firstHistory = nextHistory; }
          const nextSignature = JSON.stringify([next.controlGeneration, next.current]);
          if (signature !== undefined && signature !== nextSignature) {
            try { await progressCallback.current?.(); if (alive && active.current && operationRevision === revision.current) setResultError(''); }
            catch { if (alive && active.current && operationRevision === revision.current) setResultError('处理状态已更新，记忆内容暂未刷新；当前保留上次读取的资料。'); }
          }
          signature = nextSignature;
        } catch {
          if (alive && active.current && operationRevision === revision.current && !document.hidden) { setValue(null); setError('状态暂不可用'); }
        } finally { if (alive && active.current && operationRevision === revision.current) setLoading(false); }
      })();
      inFlight = operation;
      void operation.finally(() => {
        if (inFlight !== operation) return;
        inFlight = undefined;
        clearTimeout(timer);
        if (alive && !document.hidden) timer = setTimeout(() => void read(true), 2000);
      });
      return operation;
    };
    refresh.current = force => read(false, force);
    const visibility = () => {
      clearTimeout(timer);
      if (document.hidden) void window.notalone.memory.cancelProcessingRead(request).catch(() => {});
      else void read(true);
    };
    document.addEventListener('visibilitychange', visibility);
    void read();
    return () => {
      alive = false; active.current = false; revision.current++; historyReading.current = false; actionReading.current = false;
      clearTimeout(timer); document.removeEventListener('visibilitychange', visibility);
      void window.notalone.memory.cancelProcessingRead(request).catch(() => {});
    };
  }, [scopeKey, epoch]);
  async function control(action: MemoryProcessingControlAction) {
    if (!value || actionReading.current || loading || !value.current.actions.includes(action)) return;
    const currentRevision = ++revision.current;
    actionReading.current = true; setActing(action); setActionError('');
    historyReading.current = false; setHistoryLoading(false);
    if (controlAttempt.current?.action !== action || controlAttempt.current.actionVersion !== value.actionVersion) {
      controlAttempt.current = { action, actionVersion: value.actionVersion, operationId: crypto.randomUUID() };
    }
    const { actionVersion, operationId } = controlAttempt.current;
    try {
      const command = action === 'pause' ? window.notalone.memory.pauseProcessing : window.notalone.memory.continueProcessing;
      await command({ ...request, actionVersion, operationId });
      if (!active.current || currentRevision !== revision.current) return;
      controlAttempt.current = null;
    } catch {
      if (!active.current || currentRevision !== revision.current) return;
      setActionError('操作结果暂未确认，请核对最新状态后再操作。');
    } finally {
      if (active.current && currentRevision === revision.current) {
        // 接纳回执不代表业务完成；动作资格与主状态都重新取自权威读取。
        await refresh.current(true);
        if (active.current && currentRevision === revision.current) { actionReading.current = false; setActing(null); }
      }
    }
  }
  async function loadHistory(firstPage = false) {
    if ((!nextCursor && !firstPage) || historyReading.current) return;
    const currentRevision = revision.current;
    historyReading.current = true; setHistoryLoading(true); setHistoryError('');
    try {
      const page = await window.notalone.memory.readProcessingHistory({ ...request, cursor: firstPage ? null : nextCursor });
      if (!active.current || currentRevision !== revision.current) return;
      setHistory(previous => firstPage ? page.entries : [...previous, ...page.entries.filter(entry => !previous.some(existing => existing.taskId === entry.taskId))]);
      setNextCursor(page.nextCursor);
    } catch {
      if (active.current && currentRevision === revision.current) setHistoryError('处理历史暂时无法读取，请重试；当前处理状态保持不变。');
    } finally {
      if (active.current && currentRevision === revision.current) { historyReading.current = false; setHistoryLoading(false); }
    }
  }
  const current = value?.current;
  const count = current && quantity(current.processedCount, current.totalCount, current.unit);
  return <>
    <section className="memory-processing-card" aria-label="关系资料处理状态" aria-busy={loading || acting !== null}>
      <div className="memory-processing-bar">
        <div className="memory-processing-brief">
          <strong role={error ? 'alert' : 'status'}>{error || (current ? names[current.status] : '正在读取状态…')}</strong>
          {current?.phase && <span>{phases[current.phase]}</span>}
          {current?.reason && <span className="memory-section-note">{current.reason}</span>}
          {count && <span className="memory-processing-count">{count}</span>}
          {current?.pendingCount !== null && current?.pendingCount !== undefined && current.pendingCount > 0
            && <span className="memory-processing-count">另有 {current.pendingCount} 条聊天等待处理</span>}
        </div>
        <div className="memory-processing-actions">
          {current?.actions.map(action => <button key={action} className="button" disabled={loading || acting !== null}
            onClick={() => void control(action)}>{action === 'pause' ? '暂停处理' : '继续处理'}</button>)}
          <button className="button" disabled={loading || acting !== null} onClick={() => { setActionError(''); void refresh.current(); }}>刷新状态</button>
          <button className="memory-processing-details-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>{detailsOpen ? '收起详情' : '查看详情'}</button>
        </div>
      </div>
      {current?.hasUsableResults && ['blocked', 'paused'].includes(current.status) && <p>已保存的合法记忆与画像仍可查看和使用。</p>}
      {acting && <p role="status">正在确认{acting === 'pause' ? '暂停' : '继续'}操作，处理状态以重新读取为准。</p>}
      {actionError && <p role="alert">{actionError}</p>}
      {resultError && <p role="alert">{resultError}</p>}
      {detailsOpen && <div className="memory-processing-details">
        <p className="memory-section-note">记忆处理包括提取、核验、主题整理和画像更新；消息同步由同步设置单独管理。</p>
        {current?.roundId && <p className="memory-section-note">轮次编号：{current.roundId}</p>}
        {current?.reasonCode && <p className="memory-section-note">原始原因：{current.reasonCode}</p>}
        <details className="memory-disclosure memory-secondary memory-processing-history" aria-label="处理历史">
          <summary>处理历史</summary>
          {history.map(task => <HistoryEntry key={task.taskId} task={task} />)}
          {history.length === 0 && !historyError && <p>暂无处理历史。</p>}
          {historyError && <><p role="alert">{historyError}</p>
            {!nextCursor && <button className="button" disabled={historyLoading} onClick={() => void loadHistory(true)}>重新读取历史</button>}</>}
          {nextCursor && <button className="button" disabled={historyLoading} onClick={() => void loadHistory()}>{historyLoading ? '正在读取历史…' : '加载更多历史'}</button>}
        </details>
      </div>}
    </section>
    {children}
  </>;
}
