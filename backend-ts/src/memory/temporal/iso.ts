/** 统一时间字符串精度；与Python datetime输出对齐，不参与数据库访问。 */
export function pythonISO(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.replace(' ', 'T').replace(/Z$/, '+00:00').replace(/([+-]\d\d)$/, '$1:00').replace(/(T\d\d:\d\d)(?=[+-])/, '$1:00');
  return normalized.replace(/\.(\d+)(?=[+-]\d\d:\d\d$)/, (_all, fraction: string) =>
    Number(fraction) ? `.${fraction.padEnd(6, '0').slice(0, 6)}` : '');
}
