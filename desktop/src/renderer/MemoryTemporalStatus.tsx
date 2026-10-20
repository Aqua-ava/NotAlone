import { memoryDateText as dateText, memoryTimeText as timeText } from './memory-time-format';
import type { MemoryTiming } from '../shared/memory-bridge';


const labels = { current_verified: '来源支持明确适用期间', current_unverified: '是否仍适用，尚不确定',
  historical: '历史资料；不能据此认定当前情况', stable: '未指定期限的事实或偏好' };
export function MemoryTemporalStatus({ timing, validAt, invalidAt, snapshot = false, compact = false }: {
  timing: MemoryTiming; validAt?: string | null; invalidAt?: string | null; snapshot?: boolean; compact?: boolean;
}) {
  const start = timing.sourceStartedAt, end = timing.sourceEndedAt;
  return <div className="memory-temporal-status">
    <p>来源日期：{start && end ? `${dateText(start)}${dateText(start) === dateText(end) ? '' : ` 至 ${dateText(end)}`}` : '未知'}
      {!timing.sourceTimeComplete && '（来源日期不完整）'}</p>
    {(validAt || invalidAt) && <p>适用期间：{validAt ? timeText(validAt) : '起点未知'} 至 {invalidAt ? `${timeText(invalidAt)}之前` : '终点未知'}</p>}
    <p>{snapshot ? '生成时适用性' : '适用性'}：{labels[timing.currentStatus]}</p>
    {!compact && <p>{timing.currentStatusReason}</p>}
  </div>;
}
