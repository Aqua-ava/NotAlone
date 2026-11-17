/** JSON保留整数数字字面量；JS内使用bigint表示超出安全范围的整数。 */
type JsonWithSource = { parse(text: string, reviver: (key: string, value: unknown, context?: { source: string }) => unknown): unknown;
  rawJSON(text: string): unknown };
export function parseIntegerJson(text: string): unknown {
  return (JSON as unknown as JsonWithSource).parse(text, (_key, value, context) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && /^-?(?:0|[1-9]\d*)$/.test(context.source)) {
      return BigInt(context.source);
    }
    return value;
  });
}
export function stringifyIntegerJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint'
    ? (JSON as unknown as JsonWithSource).rawJSON(item.toString()) : item);
}
