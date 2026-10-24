/** JSON仍使用整数数字字面量；仅在JS内以bigint保留超安全范围的修订。 */
export type ExpressionPreferenceRevision = number | bigint;
export function isExpressionPreferenceRevision(value: unknown): value is ExpressionPreferenceRevision {
  return (typeof value === 'bigint' || typeof value === 'number' && Number.isSafeInteger(value)) && value >= 1;
}
type JsonWithSource = { parse(text: string, reviver: (key: string, value: unknown, context?: { source: string }) => unknown): unknown;
  rawJSON(text: string): unknown };
export function parsePreferenceJson(text: string): unknown {
  return (JSON as unknown as JsonWithSource).parse(text, (_key, value, context) => {
    if (typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && /^-?(?:0|[1-9]\d*)$/.test(context.source)) {
      return BigInt(context.source);
    }
    return value;
  });
}
export function stringifyPreferenceJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => typeof item === 'bigint'
    ? (JSON as unknown as JsonWithSource).rawJSON(item.toString()) : item);
}
