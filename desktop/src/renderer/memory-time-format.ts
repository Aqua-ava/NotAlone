// 按记录携带的时区显示日期，不让当前设备时区改变原话的日历日期。
export function memoryDateText(value: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  return parts ? `${parts[1]}年${Number(parts[2])}月${Number(parts[3])}日` : value;
}

export function memoryTimeText(value: string | null): string {
  if (!value) return '未知';
  const parts = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!parts) return value;
  const offset = parts[2] === 'Z' ? '' : `${parts[3]}${Number(parts[4])}${parts[5] === '00' ? '' : `:${parts[5]}`}`;
  return `${memoryDateText(value)} ${parts[1]}（UTC${offset}）`;
}

// 缺少原始偏移时后端保留已知UTC时刻；明确标出显示时区，不冒充来源当地日。
export function memorySourceDateText(value: string): string {
  const offset = /(Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1];
  return `${memoryDateText(value)}${offset ? `（UTC${offset === 'Z' || offset === '+00:00' ? '' : offset}）` : ''}`;
}
