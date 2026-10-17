import type { MemoryTiming } from '../shared/memory-bridge';

const labels = { current_verified: '当前已核实（来源支持当期区间）', current_unverified: '当前未核实',
  historical: '历史资料（已过期）', stable: '稳定事实或明确偏好' };
export function MemoryTemporalStatus({ timing, snapshot = false }: { timing: MemoryTiming; snapshot?: boolean }) {
  return <div className="memory-temporal-status">
    <p>{snapshot ? '生成时核实状态' : '当前核实状态'}：{labels[timing.currentStatus]}</p>
    <p>{timing.currentStatusReason}</p>
  </div>;
}
