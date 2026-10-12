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

export async function invalidateCalibrationProfile(userData: string, resetProgress = true): Promise<void> {
  await rm(path.join(userData, 'foreground-layout-profile.json'), { force: true });
  await rm(path.join(userData, 'foreground-layout-verification.json'), { force: true });
  if (resetProgress) await rm(path.join(userData, 'foreground-layout-verification-progress.json'), { force: true });
}

export const layoutVerificationErrors = [
  'minimal_region_layout_unverified', 'minimal_region_layout_changed',
  'screen_capture_permission_missing', 'wechat_not_in_front', 'quality_unverified',
  'header_name_unreadable', 'row_name_unreadable', 'session_names_mismatch', 'session_name_confidence_low',
  'minimal_region_capture_failed', 'calibration_unavailable',
  'calibration_coordinates_invalid', 'calibration_context_unavailable',
  'calibration_window_size_changed', 'calibration_window_changed',
  'calibration_probe_failed', 'calibration_probe_missing',
  'calibration_wechat_instances_ambiguous', 'calibration_wechat_version_unsupported',
  'calibration_window_not_visible', 'calibration_windows_ambiguous', 'calibration_window_geometry_invalid',
] as const;
export const layoutVerificationStages = ['selection', 'context', 'capture-setup', 'sentinels-before', 'names', 'sentinels-after', 'profile', 'host'] as const;

export type LayoutNameQuality = {
  display_name_confidence: number; selected_row_name_confidence: number; repeated_display_name_confidence: number;
  display_name_width: number; display_name_height: number; selected_row_name_width: number; selected_row_name_height: number;
  pixel_scale: number; names_duration_ms: number;
};

// 诊断只接受固定数值，不接受识别名称、原生原文、图像或任意扩展字段。
export function validatedNameQuality(value: unknown): LayoutNameQuality {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('calibration_result_invalid');
  const quality = value as Record<string, unknown>;
  const confidences = ['display_name_confidence', 'selected_row_name_confidence', 'repeated_display_name_confidence'];
  const sizes = ['display_name_width', 'display_name_height', 'selected_row_name_width', 'selected_row_name_height'];
  const keys = [...confidences, ...sizes, 'pixel_scale', 'names_duration_ms'];
  const finiteNumber = (key: string): boolean => typeof quality[key] === 'number' && Number.isFinite(quality[key]);
  if (Object.keys(quality).length !== keys.length || !Object.keys(quality).every(key => keys.includes(key))
    || !keys.every(finiteNumber)
    || !confidences.every(key => (quality[key] as number) >= 0 && (quality[key] as number) <= 1)
    || !sizes.every(key => Number.isInteger(quality[key]) && (quality[key] as number) >= 1 && (quality[key] as number) <= 160_000)
    || (quality.display_name_width as number) * (quality.display_name_height as number) > 160_000
    || (quality.selected_row_name_width as number) * (quality.selected_row_name_height as number) > 160_000
    || (quality.pixel_scale as number) < 1 || (quality.pixel_scale as number) > 3
    || !Number.isInteger(quality.names_duration_ms) || (quality.names_duration_ms as number) < 0 || (quality.names_duration_ms as number) > 400_000) {
    throw new Error('calibration_result_invalid');
  }
  return { ...quality } as LayoutNameQuality;
}

export type LayoutContextDiagnostics = {
  front_app_code: string; front_process_id: number; selected_process_id: number;
  wechat_instance_count: number; sole_wechat_process_id: number; sole_wechat_app_code: string; context_code: string;
};

