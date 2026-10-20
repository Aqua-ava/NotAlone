import { memoryTimeText as timeText } from './memory-time-format';
import type { MemoryEvent } from '../shared/memory-bridge';



export function MemoryEventDetails({ event }: { event?: MemoryEvent | null }) {
  const stageNames = { planned: '计划', agreed: '约定', rescheduled: '改期', cancelled: '取消', occurred: '已发生', unknown: '未知' };
  const period = !event?.occurrenceStart ? '未知' : !event.occurrenceEnd
    ? `${timeText(event.occurrenceStart)}；结束时间未知`
    : Date.parse(event.occurrenceStart) === Date.parse(event.occurrenceEnd) ? timeText(event.occurrenceStart)
      : `${timeText(event.occurrenceStart)} 至 ${timeText(event.occurrenceEnd)}`;
  return <div className="memory-details" role="group" aria-label="事件信息">
    <p>事件阶段：{event ? stageNames[event.stage] : '未知'}（{event?.stageVerified ? '来源已核验' : '未核验'}）</p>
    <p>事件发生时段：{period}（{event?.occurrenceVerified ? '来源已核验' : '未核验'}）</p>
    <p>阶段与发生时段分别核验；计划或约定的时间仍表示安排，时间到期不会自动标记已发生。</p>
    <details><summary>查看事件来源依据</summary>
    <p>阶段依据：{event?.stageEvidence.length ? '' : '未知'}</p>
    {event && event.stageEvidence.length > 0 && <ul aria-label="阶段依据">{event.stageEvidence.map((entry, index) =>
      <li key={index}>消息引用：{entry.messageId} · 字符 {entry.charStart} 至 {entry.charEnd}</li>)}</ul>}
    <p>发生时段依据：{event?.occurrenceEvidence.length ? '' : '未知'}</p>
    {event && event.occurrenceEvidence.length > 0 && <ul aria-label="发生时段依据">{event.occurrenceEvidence.map((entry, index) =>
      <li key={index}>消息引用：{entry.messageId} · 字符 {entry.charStart} 至 {entry.charEnd}</li>)}</ul>}
    </details>
  </div>;
}

