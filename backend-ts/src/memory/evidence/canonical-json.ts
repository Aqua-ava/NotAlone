import { sha256 } from '../../platform/sha256.ts';

export type Evidence = Record<string, any>;
export class UnavailableEvidence extends Error {}

class StoredNumber {
  readonly literal: string;
  constructor(literal: string) { this.literal = literal; }
}
/** 保留 JSONB 中的大整数及 1.0 类型，避免 Node 数字解析改变既有来源指纹。 */
export function parseStoredJSON(text: string): Evidence {
  return JSON.parse(text, (_key: string, value: unknown, ...context: any[]) =>
    typeof value === 'number' ? new StoredNumber(context[0].source) : value);
}
function storedNumberJSON(literal: string): string {
  if (!/[.eE]/.test(literal)) return literal;
  const value = Number(literal), absolute = Math.abs(value);
  if (!Number.isFinite(value)) throw new UnavailableEvidence();
  if (Object.is(value,-0)) return '-0.0';
  if (absolute && (absolute < 1e-4 || absolute >= 1e16)) {
    return value.toExponential().replace(/e([+-])(\d+)$/, (_: string, sign: string, exponent: string) => `e${sign}${exponent.padStart(2,'0')}`);
  }
  return Number.isInteger(value) ? `${value}.0` : String(value);
}
function codepointOrder(left: string, right: string): number {
  const a = [...left], b = [...right];
  for (let index = 0; index < Math.min(a.length,b.length); index++) {
    const difference = a[index].codePointAt(0)! - b[index].codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}
// Python 既有冻结窗口使用排序 JSON；引用摘要另使用默认的逗号／冒号空格。
export function canonicalJSON(value: unknown, spaced = false, ascii = false): string {
  const separator = spaced ? ', ' : ',';
  const colon = spaced ? ': ' : ':';
  let result: string;
  if (value instanceof StoredNumber) return storedNumberJSON(value.literal);
  if (Array.isArray(value)) result = `[${value.map(item => canonicalJSON(item, spaced, ascii)).join(separator)}]`;
  else if (value !== null && typeof value === 'object') result = `{${Object.keys(value).sort(codepointOrder).map(key => `${canonicalJSON(key, spaced, ascii)}${colon}${canonicalJSON((value as Record<string, unknown>)[key], spaced, ascii)}`).join(separator)}}`;
  else result = JSON.stringify(value);
  return ascii ? result.replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`) : result;
}
export function digest(value: unknown): string { return sha(canonicalJSON(value)); }
export function sha(value: string): string { return sha256(value); }
