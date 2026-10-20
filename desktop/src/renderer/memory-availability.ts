import type { MemoryVersion } from '../shared/memory-bridge';

// 展示可用状态，不把“可引用”冒充某次回复实际引用过。
export function memoryAvailability(memory: MemoryVersion, now = Date.now()) {
  if (memory.status === 'invalidated') return { excluded: true, label: '已失效 · 不再引用' };
  if (memory.invalidAt && Date.parse(memory.invalidAt) <= now) return { excluded: true, label: '已过期 · 不再引用' };
  if (memory.validAt && Date.parse(memory.validAt) > now) return { excluded: false, label: '尚未生效 · 暂不引用' };
  return { excluded: false, label: '有效记忆 · 可用于回复' };
}

// 只沿当前管理范围内唯一、完整的替代链找删除目标；合并或缺失关系交给后端拒绝，不猜测。
export function memoryRemovalTarget(memory: MemoryVersion, items: readonly MemoryVersion[]): MemoryVersion {
  const visited = new Set<string>();
  let target = memory;
  while (target.status === 'invalidated') {
    if (visited.has(target.memoryId)) return memory;
    visited.add(target.memoryId);
    const children = items.filter(item => item.level === memory.level && item.supersedesMemoryId === target.memoryId);
    if (children.length !== 1) return children.length === 0 ? target : memory;
    target = children[0];
  }
  return target;
}
