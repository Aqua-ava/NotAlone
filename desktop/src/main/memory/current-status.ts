import type { MemoryCurrentStatus } from '../../shared/memory-bridge';

const allowed = ['current_verified', 'current_unverified', 'historical', 'stable'];
export function readCurrentStatus(timing: Record<string, unknown>): { currentStatus: MemoryCurrentStatus; currentStatusReason: string } {
  if (timing.current_status === undefined && timing.current_status_reason === undefined) {
    return { currentStatus: 'current_unverified', currentStatusReason: '旧快照未记录当时适用性；不以当前资料补填。' };
  }
  if (typeof timing.current_status !== 'string' || !allowed.includes(timing.current_status)
    || typeof timing.current_status_reason !== 'string' || !timing.current_status_reason.trim()
    || timing.current_status_reason.length > 4096) throw new Error('适用性状态格式无效。');
  return { currentStatus: timing.current_status as MemoryCurrentStatus, currentStatusReason: timing.current_status_reason };
}
