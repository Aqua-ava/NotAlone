const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

// 沿用原始 ASCII 格式，不修剪输入；各信任边界仍自行核对结构、来源和范围。
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && uuid.test(value);
}

export function normalizeUuid(value: unknown): string | null {
  return isUuid(value) ? value.toLowerCase() : null;
}
