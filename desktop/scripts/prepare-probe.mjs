import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acceptanceFlags, failureReport, runtimeLayout } from './probe-runtime.mjs';
import { prepareProbeRuntime } from './prepare-probe-runtime.mjs';
import { requireBuildSpace } from './build-space.mjs';
import { validateSigningIdentity, requireSigningMode } from './package-signing.mjs';

const run = promisify(execFile);
const sourceNames = [
  'scripts/build_cli.sh',
  ...['ProbeCore', 'SessionCaptureSafety', 'RegionCalibration', 'MinimalRegionLayout', 'MinimalSessionCapture', 'AutomaticSessionCapture', 'HeaderChangeDetector', 'HeaderChangeGeometry', 'HeaderChangeDiagnostics', 'HeaderChangeSource', 'SessionCapturePreview', 'ForegroundStatusPreview', 'CaptureSupport', 'SelectedSession', 'FrontSyncStatusReport', 'BackendStatusPolling']
    .map((name) => `Sources/NotAloneSyncCore/${name}.swift`),
  'Sources/NotAloneSyncCLI/main.swift',
];

// 构建进程边界独立于编译内容，便于用合成脚本核验 shell 启动隔离。
export function repositoryBuildInvocation(script, owned, signingIdentity = '-') {
  return { program: '/bin/zsh', arguments: ['-f', script], options: {
    timeout: 120_000, maxBuffer: 1_048_576,
    env: { PATH: '/usr/bin:/bin', ZDOTDIR: owned, NOTALONE_PROBE_SIGNING_IDENTITY: validateSigningIdentity(signingIdentity), NOTALONE_PROBE_MODULE_CACHE_DIR: path.join(owned, 'module-cache') },
  } };
}

async function snapshotSource(source, destination) {
  if (await realpath(source) !== source) throw new Error('helper_check_input_invalid');
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size > 1_048_576) throw new Error('helper_check_input_invalid');
    const buffer = Buffer.alloc(1_048_577);
    const { bytesRead } = await input.read(buffer, 0, buffer.length, 0);
    const after = await input.stat();
    if (bytesRead !== before.size || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('helper_check_input_changed');
    const content = buffer.subarray(0, bytesRead);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, content, { flag: 'wx', mode: 0o600 });
    return createHash('sha256').update(content).digest('hex');
  } finally { await input.close(); }
}

export async function prepareRepositoryProbe(destination, { signingIdentity = '-' } = {}) {
  validateSigningIdentity(signingIdentity);
  if (process.platform !== 'darwin') throw new Error('helper_check_unavailable');
  if (!path.isAbsolute(destination) || /[\0\r\n]/.test(destination)) throw new Error('helper_prepare_destination');
  await realpath(path.dirname(destination));
  try { await lstat(destination); throw new Error('helper_prepare_destination'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const repositoryNative = await realpath(fileURLToPath(new URL('../../native/macos/', import.meta.url)));
  await requireBuildSpace([path.dirname(destination), tmpdir()]);
  const owned = await mkdtemp(path.join(tmpdir(), 'notalone-probe-build-'));
  try {
    const snapshot = path.join(owned, 'native');
    const buildSources = [];
    for (const name of sourceNames) {
      buildSources.push({ name, sha256: await snapshotSource(path.join(repositoryNative, name), path.join(snapshot, name)) });
    }
    const buildSourceDigest = createHash('sha256').update(JSON.stringify(buildSources)).digest('hex');
    // 只执行仓库构建脚本的自有快照；身份来自显式参数，不继承环境选择或运行产物。
    try {
      const invocation = repositoryBuildInvocation(path.join(snapshot, 'scripts/build_cli.sh'), owned, signingIdentity);
      await run(invocation.program, invocation.arguments, invocation.options);
    } catch { throw new Error('helper_probe_build_failed'); }
    const layout = runtimeLayout();
    for (const name of [layout.entry, layout.headerChange, layout.library]) {
      await requireSigningMode(path.join(snapshot, 'build/cli', name), signingIdentity, run);
    }
    return await prepareProbeRuntime({ directory: path.join(snapshot, 'build/cli'), destination,
      runtimeKind: 'repository-probe', arch: process.arch === 'x64' ? 'x86_64' : process.arch,
      version: `repo-${buildSourceDigest.slice(0, 16)}`, source: `repository:${buildSourceDigest}`, buildSourceDigest, buildSources });
  } finally { await rm(owned, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  let result;
  try {
    const values = process.argv.slice(2);
    if (![2, 4].includes(values.length) || values[0] !== '--destination' || !values[1]
      || values.length === 4 && values[2] !== '--signing-identity') throw new Error('helper_prepare_destination');
    result = await prepareRepositoryProbe(values[1], { signingIdentity: values.length === 4
      ? validateSigningIdentity(values[3]) : '-' });
  } catch (error) { result = failureReport(error); process.exitCode = 2; }
  process.stdout.write(`${JSON.stringify({ ...result, ...acceptanceFlags })}\n`);
}