// 来源分类只说明末次元数据观察，不代替前台、布局或身份门禁。
export function validatedContextDiagnostics(value: unknown): LayoutContextDiagnostics {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('calibration_result_invalid');
  const context = value as Record<string, unknown>;
  const keys = ['front_app_code', 'front_process_id', 'selected_process_id', 'wechat_instance_count',
    'sole_wechat_process_id', 'sole_wechat_app_code', 'context_code'];
  const wechatCodes = ['wechat_primary', 'wechat_other', 'wechat_unknown'];
  const contextCodes = ['matched', 'identity_changed', 'calibration_wechat_instances_ambiguous',
    'calibration_wechat_version_unsupported', 'calibration_window_not_visible', 'calibration_windows_ambiguous',
    'calibration_window_geometry_invalid', 'calibration_context_unavailable'];
  const integer = (key: string, minimum: number, maximum: number): boolean => typeof context[key] === 'number'
    && Number.isInteger(context[key]) && (context[key] as number) >= minimum && (context[key] as number) <= maximum;
  if (Object.keys(context).length !== keys.length || !Object.keys(context).every(key => keys.includes(key))
    || ![...wechatCodes, 'notalone', 'probe', 'other', 'none'].includes(context.front_app_code as string)
    || !contextCodes.includes(context.context_code as string)
    || !integer('front_process_id', 0, 2147483647) || !integer('selected_process_id', 1, 2147483647)
    || !integer('sole_wechat_process_id', 0, 2147483647) || !integer('wechat_instance_count', 0, 128)
    || (context.front_app_code === 'none') !== (context.front_process_id === 0)
    || (context.wechat_instance_count === 1
      ? !(context.sole_wechat_process_id as number) || !wechatCodes.includes(context.sole_wechat_app_code as string)
      : context.sole_wechat_process_id !== 0 || context.sole_wechat_app_code !== 'none')) {
    throw new Error('calibration_result_invalid');
  }
  return { ...context } as LayoutContextDiagnostics;
}

export function verificationProgressReceiver(onStage: (stage: typeof layoutVerificationStages[number]) => void): (chunk: Buffer) => boolean {
  let bytes = 0, pending = '';
  const seen = new Set<string>();
  return (chunk) => {
    bytes += chunk.length;
    if (bytes > 8192) return false;
    pending += chunk.toString('utf8');
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
      const prefix = 'notalone_verification_stage:';
      if (!line.startsWith(prefix)) continue;
      const stage = line.slice(prefix.length) as typeof layoutVerificationStages[number];
      if (!layoutVerificationStages.includes(stage) || seen.has(stage)) continue;
      seen.add(stage); onStage(stage);
    }
    return true;
  };
}

export async function saveVerificationProgress(userData: string, stage: unknown, isCurrent: () => boolean): Promise<void> {
  if (!layoutVerificationStages.includes(stage as typeof layoutVerificationStages[number])) throw new Error('calibration_result_invalid');
  const temporary = path.join(userData, `.foreground-progress-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify({ state: 'running', stage }), { flag: 'wx', mode: 0o600 });
    if (isCurrent()) await rename(temporary, path.join(userData, 'foreground-layout-verification-progress.json'));
  } finally { await rm(temporary, { force: true }); }
}

// 仅保存固定阶段、安全错误码及经过白名单校验的数值，不授予采集资格。
export async function saveLayoutVerificationResult(userData: string, state: 'failed' | 'verified', error: unknown, stage: unknown, isCurrent: () => boolean, nameQuality?: unknown, contextDiagnostics?: unknown): Promise<void> {
  if (!['failed', 'verified'].includes(state) || !layoutVerificationStages.includes(stage as typeof layoutVerificationStages[number]) || (state === 'verified' ? error !== null
    : !layoutVerificationErrors.includes(error as typeof layoutVerificationErrors[number]))) throw new Error('calibration_result_invalid');
  if (nameQuality !== undefined && !['names', 'sentinels-after', 'profile'].includes(stage as string)) throw new Error('calibration_result_invalid');
  if (contextDiagnostics !== undefined && (state !== 'failed' || stage !== 'context')) throw new Error('calibration_result_invalid');
  const result = { state, error, stage, ...(nameQuality === undefined ? {} : { name_quality: validatedNameQuality(nameQuality) }),
    ...(contextDiagnostics === undefined ? {} : { context_diagnostics: validatedContextDiagnostics(contextDiagnostics) }) };
  const temporary = path.join(userData, `.foreground-verification-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(result), { flag: 'wx', mode: 0o600 });
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
