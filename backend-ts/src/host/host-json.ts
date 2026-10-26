/** Node24公开JSON边界：只把不安全的整数字面量转为BigInt，保留原数字协议。 */
export function parseJson(text: string): unknown {
  return JSON.parse(text, (_key: string, value: unknown, context?: {source?: string}) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value)
        && context?.source && /^-?\d+$/.test(context.source)) {
      return BigInt(context.source);
    }
    return value;
  });
}

export function stringifyJson(value: unknown): string {
  // 运行时固定Node24；ES2024类型库尚未声明该公开接口。
  const json = JSON as typeof JSON & {rawJSON(text: string): unknown};
  const result = JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? json.rawJSON(item.toString()) : item);
  if (result === undefined) throw new TypeError('json_value_unserializable');
  return result;
}
