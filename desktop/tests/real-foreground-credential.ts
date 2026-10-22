import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { resolveSyncProbePath } from '../src/main/backend/bundled-helpers';

// 固定 E 的已核公开字节；不从运行参数选择其它包或拼造 profile。
const expectedE = {
  nativeBuildSourceDigest: '7f4fed1ef4edeb310f69897e9e007d6a8314a727606d956b2ebeb785b3288934',
  asarSha256: '376c9a53920c4b7e5c927383e1b170ec755033ca5a96aa6573707204c48449ab',
  probeSha256: 'e10512d1c287986c4eda2690f2853248d042ac2cb4e1914f714952c109e7605c',
  coreSha256: '9235a1e91850d58fd6e63aa05bf8866458145f38224c08f3ba11ba0ebf2f2570',
} as const;
const invalid = () => new Error('real_foreground_credential_invalid');
const expectedEExecutableSha256 = '133aadfc4339f01808035e7699fda262c50707c707b4affd0396f58fcea9a35f';
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
};
const exact = (value: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(value).length !== keys.length || !Object.keys(value).every(key => keys.includes(key))) throw invalid();
};

// 有界读取及前后身份核；错误只回固定码，不包含路径、名称或原始异常。
export async function readAcceptanceFile(selected: string, maximumBytes: number, privateFile: boolean): Promise<Buffer> {
  try {
    if (!path.isAbsolute(selected) || path.normalize(selected) !== selected || await realpath(selected) !== selected) throw invalid();
    const file = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat();
      if (!before.isFile() || before.uid !== process.getuid?.() || before.nlink !== 1 || before.size > maximumBytes
        || (privateFile ? (before.mode & 0o777) !== 0o600 : Boolean(before.mode & 0o022))) throw invalid();
      const bytes = Buffer.alloc(before.size + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const after = await file.stat();
      if (bytesRead !== before.size || before.ino !== after.ino || before.dev !== after.dev || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw invalid();
      return bytes.subarray(0, bytesRead);
    } finally { await file.close(); }
  } catch { throw invalid(); }
}

export type ForegroundAuditRow = { event: string; kind: string; pid: number | null; returncode?: number } & Record<string, unknown>;
export type ForegroundAuditSnapshot = {
  rows: readonly ForegroundAuditRow[]; lineDigests: readonly string[]; startedPids: readonly number[];
};

export async function readForegroundAudit(selected: string): Promise<ForegroundAuditSnapshot> {
  try {
    const text = (await readAcceptanceFile(selected, 1_048_576, true)).toString('utf8');
    if (!text || !text.endsWith('\n')) throw invalid();
    const lines = text.slice(0, -1).split('\n');
    const kinds = ['version', 'tail', 'sessions_follow', 'foreground_metadata'];
    const counts = ['candidate_count', 'private_count', 'group_count', 'other_type_count', 'exact_name_count'];
    const rows = lines.map(line => {
      const value = object(JSON.parse(line));
      const keys = ['event', 'kind', 'pid', 'status'];
      if (typeof value.kind !== 'string' || ![...kinds, 'sessions'].includes(value.kind)) throw invalid();
      switch (value.event) {
        case 'started':
          if (!kinds.includes(value.kind) || !(value.status === 'reserved' && value.pid === null
            || value.status === 'running' && Number.isSafeInteger(value.pid) && (value.pid as number) > 0)) throw invalid();
          break;
        case 'finished':
          keys.push('returncode');
          if (!kinds.includes(value.kind) || value.status !== 'exited' || !Number.isSafeInteger(value.pid)
            || (value.pid as number) <= 0 || !Number.isSafeInteger(value.returncode)) throw invalid();
          break;
        case 'accepted':
          if (value.kind !== 'tail' || value.pid !== null || value.status !== 'validated') throw invalid();
          break;
        case 'metadata':
          keys.push(...counts);
          if (value.kind !== 'foreground_metadata' || value.pid !== null || value.status !== 'validated'
            || !counts.every(key => Number.isSafeInteger(value[key]) && (value[key] as number) >= 0)
            || (value.private_count as number) + (value.group_count as number) + (value.other_type_count as number) !== value.candidate_count
            || (value.exact_name_count as number) > (value.candidate_count as number)) throw invalid();
          break;
        case 'scope_rejected':
          keys.push('code');
          if (value.pid !== null || value.status !== 'rejected' || typeof value.code !== 'string'
            || !/^acceptance_[a-z_]+$/.test(value.code)) throw invalid();
          break;
        default: throw invalid();
      }
      exact(value, keys);
      return Object.freeze(value) as ForegroundAuditRow;
    });
    return Object.freeze({ rows: Object.freeze(rows), lineDigests: Object.freeze(lines.map(line => sha(Buffer.from(line)))),
      startedPids: Object.freeze(rows.filter(row => row.event === 'started' && row.pid !== null).map(row => row.pid!)) });
  } catch { throw new Error('real_foreground_audit_invalid'); }
}

export function foregroundQuitPids(snapshot: ForegroundAuditSnapshot): readonly number[] {
  if (!snapshot.startedPids.length) throw new Error('real_foreground_audit_invalid');
  return snapshot.startedPids;
}

export function verifyForegroundAuditAppend(previous: ForegroundAuditSnapshot, current: ForegroundAuditSnapshot,
  allowNewStarts = true): void {
  if (current.lineDigests.length < previous.lineDigests.length
    || !previous.lineDigests.every((digest, index) => current.lineDigests[index] === digest)
    || !allowNewStarts && current.rows.slice(previous.rows.length).some(row => row.event === 'started')) {
    throw new Error('real_foreground_audit_invalid');
  }
}

export function foregroundMetadataCounts(snapshot: ForegroundAuditSnapshot): Array<Record<string, number>> {
  const keys = ['candidate_count', 'private_count', 'group_count', 'other_type_count', 'exact_name_count'];
  const metadata = snapshot.rows.filter(row => row.event === 'metadata');
  if (!metadata.length) throw new Error('real_foreground_audit_invalid');
  return metadata.map(row =>
    Object.fromEntries(keys.map(key => [key, row[key] as number])));
}

// 校准采集入口已删除；该真实前台验收仍核对冻结 profile 的选区结构，校验逻辑留在测试侧。
function assertFrozenSelection(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const selection = value as Record<string, unknown>;
  const keys = ['schemaVersion', 'state', 'wechatVersion', 'wechatBuild', 'processId', 'windowId', 'windowFrame', 'regions'];
  const positiveInteger = (entry: unknown) => typeof entry === 'number' && Number.isSafeInteger(entry) && entry > 0;
  const rectangle = (entry: unknown) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw invalid();
    const record = entry as Record<string, unknown>;
    const fields = ['x', 'y', 'width', 'height'];
    if (Object.keys(record).length !== fields.length || !Object.keys(record).every(key => fields.includes(key))
      || !fields.every(key => typeof record[key] === 'number' && Number.isFinite(record[key]))
      || (record.width as number) <= 0 || (record.height as number) <= 0) throw invalid();
    return record as { x: number; y: number; width: number; height: number };
  };
  if (Object.keys(selection).length !== keys.length || !Object.keys(selection).every(key => keys.includes(key))
    || selection.schemaVersion !== 1 || selection.state !== 'selected-awaiting-verification'
    || selection.wechatVersion !== '4.0.6' || selection.wechatBuild !== '29387'
    || !positiveInteger(selection.processId) || !positiveInteger(selection.windowId)) throw invalid();
  const frame = rectangle(selection.windowFrame);
  if (frame.width < 600 || frame.height < 400 || frame.width > 10_000 || frame.height > 10_000) throw invalid();
  if (!selection.regions || typeof selection.regions !== 'object' || Array.isArray(selection.regions)) throw invalid();
  const regions = selection.regions as Record<string, unknown>;
  const names = ['displayName', 'selectedRowName', 'verticalDivider', 'headerDivider', 'selectedHighlight'];
  if (Object.keys(regions).length !== names.length || !Object.keys(regions).every(name => names.includes(name))) throw invalid();
  for (const name of names) {
    const region = rectangle(regions[name]);
    if (region.x < 0 || region.y < 0 || region.x + region.width > frame.width || region.y + region.height > frame.height) throw invalid();
  }
}

