type Response = { status: number; data: Record<string, unknown> };

// GET批次返回status；availability属于记录查找与删除回执，不能混用。
export function assertOwnerTraceErased(owner: Response, trace: Response, memoryId: string) {
  const memories = owner.data.memories;
  const noBody = ['events', 'calls', 'candidates'].every((key) =>
    Array.isArray(trace.data[key]) && (trace.data[key] as unknown[]).length === 0);
  if (owner.status !== 200 || !Array.isArray(memories) || JSON.stringify(memories).includes(memoryId)
      || trace.status !== 200 || trace.data.status !== 'deleted' || !noBody) {
    throw new Error('本人记忆删除或提取过程正文清理未收口。');
  }
  return { owner_memory_deleted: true, trace_status: trace.data.status, trace_body_arrays_empty: true };
}
