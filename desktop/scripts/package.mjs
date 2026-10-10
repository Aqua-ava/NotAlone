import { packager } from '@electron/packager';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareHelpers } from './prepare-helpers.mjs';
import { argumentsFor, inspectRuntime, requireUnchangedFiles } from './helper-runtime.mjs';

if (process.platform !== 'darwin') throw new Error('本机 App 打包需要 macOS。');
const run = promisify(execFile);
const helperArguments = process.argv.slice(2);
const helperInput = helperArguments.length ? argumentsFor(helperArguments.map((value, index) => {
  if (index % 2 === 0 && !['--helper-directory', '--helper-version', '--helper-source'].includes(value)) throw new Error('helper_check_arguments');
  return index % 2 === 0 ? value.replace('--helper-', '--') : value;
})) : undefined;
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const staging = await mkdtemp(path.join(tmpdir(), 'notalone-package-'));
try {
  const helperDirectory = path.join(staging, 'notalone-helpers');
  const prepared = helperInput ? await prepareHelpers({ ...helperInput, destination: helperDirectory }) : undefined;
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
  const outputs = await packager({
    dir: source,
    name: 'NotAlone',
    appBundleId: 'com.notalone.desktop',
    appCategoryType: 'public.app-category.productivity',
    platform: 'darwin',
    arch: process.arch,
    electronVersion: manifest.devDependencies.electron,
    out: 'out',
    overwrite: true,
    asar: true,
    icon,
    extraResource: prepared ? [helperDirectory] : undefined,
    afterCopyExtraResources: prepared ? [async ({ buildPath }) => {
      const copied = await inspectRuntime({ ...helperInput, directory: path.join(buildPath, 'NotAlone.app/Contents/Resources/notalone-helpers') });
      requireUnchangedFiles(prepared.files, copied.files);
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
      ignore: (file) => file.includes(`${path.sep}Contents${path.sep}Resources${path.sep}notalone-helpers${path.sep}`),
      optionsForFile: () => ({
        entitlements: ['com.apple.security.cs.allow-jit'],
        hardenedRuntime: false,
        timestamp: 'none',
      }),
    },
  });
  for (const output of outputs) {
    const app = path.join(output, 'NotAlone.app');
    if (prepared) {
      const bundled = await inspectRuntime({ ...helperInput, directory: path.join(app, 'Contents/Resources/notalone-helpers') });
      requireUnchangedFiles(prepared.files, bundled.files);
    }
    await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    console.log(`本机 App 已构建并通过 ad-hoc 签名校验：${app}`);
    console.log(prepared ? 'CLI/WCDB 静态核查与随包字节复核通过；来源、运行和原生验收仍未验证。' : '此包未包含 CLI/WCDB，完整 helper 交付仍待补齐。');
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
