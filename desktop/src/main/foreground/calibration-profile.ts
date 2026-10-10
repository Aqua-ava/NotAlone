import { constants } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { validatedSelection } from './calibration-selection';

export async function readPendingSelection(userData: string): Promise<Record<string, unknown>> {
  const file = await open(path.join(userData, 'foreground-layout-selection.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.uid !== process.getuid?.() || (before.mode & 0o777) !== 0o600 || before.size > 8192) throw new Error('calibration_selection_invalid');
    const bytes = Buffer.alloc(8193);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const after = await file.stat();
    if (bytesRead !== before.size || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('calibration_selection_invalid');
    return validatedSelection(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
  } finally { await file.close(); }
}

export async function invalidateCalibrationProfile(userData: string): Promise<void> {
  await rm(path.join(userData, 'foreground-layout-profile.json'), { force: true });
  await rm(path.join(userData, 'foreground-layout-verification.json'), { force: true });
}

export const layoutVerificationErrors = [
  'minimal_region_layout_unverified', 'minimal_region_layout_changed',
  'screen_capture_permission_missing', 'wechat_not_in_front', 'quality_unverified',
  'minimal_region_capture_failed', 'calibration_unavailable',
] as const;
export const layoutVerificationStages = ['selection', 'context', 'capture-setup', 'sentinels-before', 'names', 'sentinels-after', 'profile', 'host'] as const;

// 仅保存固定阶段和安全错误码，不能夹带原生输出、会话名或图像。
export async function saveLayoutVerificationResult(userData: string, state: 'failed' | 'verified', error: unknown, stage: unknown, isCurrent: () => boolean): Promise<void> {
  if (!['failed', 'verified'].includes(state) || !layoutVerificationStages.includes(stage as typeof layoutVerificationStages[number]) || (state === 'verified' ? error !== null
    : !layoutVerificationErrors.includes(error as typeof layoutVerificationErrors[number]))) throw new Error('calibration_result_invalid');
  const temporary = path.join(userData, `.foreground-verification-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ state, error, stage }), { flag: 'wx', mode: 0o600 });
    if (isCurrent()) await rename(temporary, path.join(userData, 'foreground-layout-verification.json'));
  } finally { await rm(temporary, { force: true }); }
}

// 文件只接受本轮原生校验返回的固定profile，不允许夹带名字、图帧或额外状态。
export async function saveVerifiedProfile(userData: string, value: unknown, isCurrent: () => boolean): Promise<boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('calibration_profile_invalid');
  const profile = value as Record<string, unknown>;
  const { pixelScale, sentinelDigests, ...selection } = profile;
  if (profile.state !== 'verified-minimal-layout' || typeof pixelScale !== 'number' || !Number.isFinite(pixelScale)
    || pixelScale < 1 || pixelScale > 3) throw new Error('calibration_profile_invalid');
  validatedSelection({ ...selection, state: 'selected-awaiting-verification' });
  if (!sentinelDigests || typeof sentinelDigests !== 'object' || Array.isArray(sentinelDigests)) throw new Error('calibration_profile_invalid');
  const digests = sentinelDigests as Record<string, unknown>;
  const fields = ['verticalDivider', 'headerDivider', 'selectedHighlight'];
  if (Object.keys(digests).length !== 3 || !Object.keys(digests).every(key => fields.includes(key))
    || !Object.values(digests).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) throw new Error('calibration_profile_invalid');
  const temporary = path.join(userData, `.foreground-profile-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(profile), { flag: 'wx', mode: 0o600 });
    if (!isCurrent()) return false;
    await rename(temporary, path.join(userData, 'foreground-layout-profile.json'));
    return true;
  } finally { await rm(temporary, { force: true }); }
}