export type ForegroundCredential = {
  displayName: string; scopePath: string; scopeSha256: string; probePath: string;
  profileBytes: Buffer; profileSha256: string; appExecutablePath: string;
};

export async function readForegroundCredential(selected: string, appExecutablePath: string,
  scopePath: string): Promise<ForegroundCredential> {
  try {
    const value = object(JSON.parse((await readAcceptanceFile(selected, 32_768, true)).toString('utf8')));
    const pathFields = ['scopePath', 'appExecutablePath', 'profilePath', 'verificationResultPath', 'calibrationReceiptPath'];
    const digestFields = ['scopeSha256', 'appExecutableSha256', 'profileSha256', 'verificationResultSha256', 'calibrationReceiptSha256'];
    exact(value, ['schemaVersion', 'purpose', 'displayName', ...pathFields, ...digestFields]);
    if (value.schemaVersion !== 1 || value.purpose !== 'real-foreground-locator-acceptance'
      || typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName !== value.displayName.trim()
      || value.displayName.length > 256 || /[\p{Cc}\p{Cs}]/u.test(value.displayName)
      || !pathFields.every(key => typeof value[key] === 'string')
      || !digestFields.every(key => typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key] as string))
      || value.scopePath !== scopePath || value.appExecutablePath !== appExecutablePath
      || path.basename(appExecutablePath) !== 'NotAlone' || path.basename(path.dirname(appExecutablePath)) !== 'MacOS'
      || path.basename(path.dirname(path.dirname(appExecutablePath))) !== 'Contents') throw invalid();
    const profileBytes = await readAcceptanceFile(value.profilePath as string, 8192, true);
    const resultBytes = await readAcceptanceFile(value.verificationResultPath as string, 8192, true);
    const receiptBytes = await readAcceptanceFile(value.calibrationReceiptPath as string, 8192, true);
    if (sha(profileBytes) !== value.profileSha256 || sha(resultBytes) !== value.verificationResultSha256
      || sha(receiptBytes) !== value.calibrationReceiptSha256
      || sha(await readAcceptanceFile(scopePath, 65_536, true)) !== value.scopeSha256) throw invalid();
    const result = object(JSON.parse(resultBytes.toString('utf8')));
    if (result.state !== 'verified' || result.error !== null || result.stage !== 'profile') throw invalid();
    const receipt = object(JSON.parse(receiptBytes.toString('utf8')));
    exact(receipt, ['schemaVersion', 'kind', 'candidate', 'actualAppLaunches', 'actualVerificationSucceeded',
      'profileCopiedFromActualApp', 'probeSubstituted', 'appExecutableSha256', 'profileSha256', 'verificationResultSha256',
      ...Object.keys(expectedE)]);
    if (receipt.schemaVersion !== 1 || receipt.kind !== 'root-foreground-layout-verification'
      || receipt.candidate !== 'E' || receipt.actualAppLaunches !== 1 || receipt.actualVerificationSucceeded !== true
      || receipt.profileCopiedFromActualApp !== true || receipt.probeSubstituted !== false
      || !['appExecutableSha256', 'profileSha256', 'verificationResultSha256'].every(key => receipt[key] === value[key])
      || !Object.entries(expectedE).every(([key, digest]) => receipt[key] === digest)) throw invalid();
    const profile = object(JSON.parse(profileBytes.toString('utf8')));
    const { pixelScale, sentinelDigests, ...selection } = profile;
    if (profile.state !== 'verified-minimal-layout' || typeof pixelScale !== 'number' || !Number.isFinite(pixelScale)
      || pixelScale < 1 || pixelScale > 3) throw invalid();
    assertFrozenSelection({ ...selection, state: 'selected-awaiting-verification' });
    const digests = object(sentinelDigests);
    exact(digests, ['verticalDivider', 'headerDivider', 'selectedHighlight']);
    if (!Object.values(digests).every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) throw invalid();
    const resources = path.join(path.dirname(path.dirname(appExecutablePath)), 'Resources');
    if (value.appExecutableSha256 !== expectedEExecutableSha256
      || sha(await readAcceptanceFile(appExecutablePath, 268_435_456, false)) !== expectedEExecutableSha256) throw invalid();
    const probePath = path.join(resources, 'notalone-probe', 'notalone-sync-probe');
    const manifestPath = path.join(resources, 'notalone-probe', 'manifest.json');
    const manifest = object(JSON.parse((await readAcceptanceFile(manifestPath, 65_536, false)).toString('utf8')));
    if (manifest.buildSourceDigest !== expectedE.nativeBuildSourceDigest
      || sha(await readAcceptanceFile(path.join(resources, 'app.asar'), 268_435_456, false)) !== expectedE.asarSha256
      || sha(await readAcceptanceFile(probePath, 268_435_456, false)) !== expectedE.probeSha256
      || sha(await readAcceptanceFile(path.join(resources, 'notalone-probe', 'libNotAloneSyncCore.dylib'), 268_435_456, false)) !== expectedE.coreSha256
      || await resolveSyncProbePath(resources, probePath) !== probePath) throw invalid();
    return { displayName: value.displayName, scopePath, scopeSha256: value.scopeSha256 as string, probePath,
      profileBytes, profileSha256: value.profileSha256 as string, appExecutablePath };
  } catch { throw invalid(); }
}
