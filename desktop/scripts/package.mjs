import { packager } from '@electron/packager';
import { cp, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareRepositoryProbe } from './prepare-probe.mjs';
import { inspectRuntime, requireUnchangedFiles, runtimeLayout } from './probe-runtime.mjs';
import { requireBuildSpace } from './build-space.mjs';
import { inspectManagedRuntime, runtimeDirectoryName } from './managed-runtime.mjs';
import { prepareElectronNotices, verifyElectronArchive, verifyElectronNotices, verifyFrontendNotices } from './distribution-notices.mjs';
import { runtimeMinimumMacOS } from './runtime-platform.mjs';
import { validateSigningIdentity, packageWithSigning, requireSigningMode } from './package-signing.mjs';

if (process.platform !== 'darwin') throw new Error('本机 App 打包需要 macOS。');
const run = promisify(execFile);
const packageArguments = process.argv.slice(2);
let withProbe = false;
let signingIdentity;
const packagePaths = {};
for (let index = 0; index < packageArguments.length; index++) {
  const key = packageArguments[index];
  if (['--helper-directory', '--helper-version', '--helper-source'].includes(key)) throw new Error('package_external_tools_only');
  if (key === '--with-probe') {
    if (withProbe) throw new Error('helper_check_arguments');
    withProbe = true; continue;
  }
  const value = packageArguments[++index];
  if (key === '--signing-identity') {
    if (signingIdentity !== undefined || value === undefined) throw new Error('package_signing_identity_invalid');
    signingIdentity = validateSigningIdentity(value); continue;
  }
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error('helper_check_arguments');
  if (key === '--output-directory' || key === '--electron-zip-directory' || key === '--runtime-directory') {
    if (key in packagePaths || !path.isAbsolute(value)) throw new Error('helper_check_arguments');
    packagePaths[key] = path.resolve(value);
  } else { throw new Error('helper_check_arguments'); }
}
signingIdentity ??= '-';
const electronCache = path.join(homedir(), 'Library/Caches/electron');
await requireBuildSpace([packagePaths['--output-directory'] || path.resolve('out'), tmpdir(),
  ...(!packagePaths['--electron-zip-directory'] ? [electronCache] : [])]);
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const minimumMacOS = runtimeMinimumMacOS(JSON.parse(await readFile(new URL('./runtime/component-sources.lock.json', import.meta.url), 'utf8')));
let staging; let outputDirectory; let ownedOutput; let completed = false;
try {
  if (packagePaths['--output-directory']) {
    const selected = packagePaths['--output-directory'];
    outputDirectory = path.join(await realpath(path.dirname(selected)), path.basename(selected));
    try { await mkdir(outputDirectory); ownedOutput = await lstat(outputDirectory); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('package_output_exists'); throw error; }
  }
  let electronZipDir;
  if (packagePaths['--electron-zip-directory']) {
    try {
      electronZipDir = await realpath(packagePaths['--electron-zip-directory']);
      if (typeof manifest.devDependencies.electron !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.+-]+)?$/.test(manifest.devDependencies.electron)) throw new Error();
    } catch { throw new Error('package_offline_archive_unavailable'); }
    await verifyElectronArchive({ directory: electronZipDir, version: manifest.devDependencies.electron, arch: process.arch });
  }
  staging = await mkdtemp(path.join(tmpdir(), 'notalone-package-'));
  const licensesDirectory = path.join(staging, 'licenses');
  await verifyFrontendNotices({ directory: path.resolve('dist/licenses/frontend') });
  await cp('dist/licenses/frontend', path.join(licensesDirectory, 'frontend'), { recursive: true });
  const probeDirectory = path.join(staging, 'notalone-probe');
  const preparedProbe = withProbe ? await prepareRepositoryProbe(probeDirectory, { signingIdentity }) : undefined;
  let preparedManaged;
  let managedDirectory = packagePaths['--runtime-directory'];
  if (managedDirectory) {
    if (path.basename(managedDirectory) !== runtimeDirectoryName) throw new Error('package_runtime_directory_name');
    preparedManaged = await inspectManagedRuntime(managedDirectory);
    const stagedManaged = path.join(staging, runtimeDirectoryName);
    // 仅对已核验的包内普通文件链接解引用，避免复制库改写为构建目录绝对链接。
    await cp(managedDirectory, stagedManaged, { recursive: true, dereference: true });
    await inspectManagedRuntime(stagedManaged); managedDirectory = stagedManaged;
  }
  const resources = [licensesDirectory, ...(preparedProbe ? [probeDirectory] : []), ...(preparedManaged ? [managedDirectory] : [])];
  const verifyResources = async (resources) => {
    await verifyFrontendNotices({ directory: path.join(resources, 'licenses/frontend') });
    await verifyElectronNotices({ directory: path.join(resources, 'licenses/electron'), version: manifest.devDependencies.electron });
    if (preparedManaged) {
      const copiedManaged = await inspectManagedRuntime(path.join(resources, runtimeDirectoryName));
      if (JSON.stringify(copiedManaged) !== JSON.stringify(preparedManaged)) throw new Error('package_runtime_changed');
    }
    if (!preparedProbe) return;
    const copied = await inspectRuntime({ directory: path.join(resources, runtimeLayout().directory),
      arch: preparedProbe.architecture, version: preparedProbe.versionDeclaration, runtimeKind: preparedProbe.runtimeKind });
    requireUnchangedFiles(preparedProbe.files, copied.files);
  };
  const source = path.join(staging, 'app');
  await mkdir(source);
  // 仅复制编译产物与最小启动清单，避免携入仓库、依赖缓存或用户配置。
  await cp('dist', path.join(source, 'dist'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({
    name: manifest.name, productName: 'NotAlone', version: manifest.version,
    description: manifest.description, main: manifest.main,
  }));

  const iconset = path.join(staging, 'NotAlone.iconset');
  await mkdir(iconset);
  // App 专用母版已包含圆角底板与透明留边；不可补成铺满画布的实色方块。
  const square = 'assets/app-icon.png';
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const file = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
      await run('sips', ['-z', pixels, pixels, square, '--out', path.join(iconset, file)]);
    }
  }
  const icon = path.join(staging, 'NotAlone.icns');
  await run('iconutil', ['--convert', 'icns', '--output', icon, iconset]);
  // 复用自有 plist，避免签名器为每个文件在 staging 外创建临时目录。
  const entitlements = path.join(staging, 'entitlements.plist');
  await writeFile(entitlements, `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.security.cs.allow-jit</key><true/>
</dict></plist>
`);
  const outputs = await packageWithSigning(packager, {
    dir: source,
    name: 'NotAlone',
    appBundleId: 'com.notalone.desktop',
    appCategoryType: 'public.app-category.productivity',
    platform: 'darwin',
    arch: process.arch,
    electronVersion: manifest.devDependencies.electron,
    electronZipDir,
    download: { cacheRoot: electronCache },
    out: outputDirectory || 'out',
    overwrite: !outputDirectory,
    tmpdir: path.join(staging, 'electron'),
    asar: true,
    icon,
    extraResource: resources.length ? resources : undefined,
    afterCopyExtraResources: [async ({ buildPath }) => {
      await verifyResources(path.join(buildPath, 'NotAlone.app/Contents/Resources'));
    }],
    afterExtract: [async ({ buildPath }) => {
      await prepareElectronNotices({ extractedDirectory: buildPath, outputDirectory: path.join(licensesDirectory, 'electron'), version: manifest.devDependencies.electron });
      const plist = path.join(buildPath, 'Electron.app/Contents/Info.plist');
      await run('plutil', ['-replace', 'LSMinimumSystemVersion', '-string', minimumMacOS, plist]);
      for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription',
        'NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription',
        'NSBluetoothPeripheralUsageDescription']) {
        await run('plutil', ['-remove', key, plist]);
      }
      await run('plutil', ['-replace', 'NSAppTransportSecurity.NSAllowsArbitraryLoads', '-bool', 'false', plist]);
    }],
    osxSign: {
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      // 自研探针保留已核查的签名，不注入 Electron 的 JIT entitlement。
      ignore: (file) => Boolean((preparedProbe && file.includes(`${path.sep}Contents${path.sep}Resources${path.sep}${runtimeLayout().directory}${path.sep}`)) ||
        (preparedManaged && file.includes(`${path.sep}Contents${path.sep}Resources${path.sep}${runtimeDirectoryName}${path.sep}`))),
      optionsForFile: () => ({
        entitlements,
        hardenedRuntime: false,
        timestamp: 'none',
      }),
    },
  }, signingIdentity);
  if (!outputs.length) throw new Error('package_output_unavailable');
  for (const output of outputs) {
    const app = path.join(output, 'NotAlone.app');
    const minimumSystem = await run('plutil', ['-extract', 'LSMinimumSystemVersion', 'raw', path.join(app, 'Contents/Info.plist')]);
    if (minimumSystem.stdout.trim() !== minimumMacOS) throw new Error('package_minimum_macos_changed');
    await verifyResources(path.join(app, 'Contents/Resources'));
    await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    const signingMode = await requireSigningMode(app, signingIdentity, run);
    console.log(`本机 App 已构建并通过${signingMode === 'ad-hoc' ? '本地 ad-hoc' : '显式证书'}签名校验：${app}`);
    console.log('实际权限身份延续与正式分发／公证状态仍须单独验证。');
    if (preparedManaged) console.log('包内提供受管Python、后台与PostgreSQL；首启与搬动可用性须另行实测。');
    else console.log('当前包使用外置后台运行环境。');
    console.log('微信工具与授权接入尚未通过独立交付验收。');
    if (preparedProbe) console.log('仓库探针/核心库静态构建与随包复核通过；未运行探针，不证明定位或权限验收。');
  }
  completed = true;
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
  if (ownedOutput && !completed) {
    const current = await lstat(outputDirectory).catch(() => undefined);
    if (current?.isDirectory() && current.dev === ownedOutput.dev && current.ino === ownedOutput.ino) await rm(outputDirectory, { recursive: true });
  }
}
