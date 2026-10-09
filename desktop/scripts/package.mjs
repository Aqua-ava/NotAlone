import { packager } from '@electron/packager';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

if (process.platform !== 'darwin') throw new Error('本机 App 打包需要 macOS。');
const run = promisify(execFile);
const manifest = JSON.parse(await readFile('package.json', 'utf8'));
const staging = await mkdtemp(path.join(tmpdir(), 'notalone-package-'));
try {
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
      optionsForFile: () => ({
        entitlements: ['com.apple.security.cs.allow-jit'],
        hardenedRuntime: false,
        timestamp: 'none',
      }),
    },
  });
  for (const output of outputs) {
    const app = path.join(output, 'NotAlone.app');
    await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app]);
    console.log(`本机 App 已构建并通过 ad-hoc 签名校验：${app}`);
  }
} finally {
  await rm(staging, { recursive: true, force: true });
}
