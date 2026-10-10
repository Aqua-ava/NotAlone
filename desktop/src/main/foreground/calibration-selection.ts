import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// 待校验几何的文件适配层；不接受名称、正文或可用于放开采集的状态。
export async function savePendingCalibrationSelection(userData: string, value: unknown, isCurrent: () => boolean): Promise<boolean> {
  const selection = validatedSelection(value);
  const target = path.join(userData, 'foreground-layout-selection.json');
  const temporary = path.join(userData, `.foreground-layout-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(selection), { flag: 'wx', mode: 0o600 });
    if (!isCurrent()) return false;
    await rename(temporary, target);
    return true;
  } finally { await rm(temporary, { force: true }); }
}

export function validatedSelection(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('calibration_output_invalid');
  const selection = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'state', 'wechatVersion', 'wechatBuild', 'processId', 'windowId', 'windowFrame', 'regions'];
  const positiveInteger = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  if (Object.keys(selection).length !== keys.length || !Object.keys(selection).every((key) => keys.includes(key))
    || selection.schemaVersion !== 1 || selection.state !== 'selected-awaiting-verification'
    || selection.wechatVersion !== '4.0.6' || selection.wechatBuild !== '29387'
    || !positiveInteger(selection.processId) || !positiveInteger(selection.windowId)) throw new Error('calibration_output_invalid');
  const frame = rectangle(selection.windowFrame);
  if (frame.width < 600 || frame.height < 400 || frame.width > 10_000 || frame.height > 10_000) throw new Error('calibration_output_invalid');
  if (!selection.regions || typeof selection.regions !== 'object' || Array.isArray(selection.regions)) throw new Error('calibration_output_invalid');
  const regions = selection.regions as Record<string, unknown>;
  const names = ['displayName', 'selectedRowName', 'verticalDivider', 'headerDivider', 'selectedHighlight'];
  if (Object.keys(regions).length !== names.length || !Object.keys(regions).every((name) => names.includes(name))) throw new Error('calibration_output_invalid');
  for (const name of names) {
    const region = rectangle(regions[name]);
    if (region.x < 0 || region.y < 0 || region.x + region.width > frame.width || region.y + region.height > frame.height) throw new Error('calibration_output_invalid');
  }
  return selection;
}
function rectangle(value: unknown): { x: number; y: number; width: number; height: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('calibration_output_invalid');
  const record = value as Record<string, unknown>;
  const keys = ['x', 'y', 'width', 'height'];
  if (Object.keys(record).length !== keys.length || !Object.keys(record).every((key) => keys.includes(key))
    || !keys.every((key) => typeof record[key] === 'number' && Number.isFinite(record[key]))
    || (record.width as number) <= 0 || (record.height as number) <= 0) throw new Error('calibration_output_invalid');
  return record as { x: number; y: number; width: number; height: number };
}
