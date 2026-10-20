import type { MemoryProcessing, MemoryProcessingTask } from '../shared/memory-processing';

const attentionReasons = new Set([
  'model_configuration_unavailable', 'execution_resources_unavailable', 'source_unavailable',
  'batches_skipped', 'processing_outcome_unknown', 'memory_extraction_failed',
]);

export function needsAttention(task: MemoryProcessingTask) {
  return task.reasonCode === 'source_unavailable'
    || (task.status !== 'stopped' && (task.status === 'failed' || task.status === 'interrupted'
      || attentionReasons.has(task.reasonCode ?? '')));
}

/** 汇总同一读取范围内的任务；消息可能跨任务重叠，不能相加作为整体进度。 */
export function summarizeProcessing(value: MemoryProcessing) {
  const tasks = value.tasks;
  if (tasks.length === 0 && !value.hasMore) return null;
  const active = tasks.some(task => task.status === 'extracting' || task.status === 'organizing');
  const waiting = tasks.some(task => task.status === 'queued');
  const attention = tasks.filter(needsAttention);
  const stopped = tasks.filter(task => task.status === 'stopped');
  const resumable = attention.filter(task => task.action === 'resume');
  if (attention.length > 0) return {
    title: '记忆处理需要继续',
    note: attention.every(task => task.reasonCode === 'source_unavailable')
      ? active ? '部分聊天仍在处理，另有部分来源已不可用。请查看详情。'
        : '部分聊天来源已不可用，无法继续对应处理。请查看详情。'
      : active ? '部分聊天仍在处理，另有部分未完成，请查看详情。'
      : attention.some(task => (task.processedCount ?? 0) > 0)
        ? '部分聊天未完成记忆提取，已保存处理进度。'
        : '部分聊天未完成记忆提取，请查看详情后继续处理。',
    actions: resumable, actionLabel: '继续处理',
  };
  if (active) return { title: '正在处理记忆', note: '正在从聊天资料生成或整理记忆。', actions: [], actionLabel: '' };
  if (waiting) return { title: '等待处理', note: '待处理资料已排队，等待后台执行。', actions: [], actionLabel: '' };
  if (stopped.length > 0) return {
    title: '记忆处理已停止', note: stopped.some(task => task.action === 'restart')
      ? '部分资料的处理已停止，可重新开始。' : '资料处理已停止，请查看详情。',
    actions: stopped.filter(task => task.action === 'restart'), actionLabel: '重新开始',
  };
  if (value.hasMore) return {
    title: '状态读取不完整', note: '较早的处理记录未完整读取，暂时无法确认整体状态。',
    actions: [], actionLabel: '', incomplete: true,
  };
  return { title: '记忆处理已完成', note: '当前任务均已处理结束；并非每条聊天都会生成记忆。', actions: [], actionLabel: '' };
}
