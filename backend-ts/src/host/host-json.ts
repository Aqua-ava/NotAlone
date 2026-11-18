/** Node24公开JSON边界：BigInt以原始JSON整数输出，保留原数字协议。 */
export function stringifyJson(value: unknown): string {
  // 运行时固定Node24；ES2024类型库尚未声明该公开接口。
  const json = JSON as typeof JSON & {rawJSON(text: string): unknown};
  const result = JSON.stringify(value, (_key, item) =>
    typeof item === 'bigint' ? json.rawJSON(item.toString()) : item);
  if (result === undefined) throw new TypeError('json_value_unserializable');
  return result;
}
