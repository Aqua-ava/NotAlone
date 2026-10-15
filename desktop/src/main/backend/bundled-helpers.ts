import { constants } from 'node:fs';
import { access, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const layout = { directory: 'notalone-probe', entry: 'notalone-sync-probe', library: 'libNotAloneSyncCore.dylib' } as const;

export async function resolveSyncProbePath(resourcesDirectory: string | undefined, configuredPath?: string): Promise<string | undefined> {
  const bundledRuntime = () => verifiedBundledRuntime(resourcesDirectory);
  if (!configuredPath) return bundledRuntime();
  if (!resourcesDirectory || !path.isAbsolute(resourcesDirectory)) return configuredPath;
  const resources = [path.resolve(resourcesDirectory)];
  try { resources.push(await realpath(resourcesDirectory)); } catch { /* 已知包路径失效时仍按声明路径停用。 */ }
  const selected = path.normalize(configuredPath);
  const roots = resources.map((directory) => path.join(directory, layout.directory));
  if (!roots.some((root) => selected === root || selected.startsWith(`${root}${path.sep}`))) return configuredPath;
  // 设置表单保存后的默认路径和环境变量仍属于包内文件，不能绕过整组核验。
  if (!roots.some((root) => selected === path.join(root, layout.entry))) return undefined;
  return bundledRuntime();
}

// 仅核对包内清单和字节完整性，不运行输入、加载动态库或宣称发行者可信。
async function verifiedBundledRuntime(resourcesDirectory: string | undefined): Promise<string | undefined> {
  if (!resourcesDirectory || !path.isAbsolute(resourcesDirectory)) return undefined;
  try {
    const resources = await realpath(resourcesDirectory);
    const root = path.join(resources, layout.directory);
    if (await realpath(root) !== root) return undefined;
    const file = await open(path.join(root, 'manifest.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let manifest: unknown;
    try {
      const metadata = await file.stat();
      if (!metadata.isFile() || metadata.size > 65_536) return undefined;
      const buffer = Buffer.alloc(65_537);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65_536) return undefined;
      manifest = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
    } finally { await file.close(); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return undefined;
    const value = manifest as Record<string, unknown>;
    const architecture = process.arch === 'x64' ? 'x86_64' : process.arch;
    if (value.schemaVersion !== 1 || value.runtimeKind !== 'repository-probe' || value.architecture !== architecture
      || typeof value.versionDeclaration !== 'string' || !/^[a-zA-Z0-9._+-]{1,64}$/.test(value.versionDeclaration)
      || value.provenanceVerified !== false || value.runtimeValidated !== false || value.helperExecuted !== false || value.nativeAcceptance !== false
      || !Array.isArray(value.files) || value.files.length < 2 || value.files.length > 64) return undefined;
    if (!validRepositoryBuild(value)) return undefined;
    const names = new Set<string>(); const deadline = Date.now() + 5000;
    for (const entry of value.files) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
      const record = entry as Record<string, unknown>;
      if (typeof record.name !== 'string' || !record.name || path.isAbsolute(record.name) || record.name.includes('\\')
        || /[\0\r\n]/.test(record.name) || record.name.split('/').some((part) => !part || part === '.' || part === '..')
        || names.has(record.name) || typeof record.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(record.sha256)
        || typeof record.bytes !== 'number' || !Number.isSafeInteger(record.bytes) || record.bytes < 4 || record.bytes > 268_435_456
        || record.signature !== 'verified' || !Array.isArray(record.architectures) || !record.architectures.includes(architecture)) return undefined;
      names.add(record.name);
      const selected = path.join(root, record.name);
      if (await realpath(selected) !== selected) return undefined;
      const input = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await input.stat();
        if (!before.isFile() || before.size !== record.bytes) return undefined;
        const hash = createHash('sha256'); const buffer = Buffer.alloc(1_048_576);
        let position = 0;
        while (position < before.size) {
          if (Date.now() >= deadline) return undefined;
          const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
          if (!bytesRead) return undefined;
          hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
        }
        const after = await input.stat();
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
          || hash.digest('hex') !== record.sha256) return undefined;
      } finally { await input.close(); }
    }
    if (!names.has(layout.entry) || !names.has(layout.library)) return undefined;
    const cli = path.join(root, layout.entry); await access(cli, constants.X_OK);
    return cli;
  } catch { return undefined; }
}

function validRepositoryBuild(value: Record<string, unknown>): boolean {
  if (typeof value.buildSourceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.buildSourceDigest)
    || value.sourceDeclaration !== `repository:${value.buildSourceDigest}` || !Array.isArray(value.buildSources)
    || ![8, 9, 11, 12, 13, 14].includes(value.buildSources.length)) return false;
  const names = new Set<string>();
  for (const record of value.buildSources) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || typeof record.name !== 'string' || names.has(record.name)
      || !/^(scripts\/build_cli\.sh|Sources\/NotAloneSyncCore\/(ProbeCore|SessionCaptureSafety|RegionCalibration|MinimalRegionLayout|MinimalSessionCapture|AutomaticSessionCapture|SessionCapturePreview|ForegroundStatusPreview|CaptureSupport|SelectedSession|FrontSyncStatusReport|BackendStatusPolling)\.swift|Sources\/NotAloneSyncCLI\/main\.swift)$/.test(record.name)
      || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) return false;
    names.add(record.name);
  }
  const minimalLayout = names.has('Sources/NotAloneSyncCore/MinimalRegionLayout.swift');
  if (minimalLayout !== names.has('Sources/NotAloneSyncCore/MinimalSessionCapture.swift')
    || (minimalLayout && !names.has('Sources/NotAloneSyncCore/RegionCalibration.swift'))
    || (names.has('Sources/NotAloneSyncCore/AutomaticSessionCapture.swift') && !minimalLayout)
    || (names.has('Sources/NotAloneSyncCore/SessionCapturePreview.swift') && !names.has('Sources/NotAloneSyncCore/AutomaticSessionCapture.swift'))
    || (names.has('Sources/NotAloneSyncCore/ForegroundStatusPreview.swift') && !names.has('Sources/NotAloneSyncCore/SessionCapturePreview.swift'))
    || names.size !== (minimalLayout ? (names.has('Sources/NotAloneSyncCore/AutomaticSessionCapture.swift') ? (names.has('Sources/NotAloneSyncCore/SessionCapturePreview.swift') ? (names.has('Sources/NotAloneSyncCore/ForegroundStatusPreview.swift') ? 14 : 13) : 12) : 11) : names.has('Sources/NotAloneSyncCore/RegionCalibration.swift') ? 9 : 8)) return false;
  return createHash('sha256').update(JSON.stringify(value.buildSources)).digest('hex') === value.buildSourceDigest;
}
