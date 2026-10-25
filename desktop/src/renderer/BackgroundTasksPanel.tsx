import { useEffect, useState } from 'react';
import type {
  BackgroundTask,
  BackgroundTaskSelection,
  BackgroundTaskState,
} from '../shared/background-task-bridge';

const initial: BackgroundTaskState = {
  phase: 'idle', scope: null, contactId: null, scopeRevision: 0, tasks: [], hasMore: false,
  error: null, busyTaskId: null, message: null,
};
const typeNames: Record<BackgroundTask['taskType'], string> = {
  import: '历史导入', observation: '聊天资料提取', delete: '来源删除',
  skill_learning: '经验整理', layered_memory: '主题与画像整理', memory_upgrade: '旧记忆升级（已退役）',
};
const statusNames: Record<BackgroundTask['status'], string> = {
  queued: '等待执行', running: '正在执行', verifying: '正在核验', succeeded: '已完成',
  failed: '失败', cancelled: '已停止', paused: '已暂停', interrupted: '执行已中断',
};
const stepNames: Record<string, string> = {
  parse: '读取导入', normalize: '规范化消息', extract_memory: '提取记忆', index: '重建索引',
  verify: '核验结果', mark_deleted: '标记来源失效', delete_derived: '清除派生资料',
  delete_index: '清除索引', clear_cache: '清除缓存', verify_not_retrievable: '核验不可检索',
  propose_skill: '整理经验草稿', verify_skill_drafts: '复核经验草稿',
  organize_memory: '整理主题与画像', preview_upgrade: '预检旧记忆升级',
  verify_upgrade_preview: '核验升级预检', apply_upgrade: '应用旧记忆升级',
  verify_upgrade_apply: '核验升级结果',
};

function reason(task: BackgroundTask): string | null {
  if (task.taskType === 'memory_upgrade') return '这类旧升级任务只保留历史状态，不会重新执行。';
  if (task.status === 'interrupted') return '没有有效执行租约或执行进程已退出；需要你明确恢复，系统不会自动领取。';
  if (task.status === 'paused') return '任务已暂停；继续时会核对当前资料范围、版本与剩余预算。';
  if (task.taskType === 'delete' && ['failed', 'interrupted'].includes(task.status)) {
    return task.errorCode ? `来源删除未完成（${task.errorCode}）；请在来源删除面板重试原删除。`
      : '来源删除未完成；请在来源删除面板核对后重试。';
  }
  if (task.errorCode === 'model_call_outcome_unknown') return '模型调用是否完成尚无法确定，恢复前必须核对原调用回执。';
  if (task.errorCode === 'model_configuration_unavailable') return '模型配置暂不可用，请在设置中核对后继续。';
  if (task.errorCode === 'task_stopped') return '任务已由你停止，迟到结果不能提交。';
  return task.errorCode ? `失败原因：${task.errorCode}` : null;
}

export function BackgroundTasksPanel({ selection }: { selection: BackgroundTaskSelection }) {
  const [state, setState] = useState(initial);
  const request = selection;
  const contactId = request.scope === 'contact' ? request.contactId : null;
  const scopeName = request.scope === 'owner' ? '本人' : '当前联系人';
  const selected = (next: BackgroundTaskState) => activeScope(next, request);
  useEffect(() => {
    let active = true;
    const receive = (next: BackgroundTaskState) => {
      if (active && selected(next)) setState(next);
    };
    const unsubscribe = window.notalone.backgroundTasks.onStateChanged(receive);
    void window.notalone.backgroundTasks.getState().then(receive);
    void window.notalone.backgroundTasks.read(request).catch(() => {});
    const visibility = () => {
      if (document.hidden) void window.notalone.backgroundTasks.cancelRead(request).catch(() => {});
      else void window.notalone.backgroundTasks.read(request).catch(() => {});
    };
    document.addEventListener('visibilitychange', visibility);
    return () => {
      active = false;
      unsubscribe();
      document.removeEventListener('visibilitychange', visibility);
      void window.notalone.backgroundTasks.cancelRead(request).catch(() => {});
    };
  }, [request.scope, contactId, request.scopeRevision]);

  const run = async (operation: () => Promise<void>) => {
    try { await operation(); } catch { /* 控制器发布可验证的持久状态错误。 */ }
  };
  const current = selected(state);
  const tasks = current ? state.tasks : [];
  return <section className="background-tasks-panel" aria-label={`${scopeName}后台任务`} aria-busy={state.phase === 'loading'}>
    <div className="background-tasks-heading">
      <div><h3>{scopeName}后台任务</h3><p>这里只显示该范围已保存的任务状态；刷新不会启动模型或扩大资料范围。</p></div>
      <button className="button" disabled={state.phase === 'loading' || !!state.busyTaskId}
        onClick={() => void run(() => window.notalone.backgroundTasks.read(request))}>刷新任务</button>
    </div>
    {!current || state.phase === 'loading' && tasks.length === 0
      ? <p role="status">正在读取后台任务…</p>
      : state.phase === 'error'
        ? <p role="alert">{state.error ?? '后台任务暂时无法读取。'}</p>
        : tasks.length === 0
          ? <p>{scopeName}范围没有后台任务。</p>
          : <div className="background-task-list">{tasks.map(task => <article key={task.taskId}>
            <div className="background-task-title">
              <strong>{typeNames[task.taskType]} · {statusNames[task.status]}</strong>
              <span>{task.processedCount} / {task.totalCount ?? '总量未知'}</span>
            </div>
            <p>当前步骤：{stepNames[task.phase] ?? task.phase} · 自动重试 {task.retryCount} 次</p>
            {task.totalCount !== null && <progress aria-label={`${typeNames[task.taskType]}处理进度`}
              value={task.processedCount} max={Math.max(1, task.totalCount)} />}
            {reason(task) && <p className={task.status === 'failed' ? 'background-task-error' : undefined}>{reason(task)}</p>}
            <details><summary>查看步骤与处理量</summary><ol>{task.steps.map(step => <li key={step.name}>
              {stepNames[step.name] ?? step.name}：{statusNames[step.status as BackgroundTask['status']] ?? step.status}
              {' · '}{step.processedCount} / {step.totalCount ?? '总量未知'} · 尝试 {step.attemptCount} 次
              {step.errorCode && ` · ${step.errorCode}`}
            </li>)}</ol></details>
            <div className="button-row">{task.actions.map(action => <button key={action.kind}
              className="button" disabled={!current || !!state.busyTaskId}
              onClick={() => void run(() => action.kind === 'stop'
                ? window.notalone.backgroundTasks.stop({ ...request, taskId: task.taskId })
                : window.notalone.backgroundTasks.recover({ ...request, taskId: task.taskId }))}>
              {action.kind === 'stop' ? '停止任务' : task.status === 'cancelled' ? '重新开始'
                : action.target === 'layered_memory' ? '继续整理' : '恢复原任务'}
            </button>)}</div>
          </article>)}</div>}
    {state.busyTaskId && <p role="status">正在提交任务操作…</p>}
    {state.phase === 'ready' && state.error && <p role="alert">{state.error}</p>}
    {state.message && <p role="status">{state.message}</p>}
    {state.hasMore && <p>仅显示最近 100 个任务。</p>}
  </section>;
}

function activeScope(state: BackgroundTaskState, selection: BackgroundTaskSelection): boolean {
  return state.scope === selection.scope && state.scopeRevision === selection.scopeRevision
    && (selection.scope === 'owner' ? state.contactId === null : state.contactId === selection.contactId);
}
