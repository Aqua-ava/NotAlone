import { packager } from '@electron/packager';
import { cp, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareHelpers } from './prepare-helpers.mjs';
import { prepareRepositoryProbe } from './prepare-probe.mjs';
import { prepareThirdPartyNotices, verifyThirdPartyNotices } from './third-party-notices.mjs';
import { argumentsFor, inspectRuntime, requireUnchangedFiles, runtimeLayout } from './helper-runtime.mjs';

if (process.platform !== 'darwin') throw new Error('本机 App 打包需要 macOS。');
const run = promisify(execFile);
const helperArguments = process.argv.slice(2);
let withProbe = false;
const packagePaths = {}; const cliArguments = [];
for (let index = 0; index < helperArguments.length; index++) {
  const key = helperArguments[index];
  if (key === '--with-probe') {
    if (withProbe) throw new Error('helper_check_arguments');
    withProbe = true; continue;
  }
  const value = helperArguments[++index];
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) throw new Error('helper_check_arguments');
  if (key === '--output-directory' || key === '--electron-zip-directory') {
    if (key in packagePaths || !path.isAbsolute(value)) throw new Error('helper_check_arguments');
    packagePaths[key] = path.resolve(value);
  } else { cliArguments.push(key, value); }
}
const helperInput = cliArguments.length ? argumentsFor(cliArguments.map((value, index) => {
  if (index % 2 === 0 && !['--helper-directory', '--helper-version', '--helper-source'].includes(value)) throw new Error('helper_check_arguments');
  return index % 2 === 0 ? value.replace('--helper-', '--') : value;
})) : undefined;
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
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
      const archive = await lstat(path.join(electronZipDir, `electron-v${manifest.devDependencies.electron}-darwin-${process.arch}.zip`));
      if (!archive.isFile() || archive.isSymbolicLink()) throw new Error();
    } catch { throw new Error('package_offline_archive_unavailable'); }
  }
  staging = await mkdtemp(path.join(tmpdir(), 'notalone-package-'));
  const helperDirectory = path.join(staging, 'notalone-helpers');
  const prepared = helperInput ? await prepareHelpers({ ...helperInput, destination: helperDirectory }) : undefined;
  const probeDirectory = path.join(staging, 'notalone-probe');
  const preparedProbe = withProbe ? await prepareRepositoryProbe(probeDirectory) : undefined;
  const groups = [prepared, preparedProbe].filter(Boolean);
  const noticesDirectory = path.join(staging, 'notalone-third-party');
  const preparedNotices = prepared ? await prepareThirdPartyNotices({
    librarySha256: prepared.files.find((file) => file.name === 'libWCDB.dylib')?.sha256,
    cliSha256: prepared.files.find((file) => file.name === 'wechat-cli')?.sha256,
  }, noticesDirectory) : undefined;
  const resources = groups.map((group) => path.join(staging, runtimeLayout(group.runtimeKind).directory));
  if (preparedNotices) resources.push(noticesDirectory);
  const verifyResources = async (resources) => {
    for (const group of groups) {
      const copied = await inspectRuntime({ directory: path.join(resources, runtimeLayout(group.runtimeKind).directory),
        arch: group.architecture, version: group.versionDeclaration, runtimeKind: group.runtimeKind });
      requireUnchangedFiles(group.files, copied.files);
    }
    if (preparedNotices) await verifyThirdPartyNotices(preparedNotices, path.join(resources, 'notalone-third-party'));
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
  const square = path.join(staging, 'square.png');
  await run('sips', ['-Z', '1024', 'src/renderer/assets/logo.png', '--out', square]);
  await run('sips', ['--padToHeightWidth', '1024', '1024', '--padColor', 'F3EEE3', square]);
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
  const outputs = await packager({
    dir: source,
    name: 'NotAlone',
    appBundleId: 'com.notalone.desktop',
    appCategoryType: 'public.app-category.productivity',
    platform: 'darwin',
    arch: process.arch,
    electronVersion: manifest.devDependencies.electron,
    electronZipDir,
    out: outputDirectory || 'out',
    overwrite: !outputDirectory,
    tmpdir: path.join(staging, 'electron'),
    asar: true,
    icon,
    extraResource: resources.length ? resources : undefined,
    afterCopyExtraResources: resources.length ? [async ({ buildPath }) => {
      await verifyResources(path.join(buildPath, 'NotAlone.app/Contents/Resources'));
    }] : undefined,
    afterExtract: [async ({ buildPath }) => {
      const plist = path.join(buildPath, 'Electron.app/Contents/Info.plist');
      for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription',
        'NSAudioCaptureUsageDescription', 'NSBluetoothAlwaysUsageDescription',
        'NSBluetoothPeripheralUsageDescription']) {
        await run('plutil', ['-remove', key, plist]);
      }
      await run('plutil', ['-replace', 'NSAppTransportSecurity.NSAllowsArbitraryLoads', '-bool', 'false', plist]);
    }],
    osxSign: {
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      // helper 已带核查过的签名，保留字节与权限，不注入 Electron 的 JIT entitlement。
      ignore: (file) => groups.some((group) => file.includes(`${path.sep}Contents${path.sep}Resources${path.sep}${runtimeLayout(group.runtimeKind).directory}${path.sep}`)),
      optionsForFile: () => ({
        entitlements,
        hardenedRuntime: false,
        timestamp: 'none',
      }),
    },
  });
  if (!outputs.length) throw new Error('package_output_unavailable');
  for (const output of outputs) {
    const app = path.join(output, 'NotAlone.app');
    await verifyResources(path.join(app, 'Contents/Resources'));
    await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    console.log(`本机 App 已构建并通过 ad-hoc 签名校验：${app}`);
    console.log(prepared ? 'CLI/WCDB 静态核查与随包字节复核通过；来源、运行和原生验收仍未验证。' : '此包未包含 CLI/WCDB，完整 helper 交付仍待补齐。');
    if (preparedProbe) console.log('仓库探针/核心库静态构建与随包复核通过；未运行探针，不证明定位或权限验收。');
    if (preparedNotices) console.log('许可原文及来源索引已随包复核；精确构建来源和二进制许可覆盖仍未确认。');
  }
  completed = true;
} finally {
  if (staging) await rm(staging, { recursive: true, force: true });
  if (ownedOutput && !completed) {
    const current = await lstat(outputDirectory).catch(() => undefined);
    if (current?.isDirectory() && current.dev === ownedOutput.dev && current.ino === ownedOutput.ino) await rm(outputDirectory, { recursive: true });
  }
}
