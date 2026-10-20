import { memoryDateText, memoryTimeText as timeText } from './memory-time-format';
import type { MemoryEvent } from '../shared/memory-bridge';



export function MemoryEventDetails({ event }: { event?: MemoryEvent | null }) {
  const stageNames = { planned: '计划', agreed: '约定', rescheduled: '改期', cancelled: '取消', occurred: '已发生', unknown: '未知' };
  const precision = event?.occurrencePrecision;
  const calendarText = (value: string) => precision === 'year' ? `${value.slice(0, 4)}年`
    : precision === 'month' ? `${value.slice(0, 4)}年${Number(value.slice(5, 7))}月`
    : precision === 'day' ? memoryDateText(value) : timeText(value);
  const inclusiveEnd = (value: string) => {
    if (precision === 'year') return `${Number(value.slice(0, 4)) - 1}年`;
    if (precision === 'month') {
      const month = Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7)) - 2;
      return `${Math.floor(month / 12)}年${month % 12 + 1}月`;
    }
    const previousDay = new Date(Date.parse(`${value.slice(0, 10)}T00:00:00Z`) - 86_400_000).toISOString();
    return memoryDateText(previousDay);
  };
  // 部分日期以日历精度展示，计算区间的结束边界不是实际发生时刻。
  let period = '未知';
  if (event?.occurrenceStart) {
    const start = calendarText(event.occurrenceStart);
    if (['year', 'month', 'day'].includes(precision ?? '')) {
      const end = event.occurrenceEnd ? inclusiveEnd(event.occurrenceEnd) : start;
      period = end === start ? start : `${start} 至 ${end}`;
    } else if (!event.occurrenceEnd) {
      period = `${start}${event.version === 1 ? '；结束时间未知' : ''}`;
    } else {
      period = Date.parse(event.occurrenceStart) === Date.parse(event.occurrenceEnd)
        ? start : `${start} 至 ${calendarText(event.occurrenceEnd)}`;
    }
  }
  return <div className="memory-details" role="group" aria-label="事件信息">
    <p>事件阶段：{event ? stageNames[event.stage] : '未知'}（{event?.stageVerified ? '来源已核验' : '未核验'}）</p>
    <p>事件发生时段：{period}（{event?.occurrenceVerified ? '来源已核验' : '未核验'}）</p>
    {event?.version === 2 && <p>时间精度：{{ year: '年', month: '月', day: '日', instant: '具体时刻', unknown: '未知' }[precision ?? 'unknown']}
      {event.occurrenceExpression ? `；原话：${event.occurrenceExpression}` : ''}</p>}
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

